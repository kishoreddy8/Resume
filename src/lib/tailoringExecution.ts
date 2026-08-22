import fs from "node:fs";
import path from "node:path";
import { getCandidateJobState } from "@/db/queries/candidateJobState";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import { getLatestJobMatchResult } from "@/db/queries/jobMatches";
import { completeTailoringRun, createTailoringRun, failTailoringRun, type TailoringRunRow } from "@/db/queries/tailoringRuns";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { resolveTailoringArtifactPaths } from "@/lib/tailoringArtifacts";
import type { JobWithCompany, TailoringApprovalType } from "@/types";
// tools/ is a neutral, non-src/ directory by design (Phase 3 Stage 1) specifically so both this app
// and the Claude Code/Codex skill runners can import the same deterministic engine — this is the
// first real src/ -> tools/ import, not a layering violation.
import { generateTailoringOutputs } from "../../tools/tailoring-engine/generate";
import { RENDERER_VERSION } from "../../tools/tailoring-engine/constants";
import type { CoverLetterContent, ResumeContent } from "../../tools/tailoring-engine/types";

/**
 * Phase 3 Stage 5 — wires Stage 3's tailoring-run persistence and Stage 4's candidate/job/run-scoped
 * artifact storage into actual deterministic execution. No LLM calls happen anywhere in this file —
 * the caller supplies already-tailored `resume`/`coverLetter` content (produced by Claude Code/Codex
 * outside this app, per the Phase 3 V1 architecture); this module only authorizes, persists, renders
 * deterministically, and finalizes the run record.
 */

// Certification-badge source clarification: resolves this candidate's own Master Resume .docx path
// exactly as /api/master-files/route.ts stores it, so generateResumeDocx can preserve its embedded
// certification badge images (see sourceBadgeAssets.ts). Deliberately re-derived locally rather than
// imported — this mirrors the same "small local re-derivation over cross-module coupling" pattern
// this exact path convention already uses in src/lib/match/candidateProfile.ts and
// src/lib/resumeQuality/workspacePackage.ts. Returns undefined (never throws) when the candidate has
// no Master Resume yet, or its master resume is a .md/.txt upload rather than a .docx — both cases
// fall back to the generic text-card badge presentation exactly as before this feature existed.
function candidatesRoot(): string {
  return process.env.CAREER_OPS_CANDIDATES_DIR ?? path.join(process.cwd(), "data", "candidates");
}
function resolveMasterResumeDocxPath(candidateId: number): string | undefined {
  const candidate = path.join(candidatesRoot(), String(candidateId), "master", "resume.docx");
  return fs.existsSync(candidate) ? candidate : undefined;
}

// READY_DIRECT may only ever pair with a READY_FOR_TAILORING approval, NEEDS_REVIEW_OVERRIDE only
// with NEEDS_REVIEW — mirrors POST /api/candidates/[candidateId]/jobs/[jobId]/tailoring-runs's exact
// approval model (Stage 3).
const APPROVAL_TYPE_REQUIRES_DECISION: Record<TailoringApprovalType, string> = {
  READY_DIRECT: "READY_FOR_TAILORING",
  NEEDS_REVIEW_OVERRIDE: "NEEDS_REVIEW",
};

export type TailoringRunAuthorizationErrorCode =
  | "INVALID_CANDIDATE_ID"
  | "NOT_ACTIVE_CANDIDATE"
  | "INVALID_JOB_ID"
  | "JOB_NOT_FOUND"
  | "NOT_MARKED_FOR_TAILORING"
  | "MISSING_APPROVAL_CONTEXT"
  | "APPROVAL_TYPE_MISMATCH"
  | "MISSING_APPROVED_AT"
  | "NO_CURRENT_MATCH_RESULT"
  | "STALE_APPROVAL"
  | "PROFILE_UNAVAILABLE";

/** Thrown by startTailoringRun before any tailoring_runs row is created — none of these codes ever
 *  leave a run stuck in 'started', because no run exists yet when they're thrown. */
export class TailoringRunAuthorizationError extends Error {
  constructor(
    public readonly code: TailoringRunAuthorizationErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "TailoringRunAuthorizationError";
  }
}

export interface StartTailoringRunInput {
  candidateId: number;
  jobId: number;
  selectedTrack?: string;
  executedBy?: "claude-code" | "codex";
  methodologyVersion?: number;
}

export interface StartedTailoringRun {
  run: TailoringRunRow;
  job: JobWithCompany;
}

/**
 * Authorizes and creates a 'started' tailoring_runs row. Intentionally mirrors
 * POST /api/candidates/[candidateId]/jobs/[jobId]/tailoring-runs's exact validation sequence (Stage
 * 3) — same checks, same order, same underlying query-layer primitives — so this library entry point
 * and that HTTP route stay behaviorally identical. Implemented as a parallel sequence rather than by
 * importing the route file (its helpers aren't exported, and Stage 3 is frozen for this stage) —
 * consolidating the two into one shared implementation is a reasonable future cleanup, not done here
 * to avoid touching already-reviewed Stage 3 code.
 */
export function startTailoringRun(input: StartTailoringRunInput): StartedTailoringRun {
  if (!Number.isInteger(input.candidateId) || input.candidateId <= 0) {
    throw new TailoringRunAuthorizationError("INVALID_CANDIDATE_ID", `Invalid candidateId: ${input.candidateId}`);
  }
  if (!requireActiveCandidate(input.candidateId)) {
    throw new TailoringRunAuthorizationError("NOT_ACTIVE_CANDIDATE", `Candidate ${input.candidateId} is not an active candidate`);
  }
  if (!Number.isInteger(input.jobId) || input.jobId <= 0) {
    throw new TailoringRunAuthorizationError("INVALID_JOB_ID", `Invalid jobId: ${input.jobId}`);
  }
  const job = getJob(input.jobId);
  if (!job) {
    throw new TailoringRunAuthorizationError("JOB_NOT_FOUND", `Job ${input.jobId} not found`);
  }
  // job.dedupe_key is NOT NULL in schema.sql — every real job row has one; there is no reachable
  // "missing dedupe_key" state to guard against here.
  const dedupeKey = job.dedupe_key;

  const state = getCandidateJobState(input.candidateId, dedupeKey);
  if (!state || !state.marked_for_tailoring) {
    throw new TailoringRunAuthorizationError("NOT_MARKED_FOR_TAILORING", "Job is not marked for tailoring for this candidate");
  }

  const approvalType = state.tailoring_approval_type;
  const decisionAtApproval = state.tailoring_approved_decision;
  if (!approvalType || !decisionAtApproval) {
    throw new TailoringRunAuthorizationError(
      "MISSING_APPROVAL_CONTEXT",
      "Job is marked for tailoring but has no recorded approval context"
    );
  }
  if (APPROVAL_TYPE_REQUIRES_DECISION[approvalType] !== decisionAtApproval) {
    throw new TailoringRunAuthorizationError(
      "APPROVAL_TYPE_MISMATCH",
      `Approval type ${approvalType} is not compatible with approved decision ${decisionAtApproval}`
    );
  }
  if (!state.tailoring_marked_at) {
    throw new TailoringRunAuthorizationError("MISSING_APPROVED_AT", "Marked for tailoring but missing tailoring_marked_at");
  }

  const currentMatch = getLatestJobMatchResult(input.candidateId, dedupeKey);
  if (!currentMatch) {
    throw new TailoringRunAuthorizationError(
      "NO_CURRENT_MATCH_RESULT",
      "No current Phase 2 match result exists for this candidate/job"
    );
  }
  // A frozen snapshot of the decision at approval time — if Phase 2 has since re-evaluated to a
  // different decision, that snapshot is stale and must not authorize a run (same rule as Stage 3).
  if (currentMatch.decision !== decisionAtApproval) {
    throw new TailoringRunAuthorizationError(
      "STALE_APPROVAL",
      "Approval is stale: the current Phase 2 decision has changed since this job was approved for tailoring.",
      { approvedDecision: decisionAtApproval, currentDecision: currentMatch.decision }
    );
  }

  const profileResult = loadCandidateProfile(input.candidateId);
  if (profileResult.status !== "ok") {
    throw new TailoringRunAuthorizationError(
      "PROFILE_UNAVAILABLE",
      `Candidate profile is not usable (status: ${profileResult.status}) — cannot resolve master resume/skills hashes`
    );
  }

  const run = createTailoringRun({
    candidateId: input.candidateId,
    dedupeKey,
    jobId: job.id,
    approvalType,
    decisionAtApproval,
    approvedAt: state.tailoring_marked_at,
    masterResumeHash: profileResult.profile.sourceHashes.resume,
    masterSkillsHash: profileResult.profile.sourceHashes.skills,
    candidateProfileHash: currentMatch.candidate_profile_hash,
    jdContentHash: currentMatch.jd_content_hash,
    matchEngineVersion: currentMatch.match_engine_version,
    recommendedTrack: currentMatch.recommended_track,
    selectedTrack: input.selectedTrack,
    methodologyVersion: input.methodologyVersion,
    rendererVersion: RENDERER_VERSION,
    executedBy: input.executedBy,
  });

  return { run, job };
}

export interface ExecuteTailoringRunInput {
  candidateId: number;
  jobId: number;
  resume: ResumeContent;
  coverLetter: CoverLetterContent;
  selectedTrack?: string;
  executedBy?: "claude-code" | "codex";
  methodologyVersion?: number;
}

export interface ExecuteTailoringRunResult {
  run: TailoringRunRow;
  resumePath: string;
  coverLetterPath: string;
}

/**
 * Full Stage 5 orchestration: authorize + create the run (startTailoringRun), resolve its
 * candidate/job/run-scoped artifact directory (Stage 4's resolveTailoringArtifactPaths), render
 * deterministically (the existing tailoring-engine generator — no LLM calls happen here or anywhere
 * in this function), and mark the run completed or failed.
 *
 * A tailoring_runs row is only ever created once authorization succeeds. Once created, any failure
 * from that point on (artifact path resolution, rendering, layout validation) marks that SAME run
 * failed rather than leaving it stuck in 'started' — never silently abandoned. Each run writes only
 * into its own run-scoped directory, so a failed run can never corrupt or overwrite an earlier
 * successful run's artifacts.
 */
export async function executeTailoringRun(input: ExecuteTailoringRunInput): Promise<ExecuteTailoringRunResult> {
  const { run, job } = startTailoringRun({
    candidateId: input.candidateId,
    jobId: input.jobId,
    selectedTrack: input.selectedTrack,
    executedBy: input.executedBy,
    methodologyVersion: input.methodologyVersion,
  });

  try {
    const paths = resolveTailoringArtifactPaths({
      candidateId: input.candidateId,
      dedupeKey: run.dedupe_key,
      runId: run.id,
    });

    const generated = await generateTailoringOutputs(
      {
        company: job.company_name,
        jobId: input.jobId,
        resume: input.resume,
        coverLetter: input.coverLetter,
        masterResumeDocxPath: resolveMasterResumeDocxPath(input.candidateId),
      },
      { outputDir: paths.dir }
    );

    // path.basename strips any directory component regardless of what the generator returns —
    // output_files must never contain anything but safe relative filenames (Stage 3's contract).
    const completed = completeTailoringRun(input.candidateId, run.id, {
      outputFiles: [path.basename(generated.resumePath), path.basename(generated.coverLetterPath)],
      validationPassed: true,
      selectedTrack: input.selectedTrack,
      executedBy: input.executedBy,
    });

    return { run: completed, resumePath: generated.resumePath, coverLetterPath: generated.coverLetterPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failTailoringRun(input.candidateId, run.id, message);
    throw err;
  }
}
