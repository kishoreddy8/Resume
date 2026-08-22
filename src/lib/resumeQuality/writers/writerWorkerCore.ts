import fs from "node:fs";
import path from "node:path";
import { getJob, getJobByDedupeKey } from "@/db/queries/jobs";
import {
  getResumeQualityWorkflow,
  listWorkflowsAwaitingWriter,
  recordResumeQualityWorkflowProviders,
  type ResumeQualityWorkflowRow,
} from "@/db/queries/resumeQualityWorkflows";
import {
  notifyHumanReviewRequired,
  notifyQualityFailure,
  notifyResumeReady,
  notifyWriterFailure,
} from "@/lib/notifications/resumePipelineNotifications";
import { describeContactProblems, resolveCandidateContact } from "../candidateContact";
import { evaluateTailoringAuthorization } from "../tailoringAuthorization";
import { exportExternalWriterPackage } from "../handoff/exporter";
import { importExternalWriterResult } from "../handoff/importer";
import { executeResumeImprovementIteration, ResumeQualityOrchestrationError } from "../orchestrator";
import { DeterministicResumeReviewer } from "../reviewers/deterministicReviewer";
import type { ResumeWriterAgent, ResumeWriterOutput } from "../types";
import { getHandoffDirectory, getWorkspaceDirectory, type QualityWorkflowLocation } from "../workspace";
import {
  assertResumeWriterRuntimeContract,
  ensureResumeWriterRuntimeContract,
  ResumeWriterRuntimeMismatchError,
} from "../runtimeContract";
import {
  CLAUDE_CLI_PROVIDER,
  ClaudeCliTechnicalFailure,
  invokeClaudeWriter,
  OPERATOR_ACTIONABLE_FAILURE_CLASSES,
  type ClaudeCliInvokeOptions,
  type WriterFailureClass,
} from "./claudeCliInvoker";
import {
  claimHandoff,
  clearTechnicalFailures,
  getTechnicalFailureCount,
  MAX_TECHNICAL_PASSES,
  recordNonCountingFailure,
  recordTechnicalFailure,
  releaseHandoffClaim,
} from "./handoffClaim";
import {
  acquireResumeWriterLease,
  clearWriterOperationalBlock,
  getWriterOperationalBlock,
  heartbeatResumeWriterLease,
  recordWriterOperationalBlock,
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

/**
 * Stage 27 — the Stage 21 reviewer is CareerOps' own deterministic code (DeterministicResumeReviewer),
 * not a model and not an external provider. These values say exactly that. They are truthful because
 * they describe what this build actually runs, and they are the only reviewer values ever written —
 * nothing here implies an LLM reviewed anything.
 */
/** Best-effort file size for timing diagnostics — never throws, never affects the workflow. */
function safeFileSize(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

export const DETERMINISTIC_REVIEWER_PROVIDER = "careerops-deterministic";
export const DETERMINISTIC_REVIEWER_MODEL = "stage21-deterministic";

export type WorkflowOutcome =
  | "READY"
  | "IMPROVEMENT_RUNNING"
  | "FAILED"
  | "TECHNICAL_FAILURE"
  | "SKIPPED_CLAIMED"
  /** Stage 27 — the bounded technical-retry budget for this handoff is exhausted. TERMINAL for
   *  automatic processing: no further Claude invocation is made for this iteration until an operator
   *  explicitly resets it. Renamed from SKIPPED_MAX_ATTEMPTS because "skipped" implied the writer
   *  would come back to it on the next pass, which was never true and which the UI repeated as
   *  "retries on its own schedule". No content iteration was consumed reaching this state. */
  | "BLOCKED_MAX_ATTEMPTS"
  /** Stage 27 — the user's Claude subscription usage limit is exhausted. Not a failure of this
   *  workflow, and no content iteration is consumed. The writer waits out a cooldown rather than
   *  re-invoking Claude every pass; CareerOps cannot know the true reset time (print mode reports
   *  none), so it never claims one. */
  | "SUBSCRIPTION_LIMIT_REACHED"
  /** Stage 27 — the Claude CLI is logged out or its credentials expired. Only the operator can fix
   *  it, so nothing is retried automatically and no content iteration is consumed. */
  | "AUTH_REQUIRED"
  /** Stage 26 — the workflow row exists but the human approval behind it is missing or no longer
   *  agrees with the job's current match decision. Never a failure: nothing is written, nothing is
   *  spent, and the workflow is left exactly as it was for a human to re-approve or abandon. */
  | "SKIPPED_UNAUTHORIZED"
  /** Stage 26B — the candidate has no valid contact configuration, so no renderable resume could be
   *  produced no matter how good the writing is. A configuration problem, never a quality verdict:
   *  no Claude call is made, no iteration is consumed, and the workflow waits unchanged until the
   *  human fills the details in. */
  | "CANDIDATE_CONTACT_REQUIRED"
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
  /** Stage 27 — the CLI's classified reason, when one was established. Diagnostic/reporting only:
   *  it never affects the quality gate, the iteration budget, or approval. */
  failureClass?: WriterFailureClass;
  /** Stage 28 — measured wall-clock for each stage of this iteration, in milliseconds. Recorded so
   *  "tailoring is slow" can be answered with evidence instead of assumption; purely diagnostic. */
  timings?: IterationTimings;
}

/**
 * Stage 28 — where the time actually goes for ONE content iteration.
 *
 * Measured on the real corpus before any optimisation: `claudeMs` is 3m15s-4m28s while
 * `importMs + reviewAndRenderMs` together are 11-17s. The expensive part of tailoring is the model
 * call, and everything CareerOps does around it is close to free — which is why Stage 28 spends its
 * effort on making the FIRST attempt succeed and on not waiting between attempts, rather than on
 * micro-optimising CareerOps' own work.
 */
export interface IterationTimings {
  /** Building the handoff package (evidence snapshot, prompt, requirements). */
  exportMs: number;
  /** The Claude CLI invocation itself, including its own bounded internal retries. */
  claudeMs: number;
  /** Reading and strictly validating writer_output.json. */
  importMs: number;
  /** The deterministic Stage 21 review plus both DOCX renders, and publication when READY. */
  reviewAndRenderMs: number;
  /** Sum of the above for this iteration. */
  totalMs: number;
  /** Bytes handed to the writer, and returned by it — prompt/output size, for the same evidence. */
  promptBytes: number | null;
  outputBytes: number | null;
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
  const workspaceDir = getWorkspaceDirectory(location);

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

  // Stage 26B — checked BEFORE the claim and before any spend, because missing contact details are an
  // input problem that no amount of rewriting can fix. The renderer hard-requires a real email
  // (tools/tailoring-engine/generate.ts), so without one every attempt would produce a resume that
  // cannot be turned into a document — burning a genuine quality iteration on a foregone conclusion,
  // and previously doing so invisibly, since the render error was swallowed.
  const contact = resolveCandidateContact(candidateId);
  if (!contact.isComplete) {
    return {
      workflowId,
      candidateId,
      outcome: "CANDIDATE_CONTACT_REQUIRED",
      iterationNumber: targetIteration,
      error: `Candidate contact details are required before tailoring can run. ${describeContactProblems(contact)}`,
    };
  }

  // Stage 27 — a machine-wide operational block (exhausted subscription / logged-out CLI) applies to
  // every workflow at once, so it is checked before the claim, exactly like authorization and contact:
  // nothing is spent, nothing is written to disk, and no content iteration is touched.
  const block = getWriterOperationalBlock();
  if (block.blocked && !block.expired) {
    return {
      workflowId,
      candidateId,
      outcome: block.blockClass === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "SUBSCRIPTION_LIMIT_REACHED",
      iterationNumber: targetIteration,
      error: block.detail ?? undefined,
      failureClass: block.blockClass ?? undefined,
    };
  }

  // Fail closed before claim/export/spend when the API producer and this long-lived worker loaded
  // different source/contract versions. Legacy unstamped workflows are adopted exactly once by the
  // current runtime; every workflow created after this guard is stamped by the POST route.
  try {
    ensureResumeWriterRuntimeContract(workspaceDir);
  } catch (error) {
    if (error instanceof ResumeWriterRuntimeMismatchError) {
      return {
        workflowId,
        candidateId,
        outcome: "ERROR",
        iterationNumber: targetIteration,
        error: `${error.code}: ${error.message}`,
      };
    }
    return {
      workflowId,
      candidateId,
      outcome: "ERROR",
      iterationNumber: targetIteration,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const claim = claimHandoff(handoffDir);
  if (!claim) {
    return { workflowId, candidateId, outcome: "SKIPPED_CLAIMED", iterationNumber: targetIteration };
  }

  try {
    const priorAttempts = getTechnicalFailureCount(handoffDir);
    if (priorAttempts >= MAX_TECHNICAL_PASSES) {
      // Terminal for automatic processing — deliberately NOT retried on the next pass. An operator
      // must reset the technical bookkeeping (resetWriterTechnicalFailures) after looking at why it
      // kept failing. No Claude call is made, and no content iteration has been consumed.
      return {
        workflowId,
        candidateId,
        outcome: "BLOCKED_MAX_ATTEMPTS",
        iterationNumber: targetIteration,
        error: `The writer failed ${priorAttempts} times in a row for technical reasons and has stopped retrying automatically. No quality iteration was used.`,
      };
    }

    let cliMetadata: Awaited<ReturnType<typeof invokeClaudeWriter>>["metadata"] = null;
    const startedAtMs = Date.now();
    let exportMs = 0;
    let claudeMs = 0;
    let promptBytes: number | null = null;
    let outputBytes: number | null = null;
    try {
      exportExternalWriterPackage({ candidateId, workflowId, targetIterationNumber: targetIteration, overwriteExisting: true });
      exportMs = Date.now() - startedAtMs;
      promptBytes = safeFileSize(path.join(handoffDir, "writer_prompt.md"));
      // Re-check immediately before transmission: export cannot silently replace the immutable stamp.
      assertResumeWriterRuntimeContract(workspaceDir);
      const claudeStartedMs = Date.now();
      const invocation = await invokeClaudeWriter({ handoffDir, ...options.cliOptions });
      claudeMs = Date.now() - claudeStartedMs;
      outputBytes = safeFileSize(invocation.outputPath);
      cliMetadata = invocation.metadata;
      // A checkout/runtime switch during the model call cannot be accepted as a valid iteration.
      assertResumeWriterRuntimeContract(workspaceDir);
    } catch (err) {
      if (err instanceof ResumeWriterRuntimeMismatchError) {
        return {
          workflowId,
          candidateId,
          outcome: "ERROR",
          iterationNumber: targetIteration,
          error: `${err.code}: ${err.message}`,
        };
      }
      const reason = err instanceof Error ? err.message : String(err);
      const failureClass: WriterFailureClass =
        err instanceof ClaudeCliTechnicalFailure ? err.failureClass : "TRANSIENT_TECHNICAL_FAILURE";
      const providerUnavailable = err instanceof ClaudeCliTechnicalFailure && err.providerUnavailable;

      // Stage 27 — an exhausted subscription or a logged-out CLI is not evidence that THIS handoff is
      // broken, so it must not spend the bounded technical budget that, once exhausted, stops the
      // workflow being processed at all. It is recorded machine-wide instead, because it is equally
      // true for every other queued workflow.
      if (OPERATOR_ACTIONABLE_FAILURE_CLASSES.includes(failureClass)) {
        recordNonCountingFailure(handoffDir, reason, failureClass);
        recordWriterOperationalBlock(failureClass, reason);
        return {
          workflowId,
          candidateId,
          outcome: failureClass === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "SUBSCRIPTION_LIMIT_REACHED",
          iterationNumber: targetIteration,
          error: reason,
          failureClass,
        };
      }

      const passCount = recordTechnicalFailure(handoffDir, reason, failureClass);
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
        failureClass,
      };
    }

    const importStartedMs = Date.now();
    const importResult = importExternalWriterResult({
      candidateId,
      workflowId,
      expectedIterationNumber: targetIteration,
      inputPath: path.join(handoffDir, "writer_output.json"),
    });
    const importMs = Date.now() - importStartedMs;
    const reviewStartedMs = Date.now();

    const staticWriter: ResumeWriterAgent = {
      generate: async (): Promise<ResumeWriterOutput> => importResult.writerOutput,
    };

    let improvementResult: Awaited<ReturnType<typeof executeResumeImprovementIteration>>;
    try {
      improvementResult = await executeResumeImprovementIteration({
        candidateId,
        workflowId,
        writer: staticWriter,
        reviewer: new DeterministicResumeReviewer(),
      });
    } catch (err) {
      // A REPAIR_SCOPE_VIOLATION already cost a real Claude invocation, so — same as every other
      // writer failure class above — it must consume the bounded technical budget rather than
      // retrying unboundedly on every scheduler tick. The rejected output was never persisted as a
      // quality iteration (the throw happens before that in the orchestrator) and can never become
      // the best attempt; only the failure bookkeeping changes here.
      if (err instanceof ResumeQualityOrchestrationError && err.code === "REPAIR_SCOPE_VIOLATION") {
        const reason = err.message;
        const passCount = recordTechnicalFailure(handoffDir, reason, "REPAIR_SCOPE_VIOLATION");
        if (passCount >= MAX_TECHNICAL_PASSES) {
          notifyWriterFailure({ ...notifyCtx, technicalRetry: passCount });
        }
        return {
          workflowId,
          candidateId,
          outcome: "TECHNICAL_FAILURE",
          iterationNumber: targetIteration,
          error: reason,
          failureClass: "REPAIR_SCOPE_VIOLATION",
        };
      }
      throw err;
    }

    const reviewAndRenderMs = Date.now() - reviewStartedMs;
    const timings: IterationTimings = {
      exportMs,
      claudeMs,
      importMs,
      reviewAndRenderMs,
      totalMs: Date.now() - startedAtMs,
      promptBytes,
      outputBytes,
    };

    clearTechnicalFailures(handoffDir);
    // Stage 27 — the CLI ran successfully, so whatever block was recorded earlier is demonstrably
    // over. Cleared here rather than on a timer: a real success is the only proof that matters.
    clearWriterOperationalBlock();

    // Stage 27 — truthful runtime provenance only. writer_model stays NULL when the CLI reported no
    // model; the reviewer is CareerOps' own deterministic Stage 21 logic, which is a fact about this
    // build rather than a runtime observation, so it is stated plainly and never as an LLM.
    recordResumeQualityWorkflowProviders(candidateId, workflowId, {
      writerProvider: CLAUDE_CLI_PROVIDER,
      writerModel: cliMetadata?.model ?? null,
      reviewerProvider: DETERMINISTIC_REVIEWER_PROVIDER,
      reviewerModel: DETERMINISTIC_REVIEWER_MODEL,
    });

    if (improvementResult.status === "READY") {
      notifyResumeReady(notifyCtx);
      return { workflowId, candidateId, outcome: "READY", iterationNumber: improvementResult.iterationNumber, timings };
    }

    if (improvementResult.status === "FAILED") {
      notifyHumanReviewRequired({
        ...notifyCtx,
        remainingBlockers: improvementResult.review.blockingIssues.length,
        bestAttemptIteration: improvementResult.humanReviewPackage?.iterationNumber,
      });
      return { workflowId, candidateId, outcome: "FAILED", iterationNumber: improvementResult.iterationNumber, timings };
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
    return { workflowId, candidateId, outcome: "IMPROVEMENT_RUNNING", iterationNumber: improvementResult.iterationNumber, timings };
  } catch (err) {
    if (err instanceof ResumeQualityOrchestrationError) {
      return { workflowId, candidateId, outcome: "ERROR", error: `${err.code}: ${err.message}` };
    }
    return { workflowId, candidateId, outcome: "ERROR", error: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseHandoffClaim(handoffDir);
  }
}

export type WriterRetryRefusal =
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_TERMINAL"
  | "NOT_AUTHORIZED";

export interface WriterRetryResult {
  ok: boolean;
  refusal?: WriterRetryRefusal;
  message: string;
  /** The handoff directory whose technical bookkeeping was reset, when one was. */
  handoffDir?: string;
}

/**
 * Stage 27 — the operator's explicit "Retry writer" action for one workflow.
 *
 * Deliberately the narrowest possible operation. It clears the technical-failure bookkeeping for the
 * NEXT iteration's handoff directory and lifts any machine-wide operational block, so the normal
 * scheduled writer picks the workflow up again on its own. That is all it does.
 *
 * What it explicitly does NOT do, and structurally cannot do — none of these are represented in the
 * files/keys it touches:
 *   - reset, rewind, or add a Stage 21 content iteration (current_iteration is never written)
 *   - alter candidate master evidence, a review, or a score
 *   - approve, re-approve, or un-approve a job (approval lives on candidate_job_state)
 *   - alter a match score or decision
 *   - submit an application
 *
 * It refuses on a terminal workflow (READY/FAILED — there is nothing for the writer to do) and on a
 * workflow whose human approval is missing or stale, re-using the SAME authorization evaluation the
 * writer itself re-asserts before spending anything.
 */
export function resetWriterTechnicalFailures(candidateId: number, workflowId: number): WriterRetryResult {
  const workflow = getResumeQualityWorkflow(candidateId, workflowId);
  if (!workflow) {
    return { ok: false, refusal: "WORKFLOW_NOT_FOUND", message: `Workflow ${workflowId} was not found for this candidate.` };
  }
  if (workflow.status !== "CREATED" && workflow.status !== "IMPROVEMENT_RUNNING") {
    return {
      ok: false,
      refusal: "WORKFLOW_TERMINAL",
      message: `Workflow ${workflowId} is ${workflow.status}; there is no pending writer work to retry.`,
    };
  }

  const authorization = evaluateTailoringAuthorization(candidateId, workflow.dedupe_key);
  if (!authorization.isAuthorized) {
    return {
      ok: false,
      refusal: "NOT_AUTHORIZED",
      message: authorization.blockingReason ?? "Tailoring is not authorized for this job.",
    };
  }

  const handoffDir = getHandoffDirectory(
    { candidateId, dedupeKey: workflow.dedupe_key, runId: workflow.tailoring_run_id, workflowId },
    workflow.current_iteration + 1
  );
  clearTechnicalFailures(handoffDir);
  clearWriterOperationalBlock();

  return {
    ok: true,
    handoffDir,
    message: "Technical retry bookkeeping was cleared. The writer will pick this workflow up on its next scheduled pass. No quality iteration was changed.",
  };
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
/**
 * Stage 28 — drives ONE workflow to a terminal state within a single pass, instead of leaving it for
 * the next scheduled tick.
 *
 * This is the single biggest speed win in Stage 28, and it is a scheduling fix rather than a
 * pipeline one. Measured on the real corpus: one content iteration costs ~3.5 minutes of Claude plus
 * ~15 seconds of CareerOps work, but `processOneWorkflow` completed exactly one iteration and
 * returned, so the next attempt waited for the next 30-minute tick. Workflow 7 therefore took
 * 64.5 minutes wall-clock for 3 iterations of which roughly 43 minutes was pure queue wait, while
 * the same pipeline driven by the 60-second-pause standalone worker finished 2 iterations in 9m15s.
 *
 * Continuing here removes that wait entirely without weakening any bound:
 *   - the content-iteration budget is still the workflow's own max_iterations (Stage 28: 2), enforced
 *     by createResumeQualityIteration, not by this loop;
 *   - a technical/provider/operator-actionable outcome stops the loop immediately, so a subscription
 *     limit or outage is never retried in a tight cycle;
 *   - the machine-wide lease is held for the whole time, so no second writer can start;
 *   - `iterationCap` is a hard structural backstop against ever looping unbounded.
 */
async function driveWorkflowToCompletion(
  workflow: ResumeQualityWorkflowRow,
  options: ProcessWorkflowOptions
): Promise<PassOutcome[]> {
  const outcomes: PassOutcome[] = [];
  // Never more attempts than the workflow's own remaining content budget. Purely a backstop: the
  // iteration layer refuses an out-of-budget iteration on its own.
  const iterationCap = Math.max(1, workflow.max_iterations - workflow.current_iteration);

  let current: ResumeQualityWorkflowRow | undefined = workflow;
  for (let attempt = 0; attempt < iterationCap && current; attempt++) {
    const outcome = await processOneWorkflow(current, options);
    outcomes.push(outcome);
    // Anything other than "the gate rejected a real resume and budget remains" ends this workflow's
    // turn — terminal states, technical failures, and every operator-actionable condition alike.
    if (outcome.outcome !== "IMPROVEMENT_RUNNING") break;
    // Re-read: executeResumeImprovementIteration has advanced current_iteration, and the next
    // iteration's prompt is built from that updated row.
    current = getResumeQualityWorkflow(workflow.candidate_id, workflow.id);
    if (!current || (current.status !== "CREATED" && current.status !== "IMPROVEMENT_RUNNING")) break;
  }
  return outcomes;
}

export async function runWorkerPass(
  options: RunWorkerPassOptions = {}
): Promise<{ attempted: number; pending: number; outcomes: PassOutcome[] }> {
  const pending = listWorkflowsAwaitingWriter();
  const batch = typeof options.maxWorkflows === "number" ? pending.slice(0, Math.max(0, options.maxWorkflows)) : pending;
  const outcomes: PassOutcome[] = [];
  for (const workflow of batch) {
    outcomes.push(...(await driveWorkflowToCompletion(workflow, options)));
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
