import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { z } from "zod";
import { getCandidateJobState } from "@/db/queries/candidateJobState";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import { getLatestJobMatchResult } from "@/db/queries/jobMatches";
import { createTailoringRun, listTailoringRuns } from "@/db/queries/tailoringRuns";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import type { JobWithCompany, TailoringApprovalType } from "@/types";

/**
 * Candidate-scoped, job-scoped tailoring run history + run creation. Phase 3 V1: this route never
 * calls an LLM and never writes to job_match_results — it only records the application's own
 * bookkeeping around a tailoring attempt that Claude Code/Codex performs entirely outside this app
 * (see .claude/skills/tailor-resume/SKILL.md / .agents/skills/tailor-resume/SKILL.md).
 *
 * IDENTITY: candidate_id + dedupe_key (resolved from the jobId path segment via getJob) is
 * authoritative for every query here — job_id is passed through only as convenience/debug metadata
 * on tailoring_runs (see schema.sql's own comment), never used to scope a lookup.
 */

// READY_DIRECT may only ever pair with a READY_FOR_TAILORING approval, NEEDS_REVIEW_OVERRIDE only
// with NEEDS_REVIEW — BLOCKED has no approval path in V1 (see the Phase 3 V1 approval model).
const APPROVAL_TYPE_REQUIRES_DECISION: Record<TailoringApprovalType, string> = {
  READY_DIRECT: "READY_FOR_TAILORING",
  NEEDS_REVIEW_OVERRIDE: "NEEDS_REVIEW",
};

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Request body may only supply values that are genuinely the executor's own choice at start time —
// every other field (identity, approval provenance, source hashes, match-result-derived values) is
// resolved server-side from repository truth below, never trusted from the client. Unknown keys
// (including a client-sent candidateId/dedupeKey/hashes) are silently stripped by zod's default
// non-strict parsing, which is exactly what "path wins over body" requires — not a hard 400.
const START_RUN_SCHEMA = z.object({
  selectedTrack: z.string().min(1).optional(),
  executedBy: z.enum(["claude-code", "codex"]).optional(),
  methodologyVersion: z.number().int().positive().optional(),
  rendererVersion: z.number().int().positive().optional(),
});

type CandidateJobResolution = { error: NextResponse } | { candidateId: number; job: JobWithCompany };

async function resolveCandidateAndJob(req: NextRequest, candidateIdParam: string, jobIdParam: string): Promise<CandidateJobResolution> {
  const candidateId = parsePositiveInt(candidateIdParam);
  // Guarded in the shared resolver so GET and POST cannot diverge.
  if (candidateId !== null) {
    const accessDenial = requireCandidateAccess(req, candidateId);
    if (accessDenial) return { error: accessDenial };
  }
  if (candidateId === null) {
    return { error: NextResponse.json({ error: "Invalid candidate id" }, { status: 400 }) };
  }
  if (!requireActiveCandidate(candidateId)) {
    return { error: NextResponse.json({ error: "Not an active candidate" }, { status: 404 }) };
  }

  const jobId = parsePositiveInt(jobIdParam);
  if (jobId === null) {
    return { error: NextResponse.json({ error: "Invalid job id" }, { status: 400 }) };
  }
  const job = getJob(jobId);
  if (!job) {
    return { error: NextResponse.json({ error: "Job not found" }, { status: 404 }) };
  }

  return { candidateId, job };
}

/** This candidate's tailoring run history for this job only, newest first — never another
 *  candidate's runs, regardless of dedupe_key overlap. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ candidateId: string; jobId: string }> }): Promise<NextResponse> {
  const { candidateId: candidateIdParam, jobId: jobIdParam } = await params;
  const resolved = await resolveCandidateAndJob(req, candidateIdParam, jobIdParam);
  if ("error" in resolved) return resolved.error;

  const runs = listTailoringRuns(resolved.candidateId, resolved.job.dedupe_key);
  return NextResponse.json({ runs });
}

/**
 * Starts a new tailoring run ('started' status). Never invents approval provenance: the candidate
 * must already be marked for tailoring with real approval context recorded by the PATCH
 * /api/jobs/[id] route (see candidate_job_state.tailoring_approval_type/tailoring_approved_decision),
 * and that approval must still match the CURRENT Phase 2 decision — if Phase 2 has been re-evaluated
 * since approval, the old approval no longer authorizes a run and re-approval is required.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ candidateId: string; jobId: string }> }): Promise<NextResponse> {
  const { candidateId: candidateIdParam, jobId: jobIdParam } = await params;
  const resolved = await resolveCandidateAndJob(req, candidateIdParam, jobIdParam);
  if ("error" in resolved) return resolved.error;
  const { candidateId, job } = resolved;
  const dedupeKey = job.dedupe_key;

  const body = await req.json().catch(() => ({}));
  const parsed = START_RUN_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const state = getCandidateJobState(candidateId, dedupeKey);
  if (!state || !state.marked_for_tailoring) {
    return NextResponse.json({ error: "Job is not marked for tailoring for this candidate" }, { status: 409 });
  }

  const approvalType = state.tailoring_approval_type;
  const decisionAtApproval = state.tailoring_approved_decision;
  if (!approvalType || !decisionAtApproval) {
    return NextResponse.json({ error: "Job is marked for tailoring but has no recorded approval context" }, { status: 409 });
  }
  if (APPROVAL_TYPE_REQUIRES_DECISION[approvalType] !== decisionAtApproval) {
    return NextResponse.json(
      { error: `Approval type ${approvalType} is not compatible with approved decision ${decisionAtApproval}` },
      { status: 409 }
    );
  }
  if (!state.tailoring_marked_at) {
    return NextResponse.json({ error: "Marked for tailoring but missing tailoring_marked_at" }, { status: 409 });
  }

  const currentMatch = getLatestJobMatchResult(candidateId, dedupeKey);
  if (!currentMatch) {
    return NextResponse.json({ error: "No current Phase 2 match result exists for this candidate/job" }, { status: 409 });
  }
  // The approval is a frozen snapshot of the decision at the moment it was granted — if Phase 2 has
  // since re-evaluated to a different decision, that snapshot is stale and must not authorize a run.
  if (currentMatch.decision !== decisionAtApproval) {
    return NextResponse.json(
      {
        error:
          "Approval is stale: the current Phase 2 decision has changed since this job was approved for tailoring. Re-approval is required.",
        approvedDecision: decisionAtApproval,
        currentDecision: currentMatch.decision,
      },
      { status: 409 }
    );
  }

  const profileResult = loadCandidateProfile(candidateId);
  if (profileResult.status !== "ok") {
    return NextResponse.json(
      { error: `Candidate profile is not usable (status: ${profileResult.status}) — cannot resolve master resume/skills hashes` },
      { status: 409 }
    );
  }

  const run = createTailoringRun({
    candidateId,
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
    selectedTrack: parsed.data.selectedTrack,
    methodologyVersion: parsed.data.methodologyVersion,
    rendererVersion: parsed.data.rendererVersion,
    executedBy: parsed.data.executedBy,
  });

  return NextResponse.json({ run }, { status: 201 });
}
