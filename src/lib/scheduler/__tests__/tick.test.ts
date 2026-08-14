import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/**
 * Scheduler tick orchestration tests. Deliberately do NOT exercise the "RAN" outcome against a real
 * scan — per the explicit Stage 1 constraint ("Do NOT run production scans... No production data
 * mutations are authorized in Stage 1"), and because runScan()/scanCompany() itself is already
 * covered by src/db/queries/__tests__/scanReliability.test.ts and friends; forking or re-mocking
 * that engine here would violate the "zero forking, reuse the existing engine" requirement. This
 * file starts from a fresh, empty test DB, so listScanReadyCompanies() always returns zero
 * companies — the SKIPPED_NO_COMPANIES path exercises the FULL orchestration sequence (settings
 * read, enabled/window/interval checks, lock acquire, state-started write, company selection,
 * state-succeeded write, lock release) with the one exception of the actual runScan() call itself.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let resetAppSettings: typeof import("@/db/queries/settings").resetAppSettings;
let updateAppSettings: typeof import("@/db/queries/settings").updateAppSettings;
let runSchedulerTick: typeof import("../tick").runSchedulerTick;
let acquireScanLock: typeof import("../lock").acquireScanLock;
let releaseScanLock: typeof import("../lock").releaseScanLock;
let resetScanLockForTests: typeof import("../lock").resetScanLockForTests;
let getScanLockStatus: typeof import("../lock").getScanLockStatus;
let getSchedulerRuntimeState: typeof import("../state").getSchedulerRuntimeState;
let resetSchedulerRuntimeStateForTests: typeof import("../state").resetSchedulerRuntimeStateForTests;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduler-tick-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("@/db"));
  ({ resetAppSettings, updateAppSettings } = await import("@/db/queries/settings"));
  ({ runSchedulerTick } = await import("../tick"));
  ({ acquireScanLock, releaseScanLock, resetScanLockForTests, getScanLockStatus } = await import("../lock"));
  ({ getSchedulerRuntimeState, resetSchedulerRuntimeStateForTests } = await import("../state"));

  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  resetAppSettings();
  resetScanLockForTests();
  resetSchedulerRuntimeStateForTests();
});

test("34. runSchedulerTick returns SKIPPED_DISABLED when scheduler.enabled=false (the default), and never touches the lock", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  return runSchedulerTick(now).then((outcome) => {
    assert.equal(outcome.outcome, "SKIPPED_DISABLED");
    assert.equal(getScanLockStatus(now).held, false);
  });
});

test("35. runSchedulerTick returns SKIPPED_OUTSIDE_WINDOW when enabled but the current hour is outside the configured window", async () => {
  updateAppSettings({ scheduler: { enabled: true, windowStartHour: 9, windowEndHour: 17 } });
  const outcome = await runSchedulerTick(new Date("2026-01-15T20:00:00Z")); // 8pm UTC
  assert.equal(outcome.outcome, "SKIPPED_OUTSIDE_WINDOW");
});

test("36. runSchedulerTick returns SKIPPED_INTERVAL_NOT_DUE when the last attempt was too recent", async () => {
  updateAppSettings({
    scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24, intervalMinutes: 60 },
  });
  const first = await runSchedulerTick(new Date("2026-01-15T12:00:00Z"));
  assert.equal(first.outcome, "SKIPPED_NO_COMPANIES"); // fresh DB, zero scan-ready companies

  const second = await runSchedulerTick(new Date("2026-01-15T12:10:00Z")); // only 10 minutes later
  assert.equal(second.outcome, "SKIPPED_INTERVAL_NOT_DUE");
});

test("37. runSchedulerTick returns SKIPPED_LOCK_HELD when the lock is already held by someone else (e.g. a manual scan)", async () => {
  updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
  const now = new Date("2026-01-15T12:00:00Z");
  acquireScanLock(now); // simulate a concurrent manual POST /api/scan holding the lock

  const outcome = await runSchedulerTick(now);
  assert.equal(outcome.outcome, "SKIPPED_LOCK_HELD");
  if (outcome.outcome === "SKIPPED_LOCK_HELD") {
    assert.equal(outcome.heldSince, now.toISOString());
  }
});

test("38. runSchedulerTick releases a lock it acquired even when there are zero companies to scan, and records success state", async () => {
  updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
  const now = new Date("2026-01-15T12:00:00Z");
  const beforeCall = Date.now();

  const outcome = await runSchedulerTick(now);
  assert.equal(outcome.outcome, "SKIPPED_NO_COMPANIES");

  const lockStatus = getScanLockStatus(now);
  assert.equal(lockStatus.held, false);

  const runtimeState = getSchedulerRuntimeState();
  // lastStartedAt uses the tick's own injected clock (`now`) — it's the "as-of" instant the tick
  // reasoned about, and the value the NEXT tick's isIntervalDue check reads back.
  assert.equal(runtimeState.lastStartedAt, now.toISOString());
  // lastCompletedAt/lastSuccessfulAt use a fresh real timestamp (see tick.ts's comment) — for this
  // near-instant zero-company path that's just "roughly when the test actually ran", not `now`.
  assert.ok(runtimeState.lastSuccessfulAt);
  const successfulAtMs = new Date(runtimeState.lastSuccessfulAt!).getTime();
  assert.ok(successfulAtMs >= beforeCall && successfulAtMs <= Date.now());
  assert.equal(runtimeState.lastError, null);
});

test("39. a fresh database's listScanReadyCompanies() is empty, so runSchedulerTick never reaches runScan() without any companies configured", async () => {
  updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
  const outcome = await runSchedulerTick(new Date("2026-01-15T12:00:00Z"));
  assert.equal(outcome.outcome, "SKIPPED_NO_COMPANIES");
});

test("40. runSchedulerTick releases the lock even though no scan ran, so a manual POST /api/scan can immediately acquire it afterward", async () => {
  updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
  const now = new Date("2026-01-15T12:00:00Z");
  await runSchedulerTick(now);

  const manualAcquire = acquireScanLock(new Date(now.getTime() + 1000));
  assert.equal(manualAcquire.acquired, true);
  releaseScanLock();
});
