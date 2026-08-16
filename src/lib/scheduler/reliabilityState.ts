import { getDb } from "@/db";

/**
 * Independent runtime bookkeeping for the scheduler's Connector Reliability phase — its own "last
 * run" timestamp, separate from scan cadence (state.ts) AND from lifecycle-maintenance cadence
 * (maintenanceState.ts). Same raw-key-in-`settings`-table pattern as both of those, for the same
 * reason: written only by the scheduler tick itself, never by a user PATCH, and deliberately not a
 * new table for a single timestamp pair.
 */
const RUNTIME_KEYS = {
  lastStartedAt: "reliability_runtime.last_started_at",
  lastCompletedAt: "reliability_runtime.last_completed_at",
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

export function getLastReliabilityRunStartedAt(): string | null {
  return getValue(RUNTIME_KEYS.lastStartedAt);
}

export function recordReliabilityRunStarted(now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastStartedAt, now.toISOString());
}

export function recordReliabilityRunCompleted(now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastCompletedAt, now.toISOString());
}

/** Test-only reset, mirroring resetMaintenanceRuntimeStateForTests in maintenanceState.ts. */
export function resetReliabilityRuntimeStateForTests(): void {
  const db = getDb();
  for (const key of Object.values(RUNTIME_KEYS)) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
