import { NextRequest, NextResponse } from "next/server";
import { closeDbConnection, getDb, getDbPath } from "@/db";
import { checkDatabaseFile, getDbHealth, handleDbFailure, probeDatabaseFile } from "@/db/health";

/**
 * Stage 25B — Blocker 2. Readiness/health endpoint.
 *
 * The Stage 25A incident was invisible: every /api/* route returned an EMPTY 500 body for six hours
 * and nothing anywhere reported that the process was unusable while the database itself was fine.
 * This route exists so that state is observable and, when it is a poisoned handle rather than a
 * damaged file, self-clearing.
 *
 *   GET /api/health          — cheap. Runs one trivial read through the SHARED connection (the one
 *                              that actually gets poisoned), plus a fresh-connection probe when that
 *                              read fails, and reports healthy | degraded | failed.
 *   GET /api/health?deep=1   — additionally runs PRAGMA quick_check(1) on a separate read-only
 *                              connection. This is the operator's "is the file actually damaged?"
 *                              check; it is never run automatically because a fast probe cannot
 *                              prove a multi-gigabyte file intact and this module must not pretend
 *                              otherwise.
 *
 * Returns 200 when serving is possible and 503 when it is not, so it can be used as a readiness
 * probe. The body never contains candidate-derived data — only SQLite result codes and counters.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const deep = req.nextUrl.searchParams.get("deep") === "1";

  let connectionOk = true;
  let connectionError: string | null = null;
  let recovery: string | null = null;

  try {
    // Deliberately goes through the SHARED cached connection: probing a fresh one would report
    // "healthy" for exactly the failure this endpoint exists to catch.
    getDb().prepare("SELECT 1 AS ok").get();
  } catch (err) {
    connectionOk = false;
    connectionError = err instanceof Error ? err.message : String(err);
    recovery = handleDbFailure(err, closeDbConnection);
    if (recovery === "reconnected") {
      // A fresh connection proved the file readable and the dead handle has been dropped — confirm
      // the replacement actually serves before reporting recovery.
      try {
        getDb().prepare("SELECT 1 AS ok").get();
        connectionOk = true;
      } catch (retryErr) {
        connectionOk = false;
        connectionError = retryErr instanceof Error ? retryErr.message : String(retryErr);
      }
    }
  }

  const fileProbe = connectionOk ? { readable: true, error: null } : probeDatabaseFile();
  const deepCheck = deep ? checkDatabaseFile() : null;
  const health = getDbHealth();

  const status: "healthy" | "degraded" | "failed" = connectionOk
    ? health.status === "healthy"
      ? "healthy"
      : "degraded"
    : "failed";

  return NextResponse.json(
    {
      status,
      dbPath: getDbPath(),
      connection: { ok: connectionOk, error: connectionError, recovery },
      file: { readable: fileProbe.readable, error: fileProbe.error },
      deepCheck: deepCheck === null ? { run: false } : { run: true, ok: deepCheck.ok, result: deepCheck.result },
      recoveryState: health,
    },
    { status: status === "failed" ? 503 : 200 }
  );
}
