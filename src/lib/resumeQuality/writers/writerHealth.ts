import { getAppSettings } from "@/db/queries/settings";
import { listWorkflowsAwaitingWriter } from "@/db/queries/resumeQualityWorkflows";
import { isWithinWindow, nextEligibleRunAt } from "@/lib/scheduler/window";
import { RESUME_WRITER_BATCH_SIZE, RESUME_WRITER_INTERVAL_MINUTES } from "./tick";
import { getResumeWriterLeaseStatus, getResumeWriterRuntimeState, type PassOutcomeSummary } from "./writerState";

/**
 * Stage 26 — the writer's health, derived ONLY from evidence that already exists: the machine-wide
 * lease (writerState.ts), the tick's own last-evaluated stamp, the last completed pass's recorded
 * outcomes, and the operator's scheduler settings. Nothing here infers "the writer is working"
 * from a workflow's status — an IMPROVEMENT_RUNNING workflow means "a resume needs writing", which
 * says nothing at all about whether anything is currently writing it, and presenting it as progress
 * is exactly the false liveness this model exists to avoid.
 *
 * There is deliberately no "is the worker process alive?" concept any more. Since Stage 26 the writer
 * is not a permanently-running process — it is a bounded pass on the app's own scheduled tick — so
 * the honest questions are "is the writer scheduler running and allowed to run?" (lastTickAt +
 * enabled + window) and "what happened on the last pass?" (recorded outcomes), not "is a daemon up?".
 */

export type ResumeWriterHealthState =
  /** A pass holds the lease right now — a resume is genuinely being written. */
  | "PROCESSING"
  /** Work is queued and the scheduler is healthy and allowed to run; it is between attempts. */
  | "WAITING_FOR_NEXT_ATTEMPT"
  /** Scheduler healthy, nothing queued. */
  | "IDLE"
  /** Automatic tailoring is switched off in Settings — approved work will sit untouched. */
  | "UNAVAILABLE_SCHEDULER_DISABLED"
  /** Enabled, but outside the operator's configured automation window. */
  | "WAITING_OUTSIDE_WINDOW"
  /** Nothing has evaluated the writer tick recently — no scheduler is running in this process. */
  | "UNAVAILABLE_NOT_RUNNING"
  /** The last pass could not produce a resume for technical reasons (CLI failure/timeout/malformed
   *  output, or a handoff that exhausted its bounded technical retries). Never a quality verdict. */
  | "TECHNICAL_FAILURE";

/** How long without a tick evaluation before the writer scheduler is reported as not running. The
 *  tick is evaluated every TICK_CHECK_INTERVAL_MS (60s) by src/instrumentation.ts, so 5 minutes is
 *  five missed evaluations — long enough to never false-alarm on a busy event loop, short enough to
 *  tell the truth when the app is being served without instrumentation having started the timers. */
export const RESUME_WRITER_TICK_LIVENESS_TIMEOUT_MINUTES = 5;

const TECHNICAL_OUTCOMES = new Set(["TECHNICAL_FAILURE", "ERROR", "SKIPPED_MAX_ATTEMPTS"]);

export interface ResumeWriterHealth {
  state: ResumeWriterHealthState;
  /** Short, user-facing sentence for the UI. Describes scheduler health and the last real pass —
   *  never a process-liveness claim the architecture can no longer support. */
  detail: string;
  schedulerEnabled: boolean;
  withinWindow: boolean;
  intervalMinutes: number;
  batchSize: number;
  /** Workflows currently approved and awaiting a writer, across all candidates. */
  pendingWorkflowCount: number;
  /** Last time anything evaluated the writer tick at all, run or not. */
  lastTickAt: string | null;
  lastPassStartedAt: string | null;
  lastPassCompletedAt: string | null;
  lastPassDurationMs: number | null;
  lastPassOutcome: string | null;
  lastPassError: string | null;
  /** Best-effort next instant a pass could run, for display only — the tick always re-decides. */
  nextAttemptAt: string | null;
  /** Present while a pass holds the lease. */
  processingSince: string | null;
  /** The last recorded outcome for one specific workflow, when the caller asked about one. */
  workflowOutcome: PassOutcomeSummary | null;
}

export function getResumeWriterHealth(now: Date = new Date(), workflowId?: number): ResumeWriterHealth {
  const settings = getAppSettings();
  const runtime = getResumeWriterRuntimeState();
  const lease = getResumeWriterLeaseStatus(now);
  const pendingWorkflowCount = listWorkflowsAwaitingWriter().length;
  const withinWindow = isWithinWindow(now, settings.scheduler);

  const workflowOutcome =
    typeof workflowId === "number"
      ? (runtime.lastSummary?.outcomes.find((o) => o.workflowId === workflowId) ?? null)
      : null;

  const tickIsLive =
    runtime.lastTickAt !== null &&
    now.getTime() - new Date(runtime.lastTickAt).getTime() <= RESUME_WRITER_TICK_LIVENESS_TIMEOUT_MINUTES * 60_000;

  const nextAttemptAt = settings.scheduler.enabled
    ? nextEligibleRunAt(
        // Reuses the existing pure window/interval search rather than re-deriving one: only the
        // interval differs from the scan scheduler's, and the writer's own is substituted here.
        { ...settings.scheduler, intervalMinutes: RESUME_WRITER_INTERVAL_MINUTES },
        runtime.lastStartedAt,
        now
      )
    : null;

  const lastPassHadTechnicalFailure =
    runtime.lastOutcome === "TECHNICAL_FAILURE" ||
    runtime.lastOutcome === "FAILED" ||
    (runtime.lastSummary?.outcomes ?? []).some((o) => TECHNICAL_OUTCOMES.has(o.outcome));

  const base = {
    schedulerEnabled: settings.scheduler.enabled,
    withinWindow,
    intervalMinutes: RESUME_WRITER_INTERVAL_MINUTES,
    batchSize: RESUME_WRITER_BATCH_SIZE,
    pendingWorkflowCount,
    lastTickAt: runtime.lastTickAt,
    lastPassStartedAt: runtime.lastStartedAt,
    lastPassCompletedAt: runtime.lastCompletedAt,
    lastPassDurationMs: runtime.lastDurationMs,
    lastPassOutcome: runtime.lastOutcome,
    lastPassError: runtime.lastError,
    nextAttemptAt,
    processingSince: lease.held ? lease.trueAcquiredAt : null,
    workflowOutcome,
  };

  if (lease.held) {
    return { ...base, state: "PROCESSING", detail: "A resume writer pass is running now." };
  }
  if (!tickIsLive) {
    return {
      ...base,
      state: "UNAVAILABLE_NOT_RUNNING",
      detail:
        runtime.lastTickAt === null
          ? "The resume writer scheduler has never run in this environment. Approved work will not be picked up automatically until the app is running."
          : `The resume writer scheduler has not been evaluated since ${runtime.lastTickAt}. Approved work is not being picked up right now.`,
    };
  }
  if (!settings.scheduler.enabled) {
    return {
      ...base,
      state: "UNAVAILABLE_SCHEDULER_DISABLED",
      detail: "Automatic tailoring is off. Enable background automation in Settings for approved jobs to be written automatically.",
    };
  }
  if (lastPassHadTechnicalFailure && pendingWorkflowCount > 0) {
    // A provider outage is reported as exactly that. Without this distinction the same panel would
    // imply something about the resume or CareerOps needed attention, when the only true statement is
    // "Anthropic could not serve the request; it will be retried" — the real-corpus failure was an
    // HTTP 529 Overloaded.
    const providerOutage = (runtime.lastSummary?.outcomes ?? []).some((o) => o.providerUnavailable === true);
    return {
      ...base,
      state: "TECHNICAL_FAILURE",
      detail: providerOutage
        ? `The Claude service was temporarily unavailable on the last writer pass${runtime.lastError ? ` (${runtime.lastError})` : ""}. Nothing is wrong with this resume or with CareerOps — the writer retries on its own schedule, and no quality iteration was used.`
        : `The last writer pass failed for technical reasons${runtime.lastError ? `: ${runtime.lastError}` : "."} This is not a quality verdict — no resume was produced and no quality iteration was used.`,
    };
  }
  if (!withinWindow) {
    return {
      ...base,
      state: "WAITING_OUTSIDE_WINDOW",
      detail: `Outside the configured automation window (${settings.scheduler.windowStartHour}:00-${settings.scheduler.windowEndHour}:00 ${settings.scheduler.timezone}). Queued work runs at the next window.`,
    };
  }
  if (pendingWorkflowCount > 0) {
    return {
      ...base,
      state: "WAITING_FOR_NEXT_ATTEMPT",
      detail: `${pendingWorkflowCount} approved job${pendingWorkflowCount === 1 ? "" : "s"} queued. The writer runs at most ${RESUME_WRITER_BATCH_SIZE} per pass, every ${RESUME_WRITER_INTERVAL_MINUTES} minutes.`,
    };
  }
  return { ...base, state: "IDLE", detail: "Writer scheduler is healthy with nothing queued." };
}
