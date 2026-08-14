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
  lastStartedAt: "scheduler_runtime.last_started_at",
  lastCompletedAt: "scheduler_runtime.last_completed_at",
  lastSuccessfulAt: "scheduler_runtime.last_successful_at",
  lastFailedAt: "scheduler_runtime.last_failed_at",
  lastError: "scheduler_runtime.last_error",
} as const;

export interface SchedulerRuntimeState {
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulAt: string | null;
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
    lastStartedAt: getValue(RUNTIME_KEYS.lastStartedAt),
    lastCompletedAt: getValue(RUNTIME_KEYS.lastCompletedAt),
    lastSuccessfulAt: getValue(RUNTIME_KEYS.lastSuccessfulAt),
    lastFailedAt: getValue(RUNTIME_KEYS.lastFailedAt),
    lastError: getValue(RUNTIME_KEYS.lastError),
  };
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
