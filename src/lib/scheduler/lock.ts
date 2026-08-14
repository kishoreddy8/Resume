import { getDb } from "@/db";

/**
 * Atomic scan lock (Phase 4 Stage 1). Prevents overlapping scans — whether triggered by the
 * scheduler tick or a manual POST /api/scan — from running concurrently against the same SQLite
 * database. Reuses the existing `settings` table (key TEXT PRIMARY KEY) rather than a new table:
 * a single conditional UPDATE, gated on `.changes === 1`, is atomic even across multiple OS
 * processes sharing the same SQLite file (not just intra-process) — the same reasoning already
 * proven safe elsewhere in this codebase by companies.discovery_attempted_at's cooldown-window
 * pattern (POST /api/companies/[id]/discover).
 *
 * The lock value is an ISO-8601 timestamp (with trailing "Z", written by this module's own
 * `Date#toISOString()` calls — never SQLite's `datetime('now')`, which omits the "Z" and would
 * reintroduce the exact local-time-parsing ambiguity src/lib/settings.ts's parseSqliteUtc works
 * around). ISO-8601 strings with a fixed-width, zero-padded format sort correctly as plain text, so
 * the staleness check below is a lexicographic string comparison, not a parsed-Date comparison.
 */

const LOCK_KEY = "scheduler_lock.acquired_at";

// A full structured scan across the entire allowlisted company set can plausibly take many tens of
// minutes. This must comfortably exceed realistic scan duration so a slow-but-alive scan is never
// mistaken for an abandoned one, while still eventually recovering from a truly crashed process
// that died holding the lock. Not user-configurable — a fixed, documented safety constant.
export const STALE_LOCK_TIMEOUT_MINUTES = 180;

export interface LockAcquireResult {
  acquired: boolean;
  /** Present only when acquired is false. */
  heldSince?: string;
}

export interface ScanLockStatus {
  held: boolean;
  acquiredAt: string | null;
  /** True when a value is stored but old enough to be considered abandoned (held stays false in
   *  that case — a stale lock reads as "not actually held" from the outside). */
  stale: boolean;
}

function staleThresholdIso(now: Date): string {
  return new Date(now.getTime() - STALE_LOCK_TIMEOUT_MINUTES * 60_000).toISOString();
}

/**
 * Attempts to acquire the lock. Succeeds if the lock is free (empty value) or held by a stale
 * (abandoned) attempt — in both cases this call takes it over in one atomic step. Fails if the lock
 * is currently held by a non-stale attempt. Manual scans (POST /api/scan) and scheduled ticks share
 * this exact same primitive, so a manual scan naturally recovers from an abandoned scheduled lock
 * (and vice versa) without a separate "explicit takeover" mechanism.
 */
export function acquireScanLock(now: Date = new Date()): LockAcquireResult {
  const db = getDb();
  const nowIso = now.toISOString();

  // Ensures the row exists so the single UPDATE below is the sole source of truth for the
  // acquire/deny decision — a no-op if the row is already present, and harmless if two processes
  // race here since it never overwrites an existing value.
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

/** Releases the lock unconditionally. Always call from a `finally` block so a thrown scan error
 *  never leaves the lock held past the (much longer) stale-lock timeout. */
export function releaseScanLock(): void {
  getDb().prepare(`UPDATE settings SET value = '', updated_at = datetime('now') WHERE key = ?`).run(LOCK_KEY);
}

/** Read-only lock status for GET /api/scheduler. Never mutates anything — takeover only happens via
 *  a real acquireScanLock() call. */
export function getScanLockStatus(now: Date = new Date()): ScanLockStatus {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(LOCK_KEY) as
    | { value: string }
    | undefined;
  const acquiredAt = row?.value || null;
  if (!acquiredAt) return { held: false, acquiredAt: null, stale: false };
  const stale = acquiredAt < staleThresholdIso(now);
  return { held: !stale, acquiredAt, stale };
}

/** Test-only reset — releases the lock regardless of state, so a test starts from a clean baseline. */
export function resetScanLockForTests(): void {
  releaseScanLock();
}
