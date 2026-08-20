import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import { getLatestResumeQualityWorkflowForJob } from "@/db/queries/resumeQualityWorkflows";
import { resetWriterTechnicalFailures } from "@/lib/resumeQuality/writers/writerWorkerCore";

/**
 * Stage 27 — the operator's explicit "Retry writer" action.
 *
 * Exists because the bounded technical-retry budget (handoffClaim.MAX_TECHNICAL_PASSES) had no reset
 * path at all: once a handoff had failed five times for technical reasons — which a single Claude
 * subscription window or a long provider outage could cause on its own — every later pass returned
 * immediately without invoking Claude, and nothing in the product could clear it.
 *
 * This route deliberately does the smallest possible thing: it clears technical bookkeeping for the
 * next iteration's handoff directory and lifts any machine-wide writer block, so the NORMAL scheduled
 * writer picks the workflow up again. It is not a way to write a resume on demand, and it bypasses
 * nothing:
 *   - it refuses unless the workflow is still CREATED/IMPROVEMENT_RUNNING
 *   - it re-runs the same human-approval check the writer itself re-asserts (evaluateTailoringAuthorization)
 *   - it never touches a Stage 21 content iteration, review, score, approval, match decision, or
 *     candidate evidence, and can never submit an application
 */
function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(req: NextRequest,
  { params }: { params: Promise<{ candidateId: string; jobId: string }> }
): Promise<NextResponse> {
  const { candidateId: candidateIdParam, jobId: jobIdParam } = await params;

  const candidateId = parsePositiveInt(candidateIdParam);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const jobId = parsePositiveInt(jobIdParam);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // Candidate-scoped lookup, so one candidate can never reset another's workflow even with a
  // dedupe_key they both happen to have.
  const workflow = getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key);
  if (!workflow) {
    return NextResponse.json({ error: "No quality workflow exists for this job.", code: "NO_WORKFLOW" }, { status: 404 });
  }

  const result = resetWriterTechnicalFailures(candidateId, workflow.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.refusal }, { status: 409 });
  }

  return NextResponse.json({ ok: true, workflowId: workflow.id, message: result.message });
}
