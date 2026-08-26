import type { SchedulerHost } from "@/lib/scheduler/host";
import type { SchedulerRuntimeState } from "@/lib/scheduler/state";
import type { SchedulerSettings } from "@/lib/scheduler/window";

/**
 * Phase 4 Stage 6 — pure, DB-free health classification for the Operations dashboard. Every
 * function here takes already-fetched facts and returns a deterministic status; no I/O, no clock
 * reads (an explicit `now` is always threaded through), fully unit-testable in isolation, same
 * convention as src/lib/scheduler/window.ts's pure rule functions.
 *
 * No numeric "health score" is computed anywhere in this module — the Stage 6 spec explicitly
 * rejects a fabricated composite like "94/100" in favor of one deterministic label per subsystem.
 */
export type HealthStatus = "HEALTHY" | "WARNING" | "ERROR" | "DISABLED" | "NO_DATA";

// --- Scheduler ----------------------------------------------------------------------------------

export interface SchedulerHealthInput {
  settings: SchedulerSettings;
  runtime: SchedulerRuntimeState;
  now?: Date;
}

/** Missing more than this many consecutive intervals since the last attempt is "overdue" — one
 *  missed cycle can be a normal scheduling/window edge case, two in a row is worth flagging. */
const OVERDUE_INTERVAL_MULTIPLE = 2;

/**
 * ADMIN-OPS-1 — how long without a tick EVALUATION before the scan scheduler is reported as not
 * running.
 *
 * Deliberately not a new number: this mirrors RESUME_WRITER_TICK_LIVENESS_TIMEOUT_MINUTES
 * (src/lib/resumeQuality/writers/writerHealth.ts) exactly, because both ticks are evaluated by the
 * same 60-second timer in src/instrumentation.ts and therefore have identical liveness semantics —
 * five missed evaluations, long enough not to false-alarm on a busy event loop, short enough to tell
 * the truth when nothing is hosting the scheduler at all. Reusing the established threshold keeps
 * one operational meaning rather than two competing ones.
 */
export const SCHEDULER_TICK_LIVENESS_TIMEOUT_MINUTES = 5;

/**
 * ADMIN-OPS-1.1 — how a persisted liveness timestamp is read, including when it is unusable.
 *
 * These values live in the `settings` key/value table as free text. A truncated write, a manual
 * edit, or a clock-skewed future value all produce something that is not a usable observation, and
 * the arithmetic on it silently yields NaN. Every NaN comparison is false, so a naive
 * `minutesSince > threshold` check answers "not stale" for a corrupt value and the caller then
 * concludes HEALTHY — a green verdict derived from unreadable data, which is precisely the
 * false-green this phase exists to remove.
 *
 * Unreadable is therefore reported as "no usable observation", not as fresh and not as stale: we
 * cannot prove the scheduler is alive, and we equally cannot prove it is dead, so the honest answer
 * is that nothing was observed. A future timestamp is treated the same way — it cannot be evidence
 * of a past evaluation. Mirrors the Number.isFinite guard `subsystemHealth.isStale` already applies.
 */
type LivenessReading = "FRESH" | "STALE" | "UNUSABLE";

function readLiveness(observedAt: string | null, now: Date, thresholdMinutes: number): LivenessReading {
  if (observedAt === null) return "UNUSABLE";
  const observed = new Date(observedAt).getTime();
  if (!Number.isFinite(observed)) return "UNUSABLE";
  const minutesSince = (now.getTime() - observed) / 60_000;
  if (minutesSince < 0) return "UNUSABLE";
  return minutesSince > thresholdMinutes ? "STALE" : "FRESH";
}

/**
 * Rules, in order:
 *   1. disabled                                                -> DISABLED
 *   2. never attempted (lastStartedAt === null)                 -> NO_DATA
 *   3. most recent attempt ended in failure                     -> ERROR
 *      (lastFailedAt is set AND is not older than lastSuccessfulAt — i.e. failure is the LATEST
 *      outcome, not a stale failure a later success has since superseded)
 *   4. overdue: more than OVERDUE_INTERVAL_MULTIPLE configured intervals have elapsed since the
 *      last attempt                                              -> WARNING
 *      (a raw elapsed-time check against lastStartedAt, not src/lib/scheduler/window.ts's
 *      nextEligibleRunAt — that helper clamps its result to never return a time before `now`, by
 *      design, since it exists to answer "when next", not "are we late", so it cannot itself detect
 *      overdue-ness; this is a genuinely different question, not a duplicate status calculation)
 *   5. otherwise                                                 -> HEALTHY
 * A currently-held, non-stale scan lock does not by itself change this — a scan genuinely in
 * progress is the expected/working state, not a degraded one.
 */
export function classifySchedulerHealth(input: SchedulerHealthInput): HealthStatus {
  const { settings, runtime } = input;
  const now = input.now ?? new Date();

  if (!settings.enabled) return "DISABLED";

  /* ADMIN-OPS-1 — liveness before outcome. `lastEvaluatedAt` is written by every tick evaluation,
   * including the ones that decide not to scan (see scheduler/state.ts), so a stale value means the
   * tick function itself has stopped being called — nothing is hosting the scheduler. That is a
   * different and more serious fact than "the last scan failed", and it has to be checked first:
   * the outcome fields below all describe the last ATTEMPT, and a long-dead scheduler can still be
   * carrying a perfectly successful one. */
  const liveness = readLiveness(runtime.lastEvaluatedAt, now, SCHEDULER_TICK_LIVENESS_TIMEOUT_MINUTES);
  if (liveness === "STALE") return "ERROR";

  if (runtime.lastStartedAt === null) {
    /* Enabled, and the tick is demonstrably evaluating — it simply has not been due yet. That is a
     * working scheduler with nothing to show, not an absence of evidence. Without a usable
     * evaluation there is genuinely nothing observed, which is NO_DATA rather than a fault. */
    return liveness === "FRESH" ? "HEALTHY" : "NO_DATA";
  }

  const lastFailureIsLatest =
    runtime.lastFailedAt !== null && (runtime.lastSuccessfulAt === null || runtime.lastFailedAt > runtime.lastSuccessfulAt);
  if (lastFailureIsLatest) return "ERROR";

  const elapsedMinutes = (now.getTime() - new Date(runtime.lastStartedAt).getTime()) / 60_000;
  if (elapsedMinutes > settings.intervalMinutes * OVERDUE_INTERVAL_MULTIPLE) return "WARNING";

  return "HEALTHY";
}

// --- Scanning -------------------------------------------------------------------------------------

export interface ScanningWindowCounts {
  runs: number;
  successCount: number;
  partialCount: number;
  failedCount: number;
}

export interface ScanningHealthInput {
  window: ScanningWindowCounts;
  schedulerEnabled: boolean;
}

/**
 * Scoped to the SAME window the caller is displaying (see the dashboard's window selector) — a
 * subsystem that scanned successfully 40 days ago says nothing about whether it is working today.
 *   - zero runs in the window, scheduler enabled  -> WARNING (should have run something)
 *   - zero runs in the window, scheduler disabled -> NO_DATA (expected silence, not a fault)
 *   - runs exist, zero successes, at least one failure -> ERROR
 *   - runs exist, any failure or partial            -> WARNING
 *   - runs exist, all successes                      -> HEALTHY
 */
export function classifyScanningHealth(input: ScanningHealthInput): HealthStatus {
  const { runs, successCount, failedCount, partialCount } = input.window;
  if (runs === 0) return input.schedulerEnabled ? "WARNING" : "NO_DATA";
  if (successCount === 0 && failedCount > 0) return "ERROR";
  if (failedCount > 0 || partialCount > 0) return "WARNING";
  return "HEALTHY";
}

// --- Connectors -----------------------------------------------------------------------------------

export interface ConnectorHealthCounts {
  healthy: number;
  degraded: number;
  down: number;
  unknown: number;
}

/**
 *   - no companies at all, or every company still 'unknown' (never scanned)  -> NO_DATA
 *   - any 'down'                                                              -> ERROR
 *   - no 'down' but any 'degraded'                                           -> WARNING
 *   - otherwise (only healthy/unknown, zero degraded/down)                    -> HEALTHY
 */
export function classifyConnectorHealth(counts: ConnectorHealthCounts): HealthStatus {
  const total = counts.healthy + counts.degraded + counts.down + counts.unknown;
  if (total === 0 || counts.healthy + counts.degraded + counts.down === 0) return "NO_DATA";
  if (counts.down > 0) return "ERROR";
  if (counts.degraded > 0) return "WARNING";
  return "HEALTHY";
}

// --- Matching ---------------------------------------------------------------------------------

export interface MatchingWindowCounts {
  runs: number;
  jobsErrored: number;
}

/**
 * A per-job error inside a match_runs batch is already isolated by design (Stage 2/5: one job's
 * failure never aborts the batch — see incrementalMatch.ts/rematchCandidate.ts) — there is no
 * "the whole matching pipeline is down" failure mode to detect from this data, so this rule has no
 * ERROR tier, only WARNING for elevated per-job failures.
 *   - zero match_runs in the window -> NO_DATA
 *   - any errored jobs in the window -> WARNING
 *   - otherwise                       -> HEALTHY
 */
export function classifyMatchingHealth(window: MatchingWindowCounts): HealthStatus {
  if (window.runs === 0) return "NO_DATA";
  if (window.jobsErrored > 0) return "WARNING";
  return "HEALTHY";
}

// --- Notifications ----------------------------------------------------------------------------

/**
 * IMPORTANT LIMITATION: notification-generation failures are caught and returned in-memory only
 * (see src/lib/notifications/generateNotifications.ts / rematchCandidate.ts's try/catch) — nothing
 * about a failed generation attempt is ever persisted. There is therefore no stored signal this
 * function could use to detect a degraded notification pipeline; it can only tell whether the
 * pipeline has ever produced output at all.
 *   - zero notifications ever exist (system-wide) -> NO_DATA
 *   - otherwise                                    -> HEALTHY
 */
export function classifyNotificationsHealth(totalNotificationsEverCreated: number): HealthStatus {
  return totalNotificationsEverCreated === 0 ? "NO_DATA" : "HEALTHY";
}

// --- Resume / quality pipeline ------------------------------------------------------------------

export interface ResumePipelineWindowCounts {
  workflows: number;
  failed: number;
}

/**
 *   - zero workflows ever -> NO_DATA
 *   - any FAILED           -> WARNING (a human-review case is an expected outcome of the state
 *                              machine, not a pipeline outage — never ERROR from this alone)
 *   - otherwise             -> HEALTHY
 */
export function classifyResumePipelineHealth(counts: ResumePipelineWindowCounts): HealthStatus {
  if (counts.workflows === 0) return "NO_DATA";
  if (counts.failed > 0) return "WARNING";
  return "HEALTHY";
}

// --- System (scheduler host) --------------------------------------------------------------------

export interface SystemHealthInput {
  /** Which process is CONFIGURED to run the scheduled ticks — see src/lib/scheduler/host.ts. */
  schedulerHost: SchedulerHost;
  /** Whether the standalone background worker process is alive and owns its lock. */
  workerRunning: boolean;
  /** Whether that worker has ever written a status file — distinguishes "never started" from "died". */
  workerEverReported: boolean;
  /** Web-process tick liveness: when the scan tick last evaluated anything. */
  lastEvaluatedAt: string | null;
  /** MISMATCH is fail-closed for the writer and outranks every other consideration. */
  runtimeCompatibility: "MATCH" | "MISMATCH" | "UNKNOWN";
  now?: Date;
}

/**
 * ADMIN-OPS-1 — is the process that is SUPPOSED to be running scheduled work actually running?
 *
 * THE DEFECT THIS REPLACES. Admin previously answered this with `worker.running ? HEALTHY : DEGRADED`
 * (src/lib/admin/overview.ts). `worker.running` describes the standalone background worker — but the
 * default and fully supported host is "web", where scheduled work runs inside the Next.js process and
 * there is deliberately NO separate worker to find. On that configuration the check could only ever
 * fail, so a correctly-installed, perfectly healthy system reported DEGRADED permanently. The
 * question was never "is a worker running"; it is "is the CONFIGURED host running", and the two only
 * coincide in one of the three supported modes.
 *
 * Which evidence is authoritative therefore depends on the configured host, and nothing else:
 *   worker -> the worker's own pid/lock liveness
 *   web    -> the web process's tick-evaluation liveness
 *   none   -> no host is configured; silence is the intended behaviour, not a fault
 *
 * A MISMATCH is checked first because it is fail-closed regardless of host: the writer refuses to
 * process work at all, so a live host is not the interesting fact.
 */
export function classifySystemHealth(input: SystemHealthInput): HealthStatus {
  const now = input.now ?? new Date();

  if (input.runtimeCompatibility === "MISMATCH") return "ERROR";

  switch (input.schedulerHost) {
    case "none":
      /* An explicit "nobody runs scheduled work" choice. Nothing is broken, and reporting a fault
       * here would train an operator to ignore the field. */
      return "DISABLED";

    case "worker":
      if (input.workerRunning) return "HEALTHY";
      /* Configured to use a worker that is not running. If it has never reported at all, the setup
       * was simply never completed — that is an absence of evidence, not proof of a crash. */
      return input.workerEverReported ? "ERROR" : "NO_DATA";

    case "web": {
      /* The web process owns the ticks here, so the worker's absence is expected and says nothing.
       * Liveness comes from whether the tick is still evaluating. An unusable timestamp is NO_DATA,
       * never HEALTHY — see readLiveness. */
      switch (readLiveness(input.lastEvaluatedAt, now, SCHEDULER_TICK_LIVENESS_TIMEOUT_MINUTES)) {
        case "FRESH":
          return "HEALTHY";
        case "STALE":
          return "ERROR";
        case "UNUSABLE":
          return "NO_DATA";
      }
    }
  }
}
