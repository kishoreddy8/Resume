import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LOCK_FILENAME, readBackgroundWorkerStatus, STATUS_FILENAME } from "../workerStatus";

/**
 * Stage 30.1 — the worker/status-reader contract.
 *
 * THE DEFECT. `scripts/background-worker.ts` wrote `lastTickAt`; this reader looked for
 * `lastStatusAt`. The field was therefore always null, the freshness test always failed, and a
 * perfectly healthy worker — process alive, lock held, ticks advancing, scan actively running — was
 * reported STOPPED on the Operations page indefinitely.
 *
 * Temp directories only; the real data/ is never read.
 */

/** The payload the worker's status timer actually writes, field for field. */
function workerPayload(overrides: Record<string, unknown> = {}) {
  return {
    pid: process.pid,
    startedAt: "2026-08-19T04:17:32.426Z",
    lastStatusAt: new Date().toISOString(),
    host: "worker",
    currentActivity: "scan",
    heavySlotHeldBy: "scan",
    ticks: {
      resumeWriter: { running: false, startedAt: null, lastCompletedAt: "2026-08-19T04:47:19.116Z", lastDurationMs: 2, lastOutcome: null, lastError: null },
      jobEvaluation: { running: false, startedAt: null, lastCompletedAt: "2026-08-19T04:46:33.337Z", lastDurationMs: 1, lastOutcome: null, lastError: null },
      scan: { running: true, startedAt: "2026-08-19T04:47:19.120Z", lastCompletedAt: null, lastDurationMs: null, lastOutcome: null, lastError: null },
      productionCycle: { running: false, startedAt: null, lastCompletedAt: "2026-08-19T04:40:04.072Z", lastDurationMs: 500, lastOutcome: null, lastError: null },
    },
    ...overrides,
  };
}

/** A data dir holding a status file and (optionally) the lock, as a live worker leaves them. */
function seedDataDir(payload: unknown, withLock = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s30-1-"));
  fs.writeFileSync(path.join(dir, STATUS_FILENAME), JSON.stringify(payload, null, 2));
  if (withLock) fs.writeFileSync(path.join(dir, LOCK_FILENAME), JSON.stringify({ pid: process.pid, startedAt: "x" }));
  return dir;
}

test("S30.1-01 a payload produced by the worker is reported as RUNNING", () => {
  const dir = seedDataDir(workerPayload());
  try {
    const status = readBackgroundWorkerStatus(new Date(), dir);
    assert.equal(status.running, true, `a live worker must report RUNNING, got: ${status.detail}`);
    assert.equal(status.statusStale, false);
    assert.equal(status.pid, process.pid);
    assert.equal(status.currentActivity, "scan");
    assert.equal(status.heavySlotHeldBy, "scan");
    assert.ok(status.ticks, "tick detail must be surfaced");
    assert.match(status.detail, /running/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S30.1-02 the legacy lastTickAt field is still accepted, so a worker started before the fix reports correctly", () => {
  const legacy = workerPayload();
  delete (legacy as Record<string, unknown>).lastStatusAt;
  (legacy as Record<string, unknown>).lastTickAt = new Date().toISOString();

  const dir = seedDataDir(legacy);
  try {
    const status = readBackgroundWorkerStatus(new Date(), dir);
    assert.equal(status.running, true, "a running worker must not have to be restarted to be seen");
    assert.equal(status.statusStale, false);
    assert.ok(status.lastStatusAt, "the legacy timestamp is read into the canonical field");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S30.1-03 a blocked event loop reports RUNNING with the status flagged stale, never STOPPED", () => {
  // The second observed issue: a synchronous heavy tick stops the status timer firing, so the file
  // legitimately goes stale while the worker is healthy and busy.
  const dir = seedDataDir(workerPayload({ lastStatusAt: "2026-08-19T04:00:00.000Z" }));
  try {
    const status = readBackgroundWorkerStatus(new Date("2026-08-19T04:30:00.000Z"), dir);
    assert.equal(status.running, true, "a busy worker is still running");
    assert.equal(status.statusStale, true, "but the detail must be marked as not live");
    assert.match(status.detail, /long synchronous tick/i, "the reason must be stated, not guessed");
    assert.match(status.detail, /not live/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S30.1-04 a dead process is reported STOPPED even with a fresh-looking status file", () => {
  // pid 999999 does not exist; freshness must not be able to fake liveness.
  const dir = seedDataDir(workerPayload({ pid: 999999 }));
  try {
    const status = readBackgroundWorkerStatus(new Date(), dir);
    assert.equal(status.running, false);
    assert.equal(status.currentActivity, null, "a stopped worker must not report activity");
    assert.equal(status.ticks, null);
    assert.match(status.detail, /not running/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S30.1-05 a released lock means the worker is not running", () => {
  const dir = seedDataDir(workerPayload(), false);
  try {
    const status = readBackgroundWorkerStatus(new Date(), dir);
    assert.equal(status.running, false, "liveness requires the lock, not just a live pid");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S30.1-06 a clean shutdown is reported as stopped, with its time", () => {
  const dir = seedDataDir(workerPayload({ stoppedAt: "2026-08-19T05:00:00.000Z", currentActivity: "IDLE" }));
  try {
    const status = readBackgroundWorkerStatus(new Date(), dir);
    assert.equal(status.running, false);
    assert.match(status.detail, /shut down at 2026-08-19T05:00:00\.000Z/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S30.1-07 missing or unreadable status is reported honestly, never as running", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s30-1-empty-"));
  try {
    const status = readBackgroundWorkerStatus(new Date(), empty);
    assert.equal(status.running, false);
    assert.equal(status.statusStale, false);
    assert.match(status.detail, /never reported status|not hosted/i);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }

  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s30-1-broken-"));
  try {
    fs.writeFileSync(path.join(broken, STATUS_FILENAME), "{ not json");
    const status = readBackgroundWorkerStatus(new Date(), broken);
    assert.equal(status.running, false);
    assert.match(status.detail, /unreadable/i);
  } finally {
    fs.rmSync(broken, { recursive: true, force: true });
  }
});

test("S30.1-08 the worker and the reader agree on the canonical field name", () => {
  // The contract itself, asserted against the real source so the two cannot drift apart again.
  const worker = fs.readFileSync(path.resolve("scripts/background-worker.ts"), "utf-8");
  const reader = fs.readFileSync(path.resolve("src/lib/scheduler/workerStatus.ts"), "utf-8");
  assert.ok(/lastStatusAt: new Date\(\)\.toISOString\(\)/.test(worker), "the worker must write lastStatusAt");
  assert.ok(/parsed\.lastStatusAt/.test(reader), "the reader must read lastStatusAt");
  assert.ok(/parsed\.lastTickAt/.test(reader), "and still accept the legacy name");
});
