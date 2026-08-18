import Database from "better-sqlite3";
import { getDbPath } from "./index";

/**
 * Stage 25B — Blocker 2. SQLite CONNECTION self-recovery.
 *
 * WHAT WAS OBSERVED, on the real machine. `next dev` had been running since 08:22. From that moment
 * every single /api/* route returned HTTP 500 with an empty body, and the 60-second scheduler tick
 * logged `SqliteError: database disk image is malformed` on every firing — 362 times over more than
 * six hours. Meanwhile the file on disk was fine: `PRAGMA integrity_check` returned `ok`,
 * `PRAGMA foreign_key_check` returned nothing, the sqlite3 CLI read it normally, and fresh
 * better-sqlite3 connections opened by CLI scripts ran a full 20,410-job re-extraction and a
 * 17,996-pair rematch against it without a single error. Restarting the server fixed it instantly.
 * `data/.fuse_hidden*` files — a deleted-but-still-open WAL index — correlate with the onset.
 *
 * So the failure mode is a POISONED HANDLE, not a corrupt database: one long-lived connection whose
 * WAL index was pulled out from under it. src/db/index.ts caches exactly one connection in
 * `global.__careerOpsDb` for the entire process lifetime and has no path that ever discards it, so
 * once poisoned it stays poisoned until the process dies. Nothing surfaced that state to the user.
 *
 * WHAT THIS MODULE DOES, and deliberately does not do.
 *  - It NEVER hides corruption. A fast probe cannot prove a 1.5 GB file is intact, so this module
 *    never claims it did: `deepCheckRun` stays false unless an operator explicitly asks for
 *    PRAGMA quick_check, and repeated failures after a successful reopen escalate to "failed"
 *    rather than being retried away.
 *  - It distinguishes "healthy database + unhealthy connection" from "genuinely unreadable
 *    database" the only way that is actually decisive: open a SECOND, brand-new, read-only
 *    connection and see whether it can read. That is precisely the experiment that separated the
 *    two cases by hand during Stage 25A.
 *  - Recovery is BOUNDED. At most MAX_RECOVERY_ATTEMPTS reopens inside RECOVERY_WINDOW_MS; past
 *    that the state latches to "failed" until the window elapses. There is no unbounded loop.
 *  - Mutations are NEVER blindly retried. withDbRecovery() retries only when the caller states the
 *    operation is read-only; every other caller gets the connection reset (so the NEXT call is
 *    healthy) and the original error rethrown.
 */

export type DbHealthStatus = "healthy" | "recovering" | "failed";

export interface DbHealthReport {
  status: DbHealthStatus;
  /** SQLite result code of the most recent classified failure, e.g. "SQLITE_CORRUPT". */
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  /** Reopens performed inside the current window. */
  recoveryAttempts: number;
  lastRecoveredAt: string | null;
  /** True only when an operator explicitly requested PRAGMA quick_check — see checkDatabaseFile. */
  deepCheckRun: boolean;
  deepCheckResult: string | null;
}

/**
 * SQLite result codes that a POISONED HANDLE produces and that a fresh connection can plausibly
 * clear. SQLITE_CORRUPT is on this list precisely because it is the code the real incident emitted
 * against a provably intact file — being on this list only earns a reopen-and-probe, never a
 * verdict that the data is fine.
 *
 * Deliberately absent: SQLITE_BUSY / SQLITE_LOCKED (already handled by busy_timeout = 30000, and
 * reopening would make contention worse), SQLITE_CONSTRAINT and friends (application bugs), and
 * SQLITE_FULL (a disk problem no reopen can fix).
 */
const RECOVERABLE_CODES = new Set([
  "SQLITE_CORRUPT",
  "SQLITE_CORRUPT_VTAB",
  "SQLITE_NOTADB",
  "SQLITE_IOERR",
  "SQLITE_IOERR_SHORT_READ",
  "SQLITE_IOERR_READ",
  "SQLITE_IOERR_WRITE",
  "SQLITE_IOERR_FSTAT",
  "SQLITE_IOERR_SHMOPEN",
  "SQLITE_IOERR_SHMMAP",
  "SQLITE_IOERR_SHMSIZE",
  "SQLITE_READONLY_DBMOVED",
  "SQLITE_CANTOPEN",
]);

export const MAX_RECOVERY_ATTEMPTS = 3;
export const RECOVERY_WINDOW_MS = 5 * 60_000;

interface HealthState {
  status: DbHealthStatus;
  lastErrorCode: string | null;
  lastErrorAt: number | null;
  attempts: number;
  windowStartedAt: number | null;
  lastRecoveredAt: number | null;
  deepCheckRun: boolean;
  deepCheckResult: string | null;
}

const state: HealthState = {
  status: "healthy",
  lastErrorCode: null,
  lastErrorAt: null,
  attempts: 0,
  windowStartedAt: null,
  lastRecoveredAt: null,
  deepCheckRun: false,
  deepCheckResult: null,
};

function sqliteCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** True when this error is the kind a fresh connection could plausibly clear. */
export function isRecoverableDbError(err: unknown): boolean {
  const code = sqliteCode(err);
  if (code && RECOVERABLE_CODES.has(code)) return true;
  // better-sqlite3 does not always populate `code` (notably for errors raised while stepping a
  // statement); the message is the same one the real incident logged.
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /database disk image is malformed|file is not a database|disk I\/O error/i.test(message);
}

/**
 * Opens a SECOND, brand-new, READ-ONLY connection and performs a cheap read. This is the decisive
 * experiment: if a fresh handle can read the file, the file is readable and the old handle was the
 * problem. It is intentionally cheap (no full scan) — see checkDatabaseFile for the deep check.
 */
export function probeDatabaseFile(): { readable: boolean; error: string | null } {
  let probe: Database.Database | null = null;
  try {
    probe = new Database(getDbPath(), { readonly: true, fileMustExist: true });
    probe.pragma("busy_timeout = 5000");
    probe.prepare("SELECT COUNT(*) AS c FROM sqlite_master").get();
    return { readable: true, error: null };
  } catch (err) {
    return { readable: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      probe?.close();
    } catch {
      /* closing a probe must never mask the probe's own verdict */
    }
  }
}

/**
 * Operator-invoked deep verification. Uses quick_check(1) — it stops at the first problem, so it is
 * far cheaper than integrity_check on a multi-gigabyte file while still actually reading pages.
 * Never called automatically: it is the thing an operator runs to decide whether to restore a
 * backup, and this module must never pretend to have run it.
 */
export function checkDatabaseFile(): { ok: boolean; result: string } {
  let probe: Database.Database | null = null;
  try {
    probe = new Database(getDbPath(), { readonly: true, fileMustExist: true });
    probe.pragma("busy_timeout = 30000");
    const rows = probe.pragma("quick_check(1)") as { quick_check?: string }[];
    const result = rows.map((r) => r.quick_check ?? JSON.stringify(r)).join("; ") || "ok";
    state.deepCheckRun = true;
    state.deepCheckResult = result;
    return { ok: result === "ok", result };
  } catch (err) {
    const result = err instanceof Error ? err.message : String(err);
    state.deepCheckRun = true;
    state.deepCheckResult = result;
    return { ok: false, result };
  } finally {
    try {
      probe?.close();
    } catch {
      /* ignore */
    }
  }
}

function windowExpired(now: number): boolean {
  return state.windowStartedAt !== null && now - state.windowStartedAt > RECOVERY_WINDOW_MS;
}

/** Test seam and operator reset — clears the bounded-attempt window. */
export function resetDbHealth(): void {
  state.status = "healthy";
  state.lastErrorCode = null;
  state.lastErrorAt = null;
  state.attempts = 0;
  state.windowStartedAt = null;
  state.lastRecoveredAt = null;
  state.deepCheckRun = false;
  state.deepCheckResult = null;
}

export function getDbHealth(): DbHealthReport {
  if (state.windowStartedAt !== null && windowExpired(Date.now()) && state.status !== "healthy") {
    // The bounded window has elapsed; allow recovery to be attempted again rather than latching
    // "failed" forever. The last error is retained so the history is not erased.
    state.status = "recovering";
    state.attempts = 0;
    state.windowStartedAt = null;
  }
  return {
    status: state.status,
    lastErrorCode: state.lastErrorCode,
    lastErrorAt: state.lastErrorAt === null ? null : new Date(state.lastErrorAt).toISOString(),
    recoveryAttempts: state.attempts,
    lastRecoveredAt: state.lastRecoveredAt === null ? null : new Date(state.lastRecoveredAt).toISOString(),
    deepCheckRun: state.deepCheckRun,
    deepCheckResult: state.deepCheckResult,
  };
}

export type DbFailureOutcome =
  /** Not a connection-level SQLite failure — the caller's own error, untouched. */
  | "unrelated"
  /** Handle discarded and the file proved readable by a fresh connection; the next getDb() is clean. */
  | "reconnected"
  /** A fresh connection could not read the file either — this looks like a real database problem. */
  | "database-unreadable"
  /** Too many recoveries inside the window; no further reopen will be attempted until it elapses. */
  | "attempts-exhausted";

/**
 * Classify a caught error and, when it looks like a poisoned handle, discard the cached connection
 * so the NEXT getDb() opens a fresh one. Never retries anything itself — see withDbRecovery.
 *
 * `closeCurrentConnection` is injected rather than imported to keep this module free of a cycle
 * with src/db/index.ts, which imports nothing from here at module scope.
 */
export function handleDbFailure(
  err: unknown,
  closeCurrentConnection: () => void,
  now: number = Date.now()
): DbFailureOutcome {
  if (!isRecoverableDbError(err)) return "unrelated";

  state.lastErrorCode = sqliteCode(err) ?? "SQLITE_CORRUPT";
  state.lastErrorAt = now;

  if (state.windowStartedAt === null || windowExpired(now)) {
    state.windowStartedAt = now;
    state.attempts = 0;
  }
  if (state.attempts >= MAX_RECOVERY_ATTEMPTS) {
    state.status = "failed";
    return "attempts-exhausted";
  }

  state.attempts++;
  state.status = "recovering";

  const probe = probeDatabaseFile();
  if (!probe.readable) {
    // A brand-new connection cannot read the file either. This is NOT something to retry away.
    state.status = "failed";
    return "database-unreadable";
  }

  closeCurrentConnection();
  state.status = "healthy";
  state.lastRecoveredAt = now;
  return "reconnected";
}

export interface DbRecoveryOptions {
  /**
   * Retry the operation once after a successful reconnect. ONLY set this for operations with no
   * side effects — a half-applied INSERT/UPDATE must never be replayed blindly. Defaults to false,
   * so an unmarked caller gets the connection reset and the original error rethrown.
   */
  readOnly?: boolean;
  /** Short label used in the recovery log line — never include candidate data. */
  label?: string;
}

/**
 * Runs `operation`, and on a connection-level SQLite failure resets the cached connection so the
 * next call is healthy. Read-only operations are retried exactly once; everything else rethrows.
 */
export function withDbRecovery<T>(
  operation: () => T,
  closeCurrentConnection: () => void,
  options: DbRecoveryOptions = {}
): T {
  try {
    return operation();
  } catch (err) {
    const outcome = handleDbFailure(err, closeCurrentConnection);
    if (outcome === "unrelated") throw err;
    // Deliberately logs the SQLite code and the caller-supplied label only — never a row, a query
    // parameter, or any candidate-derived value.
    console.error(
      `[db-health] ${options.label ?? "operation"} failed with ${state.lastErrorCode}; recovery outcome: ${outcome}`
    );
    if (outcome === "reconnected" && options.readOnly === true) {
      return operation();
    }
    throw err;
  }
}
