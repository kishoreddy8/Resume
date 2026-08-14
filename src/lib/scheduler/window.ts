import type { AppSettings } from "@/lib/settings";

/**
 * Pure schedule-window logic (Phase 4 Stage 1) — no I/O, no DB access, fully unit-testable in
 * isolation from the lock/tick modules. Every function here takes `now`/state as explicit
 * parameters rather than reading the clock or the DB itself.
 */

export type SchedulerSettings = AppSettings["scheduler"];

/** Trivial, but kept as its own function for symmetry with the other pure checks and so callers
 *  never need to reach into `.enabled` directly. */
export function isEnabled(scheduler: SchedulerSettings): boolean {
  return scheduler.enabled;
}

/** Hour-of-day (0-23) for `date` in the given IANA timezone. Intl.DateTimeFormat with
 *  hour12:false can render midnight as "24" in some locales/environments — normalized to 0. */
function getHourInTimezone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const hourPart = parts.find((p) => p.type === "hour");
  const hour = hourPart ? Number.parseInt(hourPart.value, 10) : date.getUTCHours();
  return hour === 24 ? 0 : hour;
}

/** True when `now`'s local hour (in scheduler.timezone) falls in [windowStartHour, windowEndHour).
 *  The end hour is exclusive — a window of {start: 9, end: 17} covers 09:00 through 16:59. Overnight
 *  windows (start >= end) are rejected at the settings-validation layer (see appSettingsSchema's
 *  superRefine in src/lib/settings.ts), so this never needs to handle a wrap-past-midnight case. */
export function isWithinWindow(now: Date, scheduler: SchedulerSettings): boolean {
  const hour = getHourInTimezone(now, scheduler.timezone);
  return hour >= scheduler.windowStartHour && hour < scheduler.windowEndHour;
}

/** True when enough time has elapsed since the last scheduled attempt (any outcome, not just a
 *  success — deliberately conservative: a repeatedly-failing scan must not be retried faster than
 *  intervalMinutes, which would turn a real outage into a retry storm). `lastStartedAt === null`
 *  (never run) is always due. */
export function isIntervalDue(lastStartedAt: string | null, intervalMinutes: number, now: Date = new Date()): boolean {
  if (!lastStartedAt) return true;
  const elapsedMinutes = (now.getTime() - new Date(lastStartedAt).getTime()) / 60_000;
  return elapsedMinutes >= intervalMinutes;
}

/** Convenience: the single boolean a tick actually needs — enabled AND within window AND interval
 *  due. Kept as a named function (rather than inlining `&&` at every call site) so tick.ts's
 *  decision reads as one clear check, and so tests can exercise the combination directly. */
export function isSchedulerDueToRun(scheduler: SchedulerSettings, lastStartedAt: string | null, now: Date = new Date()): boolean {
  return isEnabled(scheduler) && isWithinWindow(now, scheduler) && isIntervalDue(lastStartedAt, scheduler.intervalMinutes, now);
}

const NEXT_RUN_SEARCH_STEP_MINUTES = 15;
// 8 days of 15-minute steps — generous upper bound so a valid (non-overnight) window is always
// found well within the search, while keeping the loop trivially cheap (at most ~768 iterations).
const NEXT_RUN_SEARCH_MAX_STEPS = 8 * 24 * (60 / NEXT_RUN_SEARCH_STEP_MINUTES);

/**
 * Best-effort "next time a tick would actually run a scan" for the status API's observability
 * value only — never consulted by the tick itself, which always re-derives its own decision fresh
 * via isSchedulerDueToRun. Returns null if the scheduler is disabled, or (should not happen for a
 * valid, schema-validated window) if no eligible instant is found within the search bound.
 */
export function nextEligibleRunAt(scheduler: SchedulerSettings, lastStartedAt: string | null, now: Date = new Date()): string | null {
  if (!scheduler.enabled) return null;

  const intervalReadyAtMs = lastStartedAt
    ? new Date(lastStartedAt).getTime() + scheduler.intervalMinutes * 60_000
    : now.getTime();
  let candidateMs = Math.max(intervalReadyAtMs, now.getTime());

  for (let i = 0; i < NEXT_RUN_SEARCH_MAX_STEPS; i++) {
    const candidate = new Date(candidateMs);
    if (isWithinWindow(candidate, scheduler)) {
      return candidate.toISOString();
    }
    candidateMs += NEXT_RUN_SEARCH_STEP_MINUTES * 60_000;
  }
  return null;
}
