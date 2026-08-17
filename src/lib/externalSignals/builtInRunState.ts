import { getDb } from "@/db";

/**
 * Stage 13 Phase 11 — Built In's own run-state bookkeeping, deliberately mirroring
 * src/lib/scheduler/state.ts's exact pattern (same `settings` key/value table, same get/set shape) —
 * no new scheduling framework, no schema change. Kept namespaced under `external_run.built_in.*` so
 * it is entirely independent of `scheduler_runtime.*` (the ATS scan scheduler's own state): Built In
 * must run independently of ATS health/scheduling in both directions (Stage 11/12), and that
 * independence extends to not sharing — or being gated by — the ATS scheduler's runtime state either.
 *
 * IMPORTANT limitation, honestly documented rather than worked around: builtin.com's own search
 * endpoint only supports a rolling `daysSinceUpdated` window (Stage 11), not an arbitrary "jobs since
 * this specific date" query parameter. So `lastSuccessfulRunAt` cannot narrow the SOURCE-side fetch on
 * a follow-up run the way Phase 11 originally envisioned — the search always covers roughly the same
 * <=20-day window regardless of when CareerOps last ran. What DOES shrink on a follow-up run is real
 * WORK: Phase 10's cross-query dedup avoids re-fetching a listing's detail page twice in the same run,
 * and stageSecondaryJob's upsert is naturally idempotent, so a job seen again on a later run just
 * updates last_seen_at rather than doing anything wasteful. This state is still valuable as
 * observability (when did Built In last run, did it last succeed) and as the "is this the very first
 * run ever" signal used to label INITIAL_BACKFILL vs INCREMENTAL for reporting.
 */

const KEYS = {
  lastStartedAt: "external_run.built_in.last_started_at",
  lastCompletedAt: "external_run.built_in.last_completed_at",
  lastSuccessfulAt: "external_run.built_in.last_successful_at",
  lastFailedAt: "external_run.built_in.last_failed_at",
  lastError: "external_run.built_in.last_error",
} as const;

export interface BuiltInRunState {
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

export function getBuiltInRunState(): BuiltInRunState {
  return {
    lastStartedAt: getValue(KEYS.lastStartedAt),
    lastCompletedAt: getValue(KEYS.lastCompletedAt),
    lastSuccessfulAt: getValue(KEYS.lastSuccessfulAt),
    lastFailedAt: getValue(KEYS.lastFailedAt),
    lastError: getValue(KEYS.lastError),
  };
}

export function recordBuiltInRunStarted(now: Date = new Date()): void {
  setValue(KEYS.lastStartedAt, now.toISOString());
}

export function recordBuiltInRunSucceeded(now: Date = new Date()): void {
  const iso = now.toISOString();
  setValue(KEYS.lastCompletedAt, iso);
  setValue(KEYS.lastSuccessfulAt, iso);
  setValue(KEYS.lastError, null);
}

export function recordBuiltInRunFailed(error: string, now: Date = new Date()): void {
  setValue(KEYS.lastCompletedAt, now.toISOString());
  setValue(KEYS.lastFailedAt, now.toISOString());
  setValue(KEYS.lastError, error);
}

/** Reporting-only label — see this module's own doc comment for why this never actually narrows the
 *  source-side fetch window. */
export function describeBuiltInRunMode(state: BuiltInRunState): "INITIAL_BACKFILL" | "INCREMENTAL" {
  return state.lastSuccessfulAt === null ? "INITIAL_BACKFILL" : "INCREMENTAL";
}

/** Test-only reset. */
export function resetBuiltInRunStateForTests(): void {
  const db = getDb();
  for (const key of Object.values(KEYS)) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
