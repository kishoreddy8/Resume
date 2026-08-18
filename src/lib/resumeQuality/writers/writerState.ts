import crypto from "node:crypto";
import { getDb } from "@/db";
import type { PassOutcome } from "./writerWorkerCore";

/** Re-exported so the health model can describe one workflow's last recorded outcome without
 *  importing writerWorkerCore (and its child_process dependency) for a type alone. */
export type PassOutcomeSummary = PassOutcome;

/**
 * Stage 26 — the resume writer's cross-process lease and runtime bookkeeping.
 *
 * Deliberately the SAME primitive src/lib/production/state.ts already proved out for the production
 * cycle (Stage 23): a lease in the existing `settings` table, taken with one atomic conditional
 * UPDATE gated on `.changes === 1`, refreshed by a heartbeat on its own timer, and judged stale
 * against the LAST HEARTBEAT rather than the acquisition time — so a legitimately slow writer pass
 * (a single Claude CLI call is allowed up to 10 minutes, and a pass may process more than one
 * workflow) never looks abandoned, while a genuinely dead process is reclaimed in minutes.
 *
 * Why a DB lease at all when handoffClaim.ts already exists: that claim is per-handoff-directory, so
 * it correctly stops two processes from writing the SAME iteration, but it would happily let the
 * in-process scheduler tick and a hand-started `npm run resume-writer-worker-continuous` invoke
 * Claude concurrently for two DIFFERENT workflows. This lease is the single machine-wide "a writer
 * pass is running" authority; both entrypoints go through runGuardedWriterPass(), so neither can
 * start one while the other holds it. The per-handoff claim is kept exactly as-is underneath — it
 * still guards the individual iteration, and its pid-liveness stale recovery is untouched.
 *
 * Nothing here is user-writable: these keys live outside the PATCH-validated app-settings schema,
 * exactly like the scheduler's and production cycle's own runtime keys.
 */

const LOCK_KEY = "resume_writer_lock.acquired_at";
const OWNER_KEY = "resume_writer_lock.owner_id";
const TRUE_ACQUIRED_KEY = "resume_writer_lock.true_acquired_at";

export const RESUME_WRITER_HEARTBEAT_INTERVAL_MS = 30_000;

/** 10x the heartbeat interval, matching STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES' own reasoning:
 *  absorbs a missed beat or two without false-flagging a healthy pass, and still recovers a crashed
 *  process (or a Mac that slept mid-pass) within minutes rather than hours. */
export const STALE_RESUME_WRITER_LOCK_TIMEOUT_MINUTES = (RESUME_WRITER_HEARTBEAT_INTERVAL_MS * 10) / 60_000;

const RUNTIME_KEYS = {
  lastTickAt: "resume_writer.last_tick_at",
  lastStartedAt: "resume_writer.last_started_at",
  lastCompletedAt: "resume_writer.last_completed_at",
  lastOutcome: "resume_writer.last_outcome",
  lastError: "resume_writer.last_error",
  lastSummaryJson: "resume_writer.last_summary_json",
  lastDurationMs: "resume_writer.last_duration_ms",
} as const;

export interface WriterLeaseAcquireResult {
  acquired: boolean;
  heldSince?: string;
  /** Present only when acquired — heartbeat/release only succeed for this owner. */
  ownerId?: string;
}

export interface WriterLeaseStatus {
  held: boolean;
  acquiredAt: string | null;
  stale: boolean;
  ownerId: string | null;
  /** Original acquisition time, never touched by heartbeats — "running since" for observability. */
  trueAcquiredAt: string | null;
}

/** One completed writer pass, as recorded for the UI. `outcomes` is the per-workflow result list
 *  runWorkerPass already returns; nothing new is derived or inferred here. */
export interface WriterPassRecord {
  attempted: number;
  outcomes: PassOutcome[];
}

export interface WriterRuntimeState {
  lastTickAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  lastSummary: WriterPassRecord | null;
  lastDurationMs: number | null;
}

function staleThresholdIso(now: Date): string {
  return new Date(now.getTime() - STALE_RESUME_WRITER_LOCK_TIMEOUT_MINUTES * 60_000).toISOString();
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

export function acquireResumeWriterLease(now: Date = new Date()): WriterLeaseAcquireResult {
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

  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(LOCK_KEY) as { value: string } | undefined;
  return { acquired: false, heldSince: row?.value || undefined };
}

/** Renews the lease only while `ownerId` still owns it. `false` means "I may no longer hold this" —
 *  never a reason to assume the lease is still safely ours. */
export function heartbeatResumeWriterLease(ownerId: string, now: Date = new Date()): boolean {
  const result = getDb()
    .prepare(
      `UPDATE settings SET value = ?, updated_at = datetime('now')
       WHERE key = ? AND EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)`
    )
    .run(now.toISOString(), LOCK_KEY, OWNER_KEY, ownerId);
  return result.changes === 1;
}

/** Releases the lease only if `ownerId` still owns it — a pass whose lease was already reclaimed
 *  can never clear the new owner's active lease. */
export function releaseResumeWriterLease(ownerId: string): void {
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

/** Operator/test recovery only — never called by a real pass, which always releases via its ownerId. */
export function forceReleaseResumeWriterLease(): void {
  getDb().prepare(`UPDATE settings SET value = '', updated_at = datetime('now') WHERE key = ?`).run(LOCK_KEY);
  setValue(OWNER_KEY, null);
  setValue(TRUE_ACQUIRED_KEY, null);
}

export function getResumeWriterLeaseStatus(now: Date = new Date()): WriterLeaseStatus {
  const acquiredAt = getValue(LOCK_KEY) || null;
  if (!acquiredAt) return { held: false, acquiredAt: null, stale: false, ownerId: null, trueAcquiredAt: null };
  const stale = acquiredAt < staleThresholdIso(now);
  return {
    held: !stale,
    acquiredAt,
    stale,
    ownerId: stale ? null : getValue(OWNER_KEY),
    trueAcquiredAt: stale ? null : getValue(TRUE_ACQUIRED_KEY),
  };
}

/** Stamped by the tick on EVERY evaluation, including the ones that decide not to run. This is what
 *  makes "the scheduler is alive but nothing is due" distinguishable from "nothing is running the
 *  scheduler at all" — see writerHealth.ts. */
export function recordResumeWriterTick(now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastTickAt, now.toISOString());
}

export function recordResumeWriterPassStarted(now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastStartedAt, now.toISOString());
}

export function recordResumeWriterPassCompleted(summary: WriterPassRecord, durationMs: number, now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastCompletedAt, now.toISOString());
  setValue(RUNTIME_KEYS.lastSummaryJson, JSON.stringify(summary));
  setValue(RUNTIME_KEYS.lastDurationMs, String(durationMs));

  // A pass "succeeded" as an operation whenever it ran to completion — a workflow whose quality gate
  // failed is a genuine product outcome, not a writer error. Only outcomes that mean "no resume was
  // produced for technical reasons" are surfaced as the pass-level error.
  const technical = summary.outcomes.filter((o) => o.outcome === "TECHNICAL_FAILURE" || o.outcome === "ERROR");
  setValue(RUNTIME_KEYS.lastOutcome, technical.length > 0 ? "TECHNICAL_FAILURE" : "COMPLETED");
  setValue(RUNTIME_KEYS.lastError, technical.length > 0 ? (technical[0].error ?? "Writer pass reported a technical failure") : null);
}

export function recordResumeWriterPassFailed(error: string, now: Date = new Date()): void {
  setValue(RUNTIME_KEYS.lastCompletedAt, now.toISOString());
  setValue(RUNTIME_KEYS.lastOutcome, "FAILED");
  setValue(RUNTIME_KEYS.lastError, error);
}

export function getResumeWriterRuntimeState(): WriterRuntimeState {
  const rawSummary = getValue(RUNTIME_KEYS.lastSummaryJson);
  let summary: WriterPassRecord | null = null;
  if (rawSummary) {
    try {
      summary = JSON.parse(rawSummary) as WriterPassRecord;
    } catch {
      summary = null;
    }
  }
  const durationStr = getValue(RUNTIME_KEYS.lastDurationMs);
  const durationMs = durationStr ? Number.parseInt(durationStr, 10) : null;

  return {
    lastTickAt: getValue(RUNTIME_KEYS.lastTickAt),
    lastStartedAt: getValue(RUNTIME_KEYS.lastStartedAt),
    lastCompletedAt: getValue(RUNTIME_KEYS.lastCompletedAt),
    lastOutcome: getValue(RUNTIME_KEYS.lastOutcome),
    lastError: getValue(RUNTIME_KEYS.lastError),
    lastSummary: summary,
    lastDurationMs: Number.isNaN(durationMs) ? null : durationMs,
  };
}

export function resetResumeWriterStateForTests(): void {
  const db = getDb();
  forceReleaseResumeWriterLease();
  for (const key of Object.values(RUNTIME_KEYS)) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
