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
  if (!isIntervalDue(getResumeWriterRuntimeState().lastStartedAt, RESUME_WRITER_INTERVAL_MINUTES, now)) {
    return { outcome: "SKIPPED_INTERVAL_NOT_DUE" };
  }

  // Cheap read-only pre-check so an idle system never even takes the lease. Not a substitute for the
  // lease: runGuardedWriterPass re-reads the pending list under it.
  if (listWorkflowsAwaitingWriter().length === 0) {
    return { outcome: "SKIPPED_NO_PENDING_WORKFLOWS" };
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
