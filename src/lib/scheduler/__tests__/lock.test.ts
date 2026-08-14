import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/**
 * Scan lock atomicity/staleness tests — real (temp, isolated) SQLite file via CAREER_OPS_DB_PATH,
 * same pattern as src/db/queries/__tests__/settings.test.ts. Dynamic imports inside before() so the
 * env var is set before getDb() ever opens a file.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let acquireScanLock: typeof import("../lock").acquireScanLock;
let releaseScanLock: typeof import("../lock").releaseScanLock;
let getScanLockStatus: typeof import("../lock").getScanLockStatus;
let resetScanLockForTests: typeof import("../lock").resetScanLockForTests;
let STALE_LOCK_TIMEOUT_MINUTES: typeof import("../lock").STALE_LOCK_TIMEOUT_MINUTES;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-lock-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("@/db"));
  ({ acquireScanLock, releaseScanLock, getScanLockStatus, resetScanLockForTests, STALE_LOCK_TIMEOUT_MINUTES } =
    await import("../lock"));

  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  resetScanLockForTests();
});

test("20. acquireScanLock succeeds when the lock is free", () => {
  const result = acquireScanLock(new Date("2026-01-15T12:00:00Z"));
  assert.equal(result.acquired, true);
});

test("21. acquireScanLock fails when the lock is already held (fresh)", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  const first = acquireScanLock(now);
  assert.equal(first.acquired, true);
  const second = acquireScanLock(new Date(now.getTime() + 60_000)); // 1 minute later, well within stale window
  assert.equal(second.acquired, false);
  assert.equal(second.heldSince, now.toISOString());
});

test("22. releaseScanLock frees a held lock for a subsequent acquire", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  acquireScanLock(now);
  releaseScanLock();
  const result = acquireScanLock(new Date(now.getTime() + 1000));
  assert.equal(result.acquired, true);
});

test("23. acquireScanLock takes over a stale lock (held past STALE_LOCK_TIMEOUT_MINUTES)", () => {
  const acquiredAt = new Date("2026-01-15T12:00:00Z");
  acquireScanLock(acquiredAt);
  const wellPastStale = new Date(acquiredAt.getTime() + (STALE_LOCK_TIMEOUT_MINUTES + 1) * 60_000);
  const result = acquireScanLock(wellPastStale);
  assert.equal(result.acquired, true);
});

test("24. acquireScanLock does NOT take over a lock held just under the stale timeout", () => {
  const acquiredAt = new Date("2026-01-15T12:00:00Z");
  acquireScanLock(acquiredAt);
  const justUnderStale = new Date(acquiredAt.getTime() + (STALE_LOCK_TIMEOUT_MINUTES - 1) * 60_000);
  const result = acquireScanLock(justUnderStale);
  assert.equal(result.acquired, false);
});

test("25. getScanLockStatus reports held=false, acquiredAt=null when free", () => {
  const status = getScanLockStatus(new Date("2026-01-15T12:00:00Z"));
  assert.deepEqual(status, { held: false, acquiredAt: null, stale: false });
});

test("26. getScanLockStatus reports held=true with the acquisition timestamp when freshly held", () => {
  const acquiredAt = new Date("2026-01-15T12:00:00Z");
  acquireScanLock(acquiredAt);
  const status = getScanLockStatus(new Date(acquiredAt.getTime() + 60_000));
  assert.equal(status.held, true);
  assert.equal(status.acquiredAt, acquiredAt.toISOString());
  assert.equal(status.stale, false);
});

test("27. getScanLockStatus reports held=false, stale=true once past the timeout (read-only, does not take over)", () => {
  const acquiredAt = new Date("2026-01-15T12:00:00Z");
  acquireScanLock(acquiredAt);
  const wellPastStale = new Date(acquiredAt.getTime() + (STALE_LOCK_TIMEOUT_MINUTES + 1) * 60_000);
  const status = getScanLockStatus(wellPastStale);
  assert.equal(status.held, false);
  assert.equal(status.stale, true);
  // Confirm getScanLockStatus truly didn't mutate anything — the raw value is still the original.
  const secondStatus = getScanLockStatus(wellPastStale);
  assert.equal(secondStatus.acquiredAt, acquiredAt.toISOString());
});

test("28. two concurrent acquireScanLock calls at the exact same instant: exactly one succeeds", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  const first = acquireScanLock(now);
  const second = acquireScanLock(now);
  const succeededCount = [first, second].filter((r) => r.acquired).length;
  assert.equal(succeededCount, 1);
});
