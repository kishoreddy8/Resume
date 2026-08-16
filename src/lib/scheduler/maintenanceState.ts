import { getDb } from "@/db";

/**
 * Independent runtime bookkeeping for the scheduler's lifecycle-maintenance phase — deliberately its
 * own "last run" timestamp, separate from scheduler_runtime.* (state.ts), so maintenance cadence
 * never has to be inferred from scan cadence. Same raw-key-in-`settings`-table pattern as state.ts,
 * for the same reason: written only by the scheduler tick itself, never by a user PATCH.
 */
const RUNTIME_KEYS = {
  lastStartedAt: "maintenance_runtime.last_started_at",
  lastCompletedAt: "maintenance_runtime.last_completed_at",
} as const;

function getValue(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setValue(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value);
}

export function getLastMaintenanceStartedAt(): string | null {
  return getValue(RUNTIME_KEYS.lastStartedAt);
}

export function recordMaintenanceStarted(now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastStartedAt, now.toISOString());
}

export function recordMaintenanceCompleted(now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastCompletedAt, now.toISOString());
}

/** Test-only reset, mirroring resetSchedulerRuntimeStateForTests in state.ts. */
export function resetMaintenanceRuntimeStateForTests(): void {
  const db = getDb();
  for (const key of Object.values(RUNTIME_KEYS)) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
