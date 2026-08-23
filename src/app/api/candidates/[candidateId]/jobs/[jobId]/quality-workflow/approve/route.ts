import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate, getCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import { getCompany } from "@/db/queries/companies";
import { getLatestResumeQualityWorkflowForJob, listResumeQualityIterations } from "@/db/queries/resumeQualityWorkflows";
import {
  getHumanApprovalForWorkflow,
  saveHumanApproval,
  type ResumeQualityHumanApprovalRow,
} from "@/db/queries/resumeQualityHumanApprovals";
import type { ResumeQualityAttemptSummary } from "@/lib/resumeQuality/bestAttemptSelection";
import { determineFinalDisposition } from "@/lib/resumeQuality/finalDisposition";
import {
  publishSafeBestAttempt,
  resolveSafeAttemptTarget,
  SafeAttemptPublicationError,
  type SafeAttemptManifest,
} from "@/lib/resumeQuality/safeAttemptPublication";
import { getIterationDirectory, type QualityWorkflowLocation } from "@/lib/resumeQuality/workspace";
import type { StructuredResumeReview } from "@/lib/resumeQuality/types";

/**
 * POST — the candidate's explicit, auditable approval of a SAFE_BEST_ATTEMPT resume.
 *
 * THE BOUNDARY THIS ENFORCES. determineFinalDisposition() (finalDisposition.ts) is the ONE canonical
 * safety authority, reused verbatim here — this route never re-implements or relaxes any of its
 * conditions. Approval is possible ONLY when that authority currently says SAFE_BEST_ATTEMPT for the
 * CURRENT latest workflow of this job, recomputed fresh from the iteration history on every call. A
 * client can send a workflowId to detect staleness, but nothing it sends is ever trusted as
 * authorization — every score and safety verdict here is read straight from persisted review_json.
 *
 * WHAT THIS NEVER DOES. It never sets workflow.status to READY, never mutates
 * resume_quality_workflows at all, and never approves a BLOCKED or in-progress workflow. Approval is
 * a separate, append-only provenance row (resume_quality_human_approvals), tied to the exact
 * workflow_id and selected iteration — a later re-tailored workflow for the same job gets a new id and
 * starts unapproved.
 */

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function presentApproval(row: ResumeQualityHumanApprovalRow) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    selectedIterationNumber: row.selected_iteration_number,
    overallScore: row.overall_score,
    atsScore: row.ats_score,
    truthfulnessScore: row.truthfulness_score,
    architectureConsistencyScore: row.architecture_consistency_score,
    approvedAt: row.approved_at,
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ candidateId: string; jobId: string }> }
): Promise<NextResponse> {
  const { candidateId: candidateIdParam, jobId: jobIdParam } = await params;

  const candidateId = parsePositiveInt(candidateIdParam);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const jobId = parsePositiveInt(jobIdParam);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const candidate = getCandidate(candidateId);
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const workflow = getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key);
  if (!workflow) {
    return NextResponse.json({ error: "No quality workflow exists for this job.", code: "NO_WORKFLOW" }, { status: 404 });
  }

  // The body carries an identifier only, used to detect a stale page (a new workflow was created
  // since the candidate loaded this screen) — never treated as authorization for anything.
  const body = (await req.json().catch(() => ({}))) as { workflowId?: unknown; notes?: unknown };
  if (typeof body.workflowId === "number" && body.workflowId !== workflow.id) {
    return NextResponse.json(
      { error: "This resume has changed since you loaded this page. Refresh and try again.", code: "STALE_WORKFLOW" },
      { status: 409 }
    );
  }

  if (workflow.status === "READY") {
    return NextResponse.json(
      { error: "This resume already passed the autonomous quality gate and needs no approval.", code: "ALREADY_READY" },
      { status: 409 }
    );
  }
  if (workflow.status !== "FAILED") {
    return NextResponse.json(
      { error: "This resume is still being generated and cannot be approved yet.", code: "NOT_TERMINAL" },
      { status: 409 }
    );
  }

  // Idempotent: a repeated click reads the existing approval rather than re-deriving or duplicating it.
  const existingApproval = getHumanApprovalForWorkflow(candidateId, workflow.id);
  if (existingApproval) {
    return NextResponse.json({ ok: true, alreadyApproved: true, approval: presentApproval(existingApproval) });
  }

  const iterationRows = listResumeQualityIterations(candidateId, workflow.id);
  const attempts: ResumeQualityAttemptSummary[] = [];
  for (const row of iterationRows) {
    if (!row.review_json) continue;
    try {
      attempts.push({ iterationNumber: row.iteration_number, review: JSON.parse(row.review_json) as StructuredResumeReview });
    } catch {
      // Skip an unparseable legacy row rather than let it crash the disposition computation.
    }
  }

  // THE canonical authority — recomputed fresh, never cached, never re-implemented.
  const disposition = determineFinalDisposition(attempts);

  if (disposition.disposition === "BLOCKED") {
    return NextResponse.json(
      { error: "This resume cannot be approved: it did not clear the safety checks.", code: "BLOCKED", blockers: disposition.safety.blockers },
      { status: 403 }
    );
  }
  if (disposition.disposition === "READY" || disposition.selectedIterationNumber === null) {
    return NextResponse.json(
      { error: "This resume already meets the autonomous quality bar and needs no approval.", code: "ALREADY_READY" },
      { status: 409 }
    );
  }

  const chosenReview = attempts.find((a) => a.iterationNumber === disposition.selectedIterationNumber)!.review;
  const location: QualityWorkflowLocation = {
    candidateId,
    dedupeKey: workflow.dedupe_key,
    runId: workflow.tailoring_run_id,
    workflowId: workflow.id,
  };

  const company = getCompany(job.company_id);
  if (!company) {
    return NextResponse.json({ error: "Company record missing for this job.", code: "NO_COMPANY" }, { status: 409 });
  }

  // Publication normally already happened (best-effort) the moment the workflow reached FAILED —
  // see orchestrator.ts's own call to publishSafeBestAttempt. Verify it here, and re-publish
  // defensively if it is missing or names a different workflow/iteration than the one being approved.
  const target = resolveSafeAttemptTarget({ companyId: company.id, companyName: company.name, jobId: job.id, jobTitle: job.title });
  const manifestPath = path.join(target.safeAttemptDirectory, "manifest.json");
  let manifest = readJsonFile<SafeAttemptManifest>(manifestPath);

  if (!manifest || manifest.workflowId !== workflow.id || manifest.selectedIterationNumber !== disposition.selectedIterationNumber) {
    const selectedDir = getIterationDirectory(location, disposition.selectedIterationNumber);
    try {
      const published = publishSafeBestAttempt({
        disposition,
        candidateId,
        candidateName: candidate.display_name,
        candidateFirstName: candidate.first_name || "Candidate",
        companyId: company.id,
        companyName: company.name,
        jobId: job.id,
        jobTitle: job.title,
        workflowId: workflow.id,
        tailoringRunId: workflow.tailoring_run_id,
        sourceResumePath: path.join(selectedDir, "Resume.docx"),
        sourceCoverLetterPath: path.join(selectedDir, "CoverLetter.docx"),
        sourceReviewFeedbackPath: path.join(selectedDir, "review_feedback.md"),
      });
      manifest = published.manifest;
    } catch (err) {
      const code = err instanceof SafeAttemptPublicationError ? err.code : "PUBLICATION_FAILED";
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to publish the approved attempt.", code },
        { status: 409 }
      );
    }
  }

  // Approval must never be recorded for artifacts that turn out not to actually be on disk.
  if (!fs.existsSync(path.join(target.safeAttemptDirectory, manifest.files.resume))) {
    return NextResponse.json({ error: "The resume document could not be found after publication.", code: "MISSING_RESUME" }, { status: 409 });
  }

  const compliance = chosenReview.instructionCompliance;
  const saved = saveHumanApproval({
    candidateId,
    workflowId: workflow.id,
    tailoringRunId: workflow.tailoring_run_id,
    jobId: job.id,
    dedupeKey: workflow.dedupe_key,
    selectedIterationNumber: disposition.selectedIterationNumber,
    overallScore: chosenReview.overallScore,
    atsScore: chosenReview.atsScore,
    truthfulnessScore: chosenReview.truthfulnessScore,
    architectureConsistencyScore: chosenReview.architectureConsistencyScore,
    instructionVersion: compliance?.instructionVersion ?? null,
    instructionHash: compliance?.instructionHash ?? null,
    safetyVerdict: disposition.safety,
    notes: typeof body.notes === "string" ? body.notes.slice(0, 2000) : null,
  });

  return NextResponse.json({ ok: true, alreadyApproved: false, approval: presentApproval(saved), disposition: disposition.disposition });
}
