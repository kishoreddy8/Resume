import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import { getLatestResumeQualityWorkflowForJob, getResumeQualityWorkflow } from "@/db/queries/resumeQualityWorkflows";
import { importExternalWriterResult, loadPatchContextFromHandoff } from "@/lib/resumeQuality/handoff/importer";
import { getHandoffDirectory } from "@/lib/resumeQuality/workspace";
import { executeResumeImprovementIteration, ResumeQualityOrchestrationError } from "@/lib/resumeQuality/orchestrator";
import { DeterministicResumeReviewer } from "@/lib/resumeQuality/reviewers/deterministicReviewer";
import type { ResumeWriterAgent, ResumeWriterOutput } from "@/lib/resumeQuality/types";

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(
  req: NextRequest,
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

  const workflow = getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key);
  if (!workflow) {
    return NextResponse.json({ error: "No quality workflow found for this job" }, { status: 404 });
  }

  // Stage 26 — CREATED is accepted alongside IMPROVEMENT_RUNNING because it is now a real
  // awaiting-writer state (its target is iteration 1, written by the writer rather than synthesized
  // by the server). Keeping the manual export/import path available for iteration 1 too means the
  // human fallback covers every iteration the automatic writer covers, not all-but-the-first.
  // READY/FAILED are still refused here, and the orchestrator independently refuses terminal
  // workflows regardless of what this route allows.
  if (workflow.status !== "IMPROVEMENT_RUNNING" && workflow.status !== "CREATED") {
    return NextResponse.json(
      {
        error: `Workflow is in status ${workflow.status}, not IMPROVEMENT_RUNNING or CREATED. Cannot import external writer output.`,
        code: "INVALID_WORKFLOW_STATUS",
      },
      { status: 400 }
    );
  }

  let payload: unknown;
  try {
    const text = await req.text();
    payload = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body provided. Please ensure writer_output.json contains valid JSON.", code: "INVALID_JSON" },
      { status: 400 }
    );
  }

  const expectedIteration = workflow.current_iteration + 1;
  const handoffDir = getHandoffDirectory(
    { candidateId, dedupeKey: workflow.dedupe_key, runId: workflow.tailoring_run_id, workflowId: workflow.id },
    expectedIteration
  );
  const patchContext = loadPatchContextFromHandoff(handoffDir);

  // 1. Stage 11 Strict Validation & Import
  let importResult;
  try {
    importResult = importExternalWriterResult({
      candidateId,
      workflowId: workflow.id,
      parsedOutput: payload,
      expectedIterationNumber: expectedIteration,
      patchContext,
    });
  } catch (err: unknown) {
    if (err instanceof ResumeQualityOrchestrationError) {
      return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Failed to import external writer output";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // 2. Stage 10 Improvement Loop Continuation
  try {
    const staticWriter: ResumeWriterAgent = {
      generate: async (): Promise<ResumeWriterOutput> => importResult.writerOutput,
    };

    const improvementResult = await executeResumeImprovementIteration({
      candidateId,
      workflowId: workflow.id,
      writer: staticWriter,
      reviewer: new DeterministicResumeReviewer(),
    });

    const updatedWorkflow = getResumeQualityWorkflow(candidateId, workflow.id);
    const safeWf = updatedWorkflow
      ? {
          id: updatedWorkflow.id,
          status: updatedWorkflow.status,
          current_iteration: updatedWorkflow.current_iteration,
          max_iterations: updatedWorkflow.max_iterations,
          latest_overall_score: updatedWorkflow.latest_overall_score,
          final_approved_iteration: updatedWorkflow.final_approved_iteration,
          failure_reason: updatedWorkflow.failure_reason,
          created_at: updatedWorkflow.created_at,
        }
      : null;

    return NextResponse.json({
      ok: true,
      workflow: safeWf,
      result: improvementResult,
    });
  } catch (err: unknown) {
    if (err instanceof ResumeQualityOrchestrationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Failed to execute improvement iteration";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
