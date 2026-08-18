import path from "node:path";
import { getJob, getJobByDedupeKey } from "@/db/queries/jobs";
import { listWorkflowsAwaitingWriter, type ResumeQualityWorkflowRow } from "@/db/queries/resumeQualityWorkflows";
import {
  notifyHumanReviewRequired,
  notifyQualityFailure,
  notifyResumeReady,
  notifyWriterFailure,
} from "@/lib/notifications/resumePipelineNotifications";
import { evaluateTailoringAuthorization } from "../tailoringAuthorization";
import { exportExternalWriterPackage } from "../handoff/exporter";
import { importExternalWriterResult } from "../handoff/importer";
import { executeResumeImprovementIteration, ResumeQualityOrchestrationError } from "../orchestrator";
import { DeterministicResumeReviewer } from "../reviewers/deterministicReviewer";
import type { ResumeWriterAgent, ResumeWriterOutput } from "../types";
import { getHandoffDirectory, type QualityWorkflowLocation } from "../workspace";
import { ClaudeCliTechnicalFailure, invokeClaudeWriter, type ClaudeCliInvokeOptions } from "./claudeCliInvoker";
import {
  claimHandoff,
  clearTechnicalFailures,
  getTechnicalFailureCount,
  MAX_TECHNICAL_PASSES,
  recordTechnicalFailure,
  releaseHandoffClaim,
} from "./handoffClaim";
import {
  acquireResumeWriterLease,
  heartbeatResumeWriterLease,
  recordResumeWriterPassCompleted,
  recordResumeWriterPassFailed,
  recordResumeWriterPassStarted,
  releaseResumeWriterLease,
  RESUME_WRITER_HEARTBEAT_INTERVAL_MS,
} from "./writerState";

/**
 * Stage 12 — the resume-writer worker's per-workflow processing logic, factored out of
 * scripts/resume-writer-worker-continuous.ts so it's importable/testable without also pulling in the
 * script's lock-acquisition + infinite poll loop (which must only ever run once, standalone).
 *
 * Stage 26 made the scheduled tick (src/lib/resumeQuality/writers/tick.ts, registered in
 * src/instrumentation.ts) the primary caller: the standalone script is now an optional operator tool
 * rather than the only way approved work gets written. Both go through runGuardedWriterPass below,
 * which owns the machine-wide lease, so the two entrypoints can never invoke Claude concurrently.
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
  /** Stage 26 — the workflow row exists but the human approval behind it is missing or no longer
   *  agrees with the job's current match decision. Never a failure: nothing is written, nothing is
   *  spent, and the workflow is left exactly as it was for a human to re-approve or abandon. */
  | "SKIPPED_UNAUTHORIZED"
  | "ERROR";

export interface PassOutcome {
  workflowId: number;
  candidateId: number;
  outcome: WorkflowOutcome;
  iterationNumber?: number;
  error?: string;
  /** Stage 26 — set on a TECHNICAL_FAILURE the CLI itself attributed to the provider being
   *  unavailable (HTTP 429/5xx). Reported separately so the user is told "the provider was
   *  temporarily unavailable, this will be retried" instead of being left to wonder whether their
   *  resume or CareerOps is at fault. Observed on the real corpus as HTTP 529 Overloaded. */
  providerUnavailable?: boolean;
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

  // Stage 26 — re-assert the human approval immediately before spending anything. The workflow row
  // could only have been created through an approved POST, but "was approved once" is not the same
  // claim as "is approved now": the job may have been re-evaluated to BLOCKED, or the approval
  // withdrawn, in the minutes or hours between approval and this scheduled pass. Checked here rather
  // than in the tick so it holds for EVERY caller of the worker core, including the standalone
  // script and any future entrypoint — and checked before claimHandoff so an unauthorized workflow
  // leaves no trace on disk at all.
  const authorization = evaluateTailoringAuthorization(candidateId, workflow.dedupe_key);
  if (!authorization.isAuthorized) {
    return {
      workflowId,
      candidateId,
      outcome: "SKIPPED_UNAUTHORIZED",
      iterationNumber: targetIteration,
      error: authorization.blockingReason ?? "Tailoring is not authorized for this job.",
    };
  }

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
      const providerUnavailable = err instanceof ClaudeCliTechnicalFailure && err.providerUnavailable;
      const passCount = recordTechnicalFailure(handoffDir, reason);
      if (passCount >= MAX_TECHNICAL_PASSES) {
        notifyWriterFailure({ ...notifyCtx, technicalRetry: passCount });
      }
      return {
        workflowId,
        candidateId,
        outcome: "TECHNICAL_FAILURE",
        iterationNumber: targetIteration,
        error: reason,
        providerUnavailable,
      };
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

export interface RunWorkerPassOptions extends ProcessWorkflowOptions {
  /** Stage 26 — hard bound on how many workflows one pass may process. Undefined keeps the original
   *  unbounded behavior (used by the standalone script, which pauses between its own passes anyway);
   *  the scheduler tick always passes a small number, because every workflow processed here is at
   *  least one real Claude invocation against the user's subscription. Workflows are always taken
   *  oldest-updated-first (see listWorkflowsAwaitingWriter's ORDER BY), so a bounded pass is a fair
   *  rotation and never starves anything — whatever it does not reach is simply picked up by the
   *  next tick. */
  maxWorkflows?: number;
}

/** One pass over the workflows currently awaiting a writer. Doubles as both the poll-loop body AND
 *  the startup reconciliation scan for the worker script — there is no separate recovery code path;
 *  the very next pass after a restart re-scans and reclaims any stale-pid handoff claim.
 *
 *  `attempted` counts what this pass actually processed; `pending` reports how many were waiting, so
 *  a bounded pass can never look like it covered everything when it did not. */
export async function runWorkerPass(
  options: RunWorkerPassOptions = {}
): Promise<{ attempted: number; pending: number; outcomes: PassOutcome[] }> {
  const pending = listWorkflowsAwaitingWriter();
  const batch = typeof options.maxWorkflows === "number" ? pending.slice(0, Math.max(0, options.maxWorkflows)) : pending;
  const outcomes: PassOutcome[] = [];
  for (const workflow of batch) {
    outcomes.push(await processOneWorkflow(workflow, options));
  }
  return { attempted: batch.length, pending: pending.length, outcomes };
}

export interface GuardedWriterPassResult {
  ran: boolean;
  /** Set only when ran is false — another process (the other entrypoint, or a previous pass that has
   *  not finished) currently holds the machine-wide writer lease. */
  heldSince?: string;
  attempted: number;
  pending: number;
  outcomes: PassOutcome[];
  error?: string;
}

/**
 * The ONE way a writer pass is allowed to run. Takes the machine-wide lease (see writerState.ts),
 * keeps it alive on its own heartbeat timer for as long as the pass takes, records the runtime
 * bookkeeping the UI reads, and always releases — so the in-process scheduler tick and a
 * hand-started `npm run resume-writer-worker-continuous` can never invoke Claude concurrently, and a
 * process that dies mid-pass (or a Mac that sleeps) leaves a lease that goes stale and is reclaimed
 * by a later pass instead of blocking forever.
 *
 * Never throws: a thrown pass is recorded and returned as `error`, so a single bad pass can neither
 * take down the interval timer that called it nor leave the lease held.
 */
export async function runGuardedWriterPass(options: RunWorkerPassOptions = {}): Promise<GuardedWriterPassResult> {
  const lease = acquireResumeWriterLease();
  if (!lease.acquired || !lease.ownerId) {
    return { ran: false, heldSince: lease.heldSince, attempted: 0, pending: 0, outcomes: [] };
  }
  const ownerId = lease.ownerId;

  // On its own timer, not at workflow boundaries: one Claude CLI attempt alone is allowed up to 10
  // minutes, which would otherwise starve the heartbeat and let a healthy pass be declared abandoned.
  const heartbeat = setInterval(() => {
    heartbeatResumeWriterLease(ownerId);
  }, RESUME_WRITER_HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const startedAtMs = Date.now();
  recordResumeWriterPassStarted();
  try {
    const summary = await runWorkerPass(options);
    recordResumeWriterPassCompleted({ attempted: summary.attempted, outcomes: summary.outcomes }, Date.now() - startedAtMs);
    return { ran: true, ...summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordResumeWriterPassFailed(message);
    return { ran: true, attempted: 0, pending: 0, outcomes: [], error: message };
  } finally {
    clearInterval(heartbeat);
    releaseResumeWriterLease(ownerId);
  }
}
