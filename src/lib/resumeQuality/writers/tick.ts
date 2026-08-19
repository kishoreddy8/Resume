import { getAppSettings } from "@/db/queries/settings";
import { listWorkflowsAwaitingWriter } from "@/db/queries/resumeQualityWorkflows";
import { isEnabled, isIntervalDue, isWithinWindow } from "@/lib/scheduler/window";
import { runGuardedWriterPass, type PassOutcome, type RunWorkerPassOptions } from "./writerWorkerCore";
import { getResumeWriterRuntimeState, recordResumeWriterTick } from "./writerState";

/**
 * Stage 26 — bounded scheduled resume-writer passes.
 *
 * Its own tick, alongside runSchedulerTick (scans), runProductionCycleTick (ingestion) and
 * runJobEvaluationTick (matching), sharing the ONE interval timer in src/instrumentation.ts and the
 * ONE operator-facing "when may background automation run" surface (settings.scheduler: enabled,
 * window, timezone). This is not a second scheduling framework: it is the fourth tick in the existing
 * one, following the pattern src/lib/match/tick.ts established verbatim.
 *
 * What it does NOT do, on purpose:
 *   - It never decides that a job deserves tailoring. It only picks up workflows a human already
 *     approved (a workflow row cannot exist otherwise, and processOneWorkflow re-asserts the approval
 *     immediately before spending anything). A match score, however high, can never reach this code.
 *   - It never submits an application, and never touches application status.
 *   - It never loops. One bounded batch per due interval, one pass at a time machine-wide (the lease
 *     in writerState.ts), and nothing at all outside the operator's configured window.
 */

/**
 * Deliberately the most conservative cadence of the four ticks. Every workflow this processes costs
 * at least one real Claude Code invocation against the user's own subscription (up to 3 bounded
 * technical retries, each allowed 10 minutes), so this is metered in tens of minutes, not the 5
 * minutes job evaluation can afford by being free and synchronous. 30 minutes with a batch of 2 caps
 * the automatic writer at 4 workflow-passes per hour even in the worst case, while still draining a
 * realistic approval backlog (a handful of approved jobs) inside a single automation window.
 */
export const RESUME_WRITER_INTERVAL_MINUTES = 30;

/**
 * Stage 29 — minimum spacing between writer passes WHEN APPROVED WORK IS ALREADY QUEUED.
 *
 * The target is that an approved workflow begins being written within roughly a minute of the worker
 * noticing it, rather than waiting out a cadence meant for an idle system. One minute still prevents
 * a tight loop if a pass returns immediately, while every real bound on spend (the lease, the batch
 * ceiling, the two-iteration cap, the technical-failure cap, the subscription/auth block) is
 * unchanged and continues to do the actual limiting.
 */
export const RESUME_WRITER_PENDING_INTERVAL_MINUTES = 1;

/** Hard bound on workflows per pass — see RunWorkerPassOptions.maxWorkflows. Oldest-updated first, so
 *  whatever this pass does not reach is simply first in line on the next one. */
export const RESUME_WRITER_BATCH_SIZE = 2;

export type ResumeWriterTickOutcome =
  | { outcome: "SKIPPED_DISABLED" }
  | { outcome: "SKIPPED_OUTSIDE_WINDOW" }
  | { outcome: "SKIPPED_INTERVAL_NOT_DUE" }
  | { outcome: "SKIPPED_NO_PENDING_WORKFLOWS" }
  | { outcome: "SKIPPED_LEASE_HELD"; heldSince?: string }
  | { outcome: "RAN"; attempted: number; pending: number; outcomes: PassOutcome[] }
  | { outcome: "FAILED"; error: string };

/**
 * One scheduled writer tick. Never throws — every path resolves to a ResumeWriterTickOutcome,
 * matching runSchedulerTick/runProductionCycleTick/runJobEvaluationTick's own contract, so
 * instrumentation.ts's timer needs no try/catch of its own and a failing pass can never stop future
 * ticks from happening.
 */
export async function runResumeWriterTick(
  now: Date = new Date(),
  /** Forwarded to the writer, mirroring ProcessWorkflowOptions' own "overridable for tests" contract
   *  at every other layer of this pipeline. Production callers (instrumentation.ts) pass nothing and
   *  get the real CLI; automated tests MUST pass a fixture command, and
   *  CAREER_OPS_DISABLE_REAL_CLAUDE_CLI=1 makes forgetting to fail loudly rather than bill a real
   *  generation — the tick reaching the real binary through an un-stubbed test is exactly the mistake
   *  that guard exists for. */
  options: RunWorkerPassOptions = {}
): Promise<ResumeWriterTickOutcome> {
  // Stamped first, on every single evaluation including the ones that decide not to run: this is the
  // only honest evidence that something is actually running the writer scheduler, which is what lets
  // the UI say "waiting for the next attempt" instead of guessing (see writerHealth.ts).
  recordResumeWriterTick(now);

  const settings = getAppSettings();
  // Stage 27 — master kill switch, then the writer's own switch. This is the tick that spends the
  // user's Claude subscription, so it is the one an operator is most likely to want off while the
  // free, local discovery/evaluation ticks keep running.
  if (!isEnabled(settings.scheduler) || !settings.scheduler.writerEnabled) {
    return { outcome: "SKIPPED_DISABLED" };
  }
  if (!isWithinWindow(now, settings.scheduler)) {
    return { outcome: "SKIPPED_OUTSIDE_WINDOW" };
  }
  // Stage 29 — the cheap "is there anything to do?" read now happens BEFORE the spacing check, and
  // it decides which spacing applies. Previously the 30-minute gap was evaluated first, so a job
  // approved moments after a pass finished waited up to half an hour before the writer would even
  // look at it — the second cause of writer starvation, alongside the worker running this tick last
  // and behind a ten-minute production cycle.
  const pending = listWorkflowsAwaitingWriter().length;
  if (pending === 0) {
    return { outcome: "SKIPPED_NO_PENDING_WORKFLOWS" };
  }

  // With approved work queued the spacing drops to RESUME_WRITER_PENDING_INTERVAL_MINUTES, so a
  // human who has just approved a job is not left waiting on a cadence designed for an idle system.
  //
  // This is safe to shorten because none of the actual bounds on Claude spend live here: the
  // machine-wide lease still allows exactly one pass at a time, a pass still processes at most
  // RESUME_WRITER_BATCH_SIZE workflows, each workflow is still capped at DEFAULT_MAX_ITERATIONS (2)
  // content attempts, technical failures are still capped and consume no iteration, and an exhausted
  // subscription or logged-out CLI still parks the writer entirely. What the long interval actually
  // protected against was a tight retry loop, and every one of those conditions is now handled
  // explicitly. The idle spacing is kept unchanged for the case where nothing is queued.
  const spacingMinutes = pending > 0 ? RESUME_WRITER_PENDING_INTERVAL_MINUTES : RESUME_WRITER_INTERVAL_MINUTES;
  if (!isIntervalDue(getResumeWriterRuntimeState().lastStartedAt, spacingMinutes, now)) {
    return { outcome: "SKIPPED_INTERVAL_NOT_DUE" };
  }

  // RESUME_WRITER_BATCH_SIZE is a CEILING, never a target a caller can raise: a passed-in bound may
  // only lower it.
  const result = await runGuardedWriterPass({
    ...options,
    maxWorkflows: Math.min(options.maxWorkflows ?? RESUME_WRITER_BATCH_SIZE, RESUME_WRITER_BATCH_SIZE),
  });
  if (!result.ran) {
    return { outcome: "SKIPPED_LEASE_HELD", heldSince: result.heldSince };
  }
  if (result.error) {
    return { outcome: "FAILED", error: result.error };
  }
  return { outcome: "RAN", attempted: result.attempted, pending: result.pending, outcomes: result.outcomes };
}
