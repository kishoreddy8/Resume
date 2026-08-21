import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import { getLatestResumeQualityWorkflowForJob } from "@/db/queries/resumeQualityWorkflows";
import { revalidateLatestReview } from "@/lib/resumeQuality/revalidation";

/**
 * POST — re-run today's validation checks over an already-written resume.
 *
 * WHY IT EXISTS. Reviews written before the typed safety analyses existed are permanently blocked,
 * because absence of an analysis is treated as failure everywhere it is read. That is correct, and
 * it left those packages with no way forward. This is the way forward.
 *
 * WHAT IT DOES NOT DO. It runs no writer, calls no model, computes no gate, sets no readiness and
 * touches no application state. It asks the deterministic reviewer to look at the resume that is
 * already on disk and records the answer as a new iteration. Whether the package becomes sendable
 * is then decided by the same gate and readiness functions that judge every other review — a
 * re-run that fails leaves it exactly as blocked, with the new reason.
 *
 * The refusals all come from the library, which owns the conditions; this route adds only ownership
 * and shape checks. It deliberately re-implements none of the gate logic.
 */
function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Refusals a caller can act on, versus ones that are genuinely a conflict. */
const STATUS_FOR: Record<string, number> = {
  NO_WORKFLOW: 404,
  NO_REVIEW: 404,
  NO_RESUME_ARTIFACT: 409,
  NOT_LEGACY: 409,
  BUDGET_EXHAUSTED: 409,
  IN_PROGRESS: 409,
};

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

  /* Candidate-scoped, so one candidate can never re-review another's workflow even with a
   * dedupe_key they both happen to have. */
  const workflow = getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key);
  if (!workflow) {
    return NextResponse.json(
      { error: "No quality workflow exists for this job.", code: "NO_WORKFLOW" },
      { status: 404 }
    );
  }

  const result = revalidateLatestReview(candidateId, workflow.id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.refusal },
      { status: STATUS_FOR[result.refusal] ?? 409 }
    );
  }

  /* The new review only. The caller re-reads the workflow to get the recomputed gate and readiness,
   * so this response can never become a second opinion about whether the package may be sent. */
  return NextResponse.json({ ok: true, workflowId: workflow.id, iterationNumber: result.iterationNumber });
}
