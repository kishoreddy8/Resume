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
  if (runtime.lastStartedAt === null) return "NO_DATA";

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
