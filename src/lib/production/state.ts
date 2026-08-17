import { getDb } from "@/db";
import type { ProductionCycleStatus, ProductionCycleSummary } from "./types";

/**
 * Production Cycle Lock and Runtime State persistence.
 * Reuses the existing `settings` table (key TEXT PRIMARY KEY) with atomic conditional updates.
 *
 * Lock key: "production_cycle_lock.acquired_at"
 * Runtime keys:
 *   - "production_cycle.last_started_at"
 *   - "production_cycle.last_completed_at"
 *   - "production_cycle.last_successful_at"
 *   - "production_cycle.last_failed_at"
 *   - "production_cycle.last_status"
 *   - "production_cycle.last_duration_ms"
 *   - "production_cycle.last_summary_json"
 *   - "production_cycle.last_error"
 */

const LOCK_KEY = "production_cycle_lock.acquired_at";
export const STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES = 180;

const RUNTIME_KEYS = {
  lastStartedAt: "production_cycle.last_started_at",
  lastCompletedAt: "production_cycle.last_completed_at",
  lastSuccessfulAt: "production_cycle.last_successful_at",
  lastFailedAt: "production_cycle.last_failed_at",
  lastStatus: "production_cycle.last_status",
  lastDurationMs: "production_cycle.last_duration_ms",
  lastSummaryJson: "production_cycle.last_summary_json",
  lastError: "production_cycle.last_error",
} as const;

export interface LockAcquireResult {
  acquired: boolean;
  heldSince?: string;
}

export interface ProductionLockStatus {
  held: boolean;
  acquiredAt: string | null;
  stale: boolean;
}

export interface ProductionCycleRuntimeState {
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulAt: string | null;
  lastFailedAt: string | null;
  lastStatus: ProductionCycleStatus | null;
  lastDurationMs: number | null;
  lastSummary: ProductionCycleSummary | null;
  lastError: string | null;
}

function staleThresholdIso(now: Date): string {
  return new Date(now.getTime() - STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES * 60_000).toISOString();
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

/**
 * Attempts to acquire the production cycle lock.
 * Succeeds if lock is free or held by a stale attempt.
 */
export function acquireProductionCycleLock(now: Date = new Date()): LockAcquireResult {
  const db = getDb();
  const nowIso = now.toISOString();

  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, '', datetime('now')) ON CONFLICT(key) DO NOTHING`
  ).run(LOCK_KEY);

  const result = db
    .prepare(
      `UPDATE settings SET value = ?, updated_at = datetime('now')
       WHERE key = ? AND (value = '' OR value < ?)`
    )
    .run(nowIso, LOCK_KEY, staleThresholdIso(now));

  if (result.changes === 1) {
    return { acquired: true };
  }

  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(LOCK_KEY) as
    | { value: string }
    | undefined;
  return { acquired: false, heldSince: row?.value || undefined };
}

/**
 * Releases the production cycle lock unconditionally.
 */
export function releaseProductionCycleLock(): void {
  getDb().prepare(`UPDATE settings SET value = '', updated_at = datetime('now') WHERE key = ?`).run(LOCK_KEY);
}

/**
 * Checks current production cycle lock status.
 */
export function getProductionCycleLockStatus(now: Date = new Date()): ProductionLockStatus {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(LOCK_KEY) as
    | { value: string }
    | undefined;
  const acquiredAt = row?.value || null;
  if (!acquiredAt) return { held: false, acquiredAt: null, stale: false };
  const stale = acquiredAt < staleThresholdIso(now);
  return { held: !stale, acquiredAt, stale };
}

export function recordProductionCycleStarted(now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastStartedAt, now.toISOString());
}

export function recordProductionCycleCompleted(summary: ProductionCycleSummary, now: Date = new Date()): void {
  const iso = now.toISOString();
  setValue(RUNTIME_KEYS.lastCompletedAt, iso);
  setValue(RUNTIME_KEYS.lastStatus, summary.status);
  setValue(RUNTIME_KEYS.lastDurationMs, String(summary.durationMs));
  setValue(RUNTIME_KEYS.lastSummaryJson, JSON.stringify(summary));

  if (summary.status === "READY" || summary.status === "DEGRADED") {
    setValue(RUNTIME_KEYS.lastSuccessfulAt, iso);
    setValue(RUNTIME_KEYS.lastError, null);
  } else {
    setValue(RUNTIME_KEYS.lastFailedAt, iso);
    setValue(RUNTIME_KEYS.lastError, summary.statusReason);
  }
}

export function recordProductionCycleFailed(error: string, now: Date = new Date()): void {
  const iso = now.toISOString();
  setValue(RUNTIME_KEYS.lastCompletedAt, iso);
  setValue(RUNTIME_KEYS.lastFailedAt, iso);
  setValue(RUNTIME_KEYS.lastStatus, "FAILED");
  setValue(RUNTIME_KEYS.lastError, error);
}

export function getProductionCycleRuntimeState(): ProductionCycleRuntimeState {
  const rawSummary = getValue(RUNTIME_KEYS.lastSummaryJson);
  let summary: ProductionCycleSummary | null = null;
  if (rawSummary) {
    try {
      summary = JSON.parse(rawSummary) as ProductionCycleSummary;
    } catch {
      summary = null;
    }
  }

  const durationStr = getValue(RUNTIME_KEYS.lastDurationMs);
  const durationMs = durationStr ? Number.parseInt(durationStr, 10) : null;

  return {
    lastStartedAt: getValue(RUNTIME_KEYS.lastStartedAt),
    lastCompletedAt: getValue(RUNTIME_KEYS.lastCompletedAt),
    lastSuccessfulAt: getValue(RUNTIME_KEYS.lastSuccessfulAt),
    lastFailedAt: getValue(RUNTIME_KEYS.lastFailedAt),
    lastStatus: (getValue(RUNTIME_KEYS.lastStatus) as ProductionCycleStatus) || null,
    lastDurationMs: Number.isNaN(durationMs) ? null : durationMs,
    lastSummary: summary,
    lastError: getValue(RUNTIME_KEYS.lastError),
  };
}

export function resetProductionCycleStateForTests(): void {
  const db = getDb();
  releaseProductionCycleLock();
  for (const key of Object.values(RUNTIME_KEYS)) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
