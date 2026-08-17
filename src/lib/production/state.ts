import crypto from "node:crypto";
import { getDb } from "@/db";
import type { ProductionCycleStatus, ProductionCycleSummary } from "./types";

/**
 * Production Cycle Lock and Runtime State persistence.
 * Reuses the existing `settings` table (key TEXT PRIMARY KEY) with atomic conditional updates.
 *
 * Lock keys (Stage 23 — lease + heartbeat):
 *   - "production_cycle_lock.acquired_at" — the lease's last-known-alive timestamp. Set on
 *     acquire, then refreshed on every heartbeat while the cycle runs. Staleness is judged against
 *     THIS timestamp, so a healthy long-running cycle that keeps heartbeating never goes stale
 *     regardless of total wall-clock duration — this is what fixes the Stage 22 finding that a
 *     legitimate ~3h41m unbounded cycle could outlive a flat 180-minute acquired-at-only timeout.
 *   - "production_cycle_lock.owner_id" — opaque ID for whichever acquire() call currently holds
 *     the lease. heartbeat()/release() only succeed when the caller's ownerId still matches this
 *     value, so one cycle can never renew or clear another cycle's lock.
 *   - "production_cycle_lock.true_acquired_at" — the ORIGINAL acquisition time, never touched by
 *     heartbeats. Kept separately so status/observability callers (Morning Readiness) can show
 *     "running since X" distinct from "last heartbeat at Y".
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
const OWNER_KEY = "production_cycle_lock.owner_id";
const TRUE_ACQUIRED_KEY = "production_cycle_lock.true_acquired_at";

// Derived from real Stage 22 acceptance timings, not picked arbitrarily: a single Discovery V2
// candidate fetch was observed taking up to ~90s (Under Armour: 63,364ms), and the phase processes
// its bounded cohort sequentially — so the heartbeat must run on its own timer independent of phase
// boundaries, not just "once per phase", or a single slow candidate could starve it. 30s gives
// several heartbeat opportunities even across the slowest single observed real call.
export const PRODUCTION_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;

// 10x the heartbeat interval ("substantially larger", per the lease-safety requirement): comfortably
// absorbs a missed beat or two (GC pause, brief event-loop delay) without false-flagging a healthy
// cycle as abandoned, while recovering a genuinely dead process in minutes instead of the old flat
// 180-minute window (which a real ~3h41m unbounded ATS scan phase was observed to exceed).
export const STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES = (PRODUCTION_LOCK_HEARTBEAT_INTERVAL_MS * 10) / 60_000;

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
  /** Present only when acquired is true — pass to heartbeatProductionCycleLock()/
   *  releaseProductionCycleLock() so only this attempt can renew or clear its own lease. */
  ownerId?: string;
}

export interface ProductionLockStatus {
  held: boolean;
  acquiredAt: string | null;
  stale: boolean;
  /** Opaque ID of whichever acquire() currently holds the lease, or null when free. */
  ownerId: string | null;
  /** Original acquisition time, distinct from `acquiredAt` (which is heartbeat-refreshed) — the
   *  field to show "running since" in observability/UI without it drifting on every heartbeat. */
  trueAcquiredAt: string | null;
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
 * Attempts to acquire the production cycle lease. Succeeds if the lease is free or its last
 * heartbeat (see PRODUCTION_LOCK_HEARTBEAT_INTERVAL_MS) is older than the stale threshold — i.e.
 * genuinely abandoned, not merely long-running. On success, also stamps a fresh owner_id and
 * true_acquired_at; only the winner of the atomic UPDATE below ever reaches those statements (no
 * other JS can interleave between synchronous better-sqlite3 calls in this single-process app), so
 * this stays race-free without needing a single combined statement.
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
    const ownerId = crypto.randomUUID();
    setValue(OWNER_KEY, ownerId);
    setValue(TRUE_ACQUIRED_KEY, nowIso);
    return { acquired: true, ownerId };
  }

  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(LOCK_KEY) as
    | { value: string }
    | undefined;
  return { acquired: false, heldSince: row?.value || undefined };
}

/**
 * Renews the lease for a still-running cycle. Only refreshes the alive-timestamp when `ownerId`
 * still matches the stored owner — a cycle that has already lost its lease (stolen after going
 * stale) gets `false` back instead of silently overwriting whoever holds it now. Callers must treat
 * `false` as "I may no longer hold this lock" (see runProductionCycle's heartbeat wiring), never as
 * a reason to assume the lock is still safely theirs.
 */
export function heartbeatProductionCycleLock(ownerId: string, now: Date = new Date()): boolean {
  const result = getDb()
    .prepare(
      `UPDATE settings SET value = ?, updated_at = datetime('now')
       WHERE key = ? AND EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)`
    )
    .run(now.toISOString(), LOCK_KEY, OWNER_KEY, ownerId);
  return result.changes === 1;
}

/**
 * Releases the production cycle lease — but ONLY if `ownerId` still matches the current owner. A
 * cycle whose lease was already stolen (e.g. it stalled past the stale threshold and a new cycle
 * took over) can never clear the NEW owner's active lock this way; the call becomes a safe no-op.
 */
export function releaseProductionCycleLock(ownerId: string): void {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE settings SET value = '', updated_at = datetime('now')
       WHERE key = ? AND EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)`
    )
    .run(LOCK_KEY, OWNER_KEY, ownerId);
  if (result.changes === 1) {
    setValue(OWNER_KEY, null);
    setValue(TRUE_ACQUIRED_KEY, null);
  }
}

/**
 * Unconditionally frees the lease regardless of current owner. Reserved for operator/test recovery
 * paths (e.g. clearing a confirmed-abandoned lock found by inspection) — never called by
 * runProductionCycle() itself, which always releases through its own ownerId.
 */
export function forceReleaseProductionCycleLock(): void {
  const db = getDb();
  db.prepare(`UPDATE settings SET value = '', updated_at = datetime('now') WHERE key = ?`).run(LOCK_KEY);
  setValue(OWNER_KEY, null);
  setValue(TRUE_ACQUIRED_KEY, null);
}

/**
 * Checks current production cycle lease status. `stale` reflects the heartbeat-refreshed
 * `acquiredAt`, so a healthy cycle that keeps heartbeating never reads as stale regardless of how
 * long it has actually been running — see `trueAcquiredAt` for that.
 */
export function getProductionCycleLockStatus(now: Date = new Date()): ProductionLockStatus {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(LOCK_KEY) as
    | { value: string }
    | undefined;
  const acquiredAt = row?.value || null;
  if (!acquiredAt) {
    return { held: false, acquiredAt: null, stale: false, ownerId: null, trueAcquiredAt: null };
  }
  const stale = acquiredAt < staleThresholdIso(now);
  return {
    held: !stale,
    acquiredAt,
    stale,
    ownerId: stale ? null : getValue(OWNER_KEY),
    trueAcquiredAt: stale ? null : getValue(TRUE_ACQUIRED_KEY),
  };
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
  forceReleaseProductionCycleLock();
  for (const key of Object.values(RUNTIME_KEYS)) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
