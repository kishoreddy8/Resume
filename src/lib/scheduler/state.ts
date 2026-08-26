import { getDb } from "@/db";

/**
 * Program-only scheduler runtime bookkeeping (Phase 4 Stage 1). Deliberately kept OUT of
 * appSettingsSchema/updateAppSettings (src/lib/settings.ts, src/db/queries/settings.ts) — these
 * fields are written only by the scheduler tick itself (src/lib/scheduler/tick.ts), never by a user
 * PATCH, and are exposed read-only via GET /api/scheduler. They share the underlying `settings`
 * table (same key/value/updated_at shape) but use their own raw keys outside STORAGE_KEYS, so there
 * is no path for a client to overwrite them through the settings API.
 *
 * The scan lock itself (scheduler_lock.acquired_at) is a separate concern — see lock.ts — because it
 * needs one atomic conditional UPDATE, not a plain get/set pair. These fields are purely descriptive
 * status and are only ever written by whichever process currently holds that lock, so no equivalent
 * atomicity requirement applies here.
 */

const RUNTIME_KEYS = {
  lastEvaluatedAt: "scheduler_runtime.last_evaluated_at",
  lastStartedAt: "scheduler_runtime.last_started_at",
  lastCompletedAt: "scheduler_runtime.last_completed_at",
  lastSuccessfulAt: "scheduler_runtime.last_successful_at",
  lastScanSucceededAt: "scheduler_runtime.last_scan_succeeded_at",
  lastFailedAt: "scheduler_runtime.last_failed_at",
  lastError: "scheduler_runtime.last_error",
} as const;

export interface SchedulerRuntimeState {
  /**
   * ADMIN-OPS-1 — when the scan tick last EVALUATED, whatever it decided to do.
   *
   * WHY THIS IS SEPARATE FROM lastStartedAt. Every other field here describes a scan ATTEMPT, and
   * all of them are written after the lock is acquired. But the tick returns early — before any of
   * them — whenever it is disabled, outside its window, not yet due, or the lock is held. Those are
   * the tick working correctly, and they left no trace at all, so "the timers are dead" was
   * indistinguishable from "there was legitimately nothing to do". A subsystem cannot be reported as
   * alive on the strength of a decision it never recorded making.
   *
   * This field is that record, and ONLY that: it says the tick function ran and reached a verdict.
   * It says nothing about whether a scan happened — lastStartedAt/lastSuccessfulAt still own that,
   * and nothing about their meaning changes. The resume writer already solved this exact problem
   * the same way (resume_writer.last_tick_at, see writerState.ts) and this brings the scan tick in
   * line with that established precedent rather than inventing a second mechanism.
   */
  lastEvaluatedAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulAt: string | null;
  /**
   * ADMIN-OPS-2 — when a scan last actually completed against at least one company.
   *
   * WHY THIS IS NOT lastSuccessfulAt. That field is stamped by recordSchedulerTickSucceeded, which
   * the tick calls in TWO situations: after a real scan finishes, and when it finds zero scan-ready
   * companies and returns SKIPPED_NO_COMPANIES having scanned nothing. Both are legitimate outcomes,
   * but only one is useful work, and collapsing them means "the scanner last succeeded at 14:02" can
   * be true of a system that has not fetched a single job all day.
   *
   * This field records only the second case: a scan that ran. It is the difference between the tick
   * being ALIVE and the scanner having DONE something, and Admin needs both separately — a live tick
   * with no successful scan for a day is exactly the state a health surface must be able to describe.
   */
  lastScanSucceededAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
}

function getValue(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setValue(key: string, value: string | null): void {
  const db = getDb();
  if (value === null) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
}

export function getSchedulerRuntimeState(): SchedulerRuntimeState {
  return {
    lastEvaluatedAt: getValue(RUNTIME_KEYS.lastEvaluatedAt),
    lastStartedAt: getValue(RUNTIME_KEYS.lastStartedAt),
    lastCompletedAt: getValue(RUNTIME_KEYS.lastCompletedAt),
    lastSuccessfulAt: getValue(RUNTIME_KEYS.lastSuccessfulAt),
    lastScanSucceededAt: getValue(RUNTIME_KEYS.lastScanSucceededAt),
    lastFailedAt: getValue(RUNTIME_KEYS.lastFailedAt),
    lastError: getValue(RUNTIME_KEYS.lastError),
  };
}

/**
 * ADMIN-OPS-1 — called at the TOP of every scan-tick evaluation, before any decision is made.
 *
 * Deliberately unconditional: a tick that decides to do nothing is still a tick that ran, and that
 * is precisely the case the old bookkeeping could not express. Writing this before the enabled /
 * window / interval / lock checks is the whole point — moving it below any of them would restore the
 * blind spot it exists to close.
 *
 * This is one row in the `settings` key/value table, under the same `scheduler_runtime.*` namespace
 * the other fields already use, outside STORAGE_KEYS — so it is no more writable through the
 * settings API than its siblings, and it needs no schema change.
 */
export function recordSchedulerTickEvaluated(now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastEvaluatedAt, now.toISOString());
}

/** Called once, right before a tick attempts to run a scan (after the lock is acquired). */
export function recordSchedulerTickStarted(now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastStartedAt, now.toISOString());
}

/** Called when a scheduled scan attempt completes without throwing. Clears lastError — a fresh
 *  success supersedes any previously recorded failure. */
export function recordSchedulerTickSucceeded(now: Date = new Date()): void {
  const iso = now.toISOString();
  setValue(RUNTIME_KEYS.lastCompletedAt, iso);
  setValue(RUNTIME_KEYS.lastSuccessfulAt, iso);
  setValue(RUNTIME_KEYS.lastError, null);
}

/**
 * ADMIN-OPS-2 — called ONLY when a scan actually ran against at least one company and completed.
 *
 * Deliberately separate from recordSchedulerTickSucceeded: a tick that legitimately found nothing to
 * scan still succeeded as a tick, and must not be recorded as the scanner having worked.
 */
export function recordScanSucceeded(now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastScanSucceededAt, now.toISOString());
}

/** Called when a scheduled scan attempt throws. lastSuccessfulAt is left untouched — it tracks the
 *  most recent SUCCESS specifically, not the most recent attempt (that's lastCompletedAt). */
export function recordSchedulerTickFailed(error: string, now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastCompletedAt, now.toISOString());
  setValue(RUNTIME_KEYS.lastFailedAt, now.toISOString());
  setValue(RUNTIME_KEYS.lastError, error);
}

/** Test-only reset — clears every runtime-state row so a test starts from a clean, "never run"
 *  baseline regardless of what earlier tests in the same process wrote. */
export function resetSchedulerRuntimeStateForTests(): void {
  const db = getDb();
  for (const key of Object.values(RUNTIME_KEYS)) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
