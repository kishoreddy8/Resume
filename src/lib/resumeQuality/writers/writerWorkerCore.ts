import path from "node:path";
import { getJob, getJobByDedupeKey } from "@/db/queries/jobs";
import { listWorkflowsAwaitingWriter, type ResumeQualityWorkflowRow } from "@/db/queries/resumeQualityWorkflows";
import {
  notifyHumanReviewRequired,
  notifyQualityFailure,
  notifyResumeReady,
  notifyWriterFailure,
} from "@/lib/notifications/resumePipelineNotifications";
import { exportExternalWriterPackage } from "../handoff/exporter";
import { importExternalWriterResult } from "../handoff/importer";
import { executeResumeImprovementIteration, ResumeQualityOrchestrationError } from "../orchestrator";
import { DeterministicResumeReviewer } from "../reviewers/deterministicReviewer";
import type { ResumeWriterAgent, ResumeWriterOutput } from "../types";
import { getHandoffDirectory, type QualityWorkflowLocation } from "../workspace";
import { invokeClaudeWriter, type ClaudeCliInvokeOptions } from "./claudeCliInvoker";
import {
  claimHandoff,
  clearTechnicalFailures,
  getTechnicalFailureCount,
  MAX_TECHNICAL_PASSES,
  recordTechnicalFailure,
  releaseHandoffClaim,
} from "./handoffClaim";

/**
 * Stage 12 — the resume-writer worker's per-workflow processing logic, factored out of
 * scripts/resume-writer-worker-continuous.ts so it's importable/testable without also pulling in the
 * script's lock-acquisition + infinite poll loop (which must only ever run once, standalone).
 *
 * Reuses the SAME two orchestrator calls the existing manual Export/Import UI already uses
 * (exportExternalWriterPackage, then a one-shot ResumeWriterAgent wrapping the validated result into
 * executeResumeImprovementIteration — see .../quality-workflow/import/route.ts's own staticWriter
 * pattern) — zero changes to the orchestrator, exporter, importer, state machine, or quality gate.
 */

export type WorkflowOutcome =
  | "READY"
  | "IMPROVEMENT_RUNNING"
  | "FAILED"
  | "TECHNICAL_FAILURE"
  | "SKIPPED_CLAIMED"
  | "SKIPPED_MAX_ATTEMPTS"
  | "ERROR";

export interface PassOutcome {
  workflowId: number;
  candidateId: number;
  outcome: WorkflowOutcome;
  iterationNumber?: number;
  error?: string;
}

export interface ProcessWorkflowOptions {
  /** Passed through to invokeClaudeWriter — lets tests substitute a stub CLI executable. */
  cliOptions?: Partial<Pick<ClaudeCliInvokeOptions, "command" | "timeoutMs" | "retryBackoffMs" | "maxBudgetUsd" | "model">>;
}

/**
 * Processes exactly one workflow currently awaiting a writer: claim -> export -> invoke Claude CLI
 * (bounded technical retry, handled inside invokeClaudeWriter) -> import -> drive the existing
 * quality-review loop -> notify -> release claim. Every error is caught and returned as an outcome —
 * this function must NEVER throw, so one workflow's failure can never abort a batch or affect an
 * unrelated candidate's workflow (candidate isolation).
 */
export async function processOneWorkflow(workflow: ResumeQualityWorkflowRow, options: ProcessWorkflowOptions = {}): Promise<PassOutcome> {
  const { candidate_id: candidateId, id: workflowId } = workflow;
  const targetIteration = workflow.current_iteration + 1;

  const location: QualityWorkflowLocation = {
    candidateId,
    dedupeKey: workflow.dedupe_key,
    runId: workflow.tailoring_run_id,
    workflowId,
  };
  const handoffDir = getHandoffDirectory(location, targetIteration);

  const jobBasic = getJobByDedupeKey(workflow.dedupe_key);
  const job = jobBasic ? getJob(jobBasic.id) : undefined;
  const notifyCtx = {
    candidateId,
    dedupeKey: workflow.dedupe_key,
    companyName: job?.company_name ?? "the company",
    jobTitle: job?.title ?? "the role",
  };

  const claim = claimHandoff(handoffDir);
  if (!claim) {
    return { workflowId, candidateId, outcome: "SKIPPED_CLAIMED", iterationNumber: targetIteration };
  }

  try {
    const priorAttempts = getTechnicalFailureCount(handoffDir);
    if (priorAttempts >= MAX_TECHNICAL_PASSES) {
      return { workflowId, candidateId, outcome: "SKIPPED_MAX_ATTEMPTS", iterationNumber: targetIteration };
    }

    try {
      exportExternalWriterPackage({ candidateId, workflowId, targetIterationNumber: targetIteration, overwriteExisting: true });
      await invokeClaudeWriter({ handoffDir, ...options.cliOptions });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const passCount = recordTechnicalFailure(handoffDir, reason);
      if (passCount >= MAX_TECHNICAL_PASSES) {
        notifyWriterFailure({ ...notifyCtx, technicalRetry: passCount });
      }
      return { workflowId, candidateId, outcome: "TECHNICAL_FAILURE", iterationNumber: targetIteration, error: reason };
    }

    const importResult = importExternalWriterResult({
      candidateId,
      workflowId,
      expectedIterationNumber: targetIteration,
      inputPath: path.join(handoffDir, "writer_output.json"),
    });

    const staticWriter: ResumeWriterAgent = {
      generate: async (): Promise<ResumeWriterOutput> => importResult.writerOutput,
    };

    const improvementResult = await executeResumeImprovementIteration({
      candidateId,
      workflowId,
      writer: staticWriter,
      reviewer: new DeterministicResumeReviewer(),
    });

    clearTechnicalFailures(handoffDir);

    if (improvementResult.status === "READY") {
      notifyResumeReady(notifyCtx);
      return { workflowId, candidateId, outcome: "READY", iterationNumber: improvementResult.iterationNumber };
    }

    if (improvementResult.status === "FAILED") {
      notifyHumanReviewRequired({
        ...notifyCtx,
        remainingBlockers: improvementResult.review.blockingIssues.length,
        bestAttemptIteration: improvementResult.humanReviewPackage?.iterationNumber,
      });
      return { workflowId, candidateId, outcome: "FAILED", iterationNumber: improvementResult.iterationNumber };
    }

    // IMPROVEMENT_RUNNING — quality gate failed, iterations remain. This is a real, valid resume
    // that CareerOps reviewed and rejected — a genuine quality-iteration outcome, never a technical
    // one. The next worker pass automatically exports+claims+invokes the NEXT iteration, which
    // already carries this iteration's review/corrections forward (buildResumeWriterInput reads
    // workflow.current_iteration, already advanced by executeResumeImprovementIteration above).
    notifyQualityFailure({
      ...notifyCtx,
      iteration: improvementResult.iterationNumber,
      blockingIssue: improvementResult.review.blockingIssues[0] ?? improvementResult.requiredCorrections[0]?.description ?? null,
    });
    return { workflowId, candidateId, outcome: "IMPROVEMENT_RUNNING", iterationNumber: improvementResult.iterationNumber };
  } catch (err) {
    if (err instanceof ResumeQualityOrchestrationError) {
      return { workflowId, candidateId, outcome: "ERROR", error: `${err.code}: ${err.message}` };
    }
    return { workflowId, candidateId, outcome: "ERROR", error: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseHandoffClaim(handoffDir);
  }
}

/** One full pass over every workflow currently awaiting a writer. Doubles as both the poll-loop body
 *  AND the startup reconciliation scan for the worker script — there is no separate recovery code
 *  path; the very next pass after a restart re-scans and reclaims any stale-pid handoff claim. */
export async function runWorkerPass(options: ProcessWorkflowOptions = {}): Promise<{ attempted: number; outcomes: PassOutcome[] }> {
  const pending = listWorkflowsAwaitingWriter();
  const outcomes: PassOutcome[] = [];
  for (const workflow of pending) {
    outcomes.push(await processOneWorkflow(workflow, options));
  }
  return { attempted: pending.length, outcomes };
}
