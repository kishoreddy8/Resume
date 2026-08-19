import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WriterFailureClass } from "./claudeCliInvoker";

/**
 * Filesystem-only atomic claim for one specific handoff directory (Stage 12) — mirrors the
 * pid-liveness stale-lock idiom already used by scripts/check-connector-health-continuous.ts and its
 * siblings (data/*.lock), scoped down to a single iteration's handoff directory instead of one global
 * worker lock. No DB schema change: the claim is a plain JSON file written with the OS's atomic
 * exclusive-create flag, so two processes racing to claim the same handoff can never both succeed —
 * exactly one `wx` write wins, the other gets EEXIST.
 */

export interface HandoffClaim {
  pid: number;
  hostname: string;
  startedAt: string;
}

const CLAIM_FILENAME = ".claim.json";
const ATTEMPTS_FILENAME = ".attempts.json";

/** Cross-pass bound on purely technical writer failures for one handoff, before the worker stops
 *  auto-retrying it and leaves it for a human (who can still use the existing manual export/import
 *  UI at any time — nothing about IMPROVEMENT_RUNNING's meaning changes). Each "pass" already
 *  contains its own bounded in-process retry (see claudeCliInvoker.ts) — this is the outer bound. */
export const MAX_TECHNICAL_PASSES = 5;

interface TechnicalAttemptsFile {
  technicalAttempts: number;
  lastFailureAt: string;
  lastFailureReason: string;
  /** Stage 27 — the classification of the most recent failure, so the UI can say WHY the budget was
   *  being spent. Optional: an attempts file written before Stage 27 simply has no class. */
  lastFailureClass?: WriterFailureClass;
}

/** Stage 27 — everything a caller needs to report the technical-retry situation truthfully. */
export interface TechnicalFailureState {
  attempts: number;
  atCap: boolean;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  lastFailureClass: WriterFailureClass | null;
}

function claimPath(handoffDir: string): string {
  return path.join(handoffDir, CLAIM_FILENAME);
}

function attemptsPath(handoffDir: string): string {
  return path.join(handoffDir, ATTEMPTS_FILENAME);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when a claim file exists but its recorded pid is no longer running — a crashed/killed
 *  worker's claim, safe to reclaim. A claim whose pid IS alive is never "stale", no matter how old. */
export function isClaimStale(handoffDir: string): boolean {
  const p = claimPath(handoffDir);
  if (!fs.existsSync(p)) return false;
  try {
    const claim = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<HandoffClaim>;
    if (typeof claim.pid !== "number") return true;
    return !pidIsAlive(claim.pid);
  } catch {
    return true;
  }
}

/**
 * Attempts to atomically claim handoffDir. Returns the claim on success, or null if another live
 * process already holds it. Automatically clears a stale (dead-pid) claim and retries once — never
 * blocks on, or silently steals, a claim whose owner is still alive.
 */
export function claimHandoff(handoffDir: string): HandoffClaim | null {
  fs.mkdirSync(handoffDir, { recursive: true });
  const p = claimPath(handoffDir);
  const claim: HandoffClaim = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(p, JSON.stringify(claim, null, 2), { flag: "wx" });
    return claim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  if (!isClaimStale(handoffDir)) return null;

  try {
    fs.unlinkSync(p);
  } catch {
    // Another process may have already cleaned it up — fall through to retry.
  }

  try {
    fs.writeFileSync(p, JSON.stringify(claim, null, 2), { flag: "wx" });
    return claim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

/** Releases a claim only if it's still owned by the CURRENT process — never removes a live claim
 *  belonging to a different process, mirroring the existing worker lock's own pid-ownership check. */
export function releaseHandoffClaim(handoffDir: string): void {
  const p = claimPath(handoffDir);
  try {
    const claim = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<HandoffClaim>;
    if (claim.pid === process.pid) fs.unlinkSync(p);
  } catch {
    // No-op if missing/unreadable/already released.
  }
}

export function getTechnicalFailureCount(handoffDir: string): number {
  const p = attemptsPath(handoffDir);
  if (!fs.existsSync(p)) return 0;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<TechnicalAttemptsFile>;
    return typeof data.technicalAttempts === "number" ? data.technicalAttempts : 0;
  } catch {
    return 0;
  }
}

/** Records one more technical-failure PASS (not per CLI retry — one call per exhausted
 *  invokeClaudeWriter call) and returns the new cumulative count. Never touches workflow status or
 *  any DB row — a technical failure must never consume a quality iteration. */
export function recordTechnicalFailure(handoffDir: string, reason: string, failureClass?: WriterFailureClass): number {
  const count = getTechnicalFailureCount(handoffDir) + 1;
  const payload: TechnicalAttemptsFile = {
    technicalAttempts: count,
    lastFailureAt: new Date().toISOString(),
    lastFailureReason: reason,
    ...(failureClass ? { lastFailureClass: failureClass } : {}),
  };
  fs.writeFileSync(attemptsPath(handoffDir), JSON.stringify(payload, null, 2), "utf-8");
  return count;
}

/**
 * Stage 27 — records the reason for an operator-actionable failure WITHOUT spending a technical
 * attempt. An exhausted subscription or a logged-out CLI is not evidence that this handoff is
 * broken, and counting it was what allowed a normal 5-hour usage window to permanently wedge an
 * approved workflow (every later pass then returned the max-attempts outcome forever, with no reset
 * path). The reason is still recorded so the UI can explain the wait.
 */
export function recordNonCountingFailure(handoffDir: string, reason: string, failureClass: WriterFailureClass): number {
  const count = getTechnicalFailureCount(handoffDir);
  const payload: TechnicalAttemptsFile = {
    technicalAttempts: count,
    lastFailureAt: new Date().toISOString(),
    lastFailureReason: reason,
    lastFailureClass: failureClass,
  };
  fs.mkdirSync(handoffDir, { recursive: true });
  fs.writeFileSync(attemptsPath(handoffDir), JSON.stringify(payload, null, 2), "utf-8");
  return count;
}

/** Stage 27 — the full technical-retry picture for one handoff, for health/UI reporting. */
export function getTechnicalFailureState(handoffDir: string): TechnicalFailureState {
  const p = attemptsPath(handoffDir);
  if (!fs.existsSync(p)) {
    return { attempts: 0, atCap: false, lastFailureAt: null, lastFailureReason: null, lastFailureClass: null };
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<TechnicalAttemptsFile>;
    const attempts = typeof data.technicalAttempts === "number" ? data.technicalAttempts : 0;
    return {
      attempts,
      atCap: attempts >= MAX_TECHNICAL_PASSES,
      lastFailureAt: data.lastFailureAt ?? null,
      lastFailureReason: data.lastFailureReason ?? null,
      lastFailureClass: data.lastFailureClass ?? null,
    };
  } catch {
    return { attempts: 0, atCap: false, lastFailureAt: null, lastFailureReason: null, lastFailureClass: null };
  }
}

/**
 * Called once a handoff succeeds — clears the failure history so a LATER iteration for the same
 * workflow starts with a fresh technical-retry budget.
 *
 * Stage 27 — ALSO the operator's explicit "Retry writer" reset. This is deliberately the only thing
 * that reset does: it clears technical bookkeeping for one handoff directory and nothing else. It
 * cannot touch a Stage 21 content iteration, a review, a score, an approval, a match decision, or
 * candidate evidence — none of which are represented in this file.
 */
export function clearTechnicalFailures(handoffDir: string): void {
  const p = attemptsPath(handoffDir);
  if (fs.existsSync(p)) fs.rmSync(p);
}
