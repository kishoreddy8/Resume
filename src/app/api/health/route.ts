import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { closeDbConnection, getDb, getDbPath } from "@/db";
import { checkDatabaseFile, getDbHealth, handleDbFailure, probeDatabaseFile } from "@/db/health";
import { redactPaths } from "@/lib/operations/redact";

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
 *
 * ADMIN-OPS-5 — this route is deliberately UNAUTHENTICATED, because a readiness probe that requires
 * a session cannot report the failure it exists to report: during the Stage 25A incident every
 * authenticated route was returning 500. That makes what it says a security boundary in itself.
 *
 * It used to answer with `dbPath`, the absolute path of the database — which on a local-first
 * product means the operator's home directory and username, handed to anyone who can reach the port.
 * Nothing needed it: the file always sits at data/app.db relative to the install, so the only
 * genuinely useful facts are its NAME and whether it is in the expected place. SQLite error strings
 * embed the same path, so they are redacted through one helper rather than trusted individually.
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
      /* Name and expectedness only — never the absolute path. */
      database: {
        file: path.basename(getDbPath()),
        atDefaultLocation: getDbPath() === path.join(process.cwd(), "data", "app.db"),
      },
      connection: { ok: connectionOk, error: redactPaths(connectionError), recovery },
      file: { readable: fileProbe.readable, error: redactPaths(fileProbe.error) },
      deepCheck:
        deepCheck === null
          ? { run: false }
          : { run: true, ok: deepCheck.ok, result: redactPaths(deepCheck.result) },
      recoveryState: health,
    },
    { status: status === "failed" ? 503 : 200 }
  );
}
