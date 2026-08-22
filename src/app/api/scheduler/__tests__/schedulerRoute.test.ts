import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { adminTestRequest } from "@/lib/auth/__tests__/adminTestRequest";

let tmpDir: string;
let updateAppSettings: typeof import("@/db/queries/settings").updateAppSettings;
let resetAppSettings: typeof import("@/db/queries/settings").resetAppSettings;
let acquireScanLock: typeof import("@/lib/scheduler/lock").acquireScanLock;
let releaseScanLock: typeof import("@/lib/scheduler/lock").releaseScanLock;
let resetScanLockForTests: typeof import("@/lib/scheduler/lock").resetScanLockForTests;
let GET: typeof import("../route").GET;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduler-route-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db");
  ({ updateAppSettings, resetAppSettings } = await import("@/db/queries/settings"));
  ({ acquireScanLock, releaseScanLock, resetScanLockForTests } = await import("@/lib/scheduler/lock"));
  ({ GET } = await import("../route"));
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

test("57. GET /api/scheduler reports the disabled default settings and a free lock on a fresh database", async () => {
  resetAppSettings();
  resetScanLockForTests();

  const res = await GET(await adminTestRequest("/api/scheduler"));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.settings.enabled, false);
  assert.equal(body.lock.held, false);
  assert.equal(body.runtime.lastStartedAt, null);
  assert.equal(body.nextEligibleRunAt, null, "disabled scheduler must report no next-run time");
});

test("58. GET /api/scheduler reflects a persisted scheduler settings patch", async () => {
  resetAppSettings();
  updateAppSettings({ scheduler: { enabled: true, intervalMinutes: 45, windowStartHour: 0, windowEndHour: 24 } });

  const res = await GET(await adminTestRequest("/api/scheduler"));
  const body = await res.json();
  assert.equal(body.settings.enabled, true);
  assert.equal(body.settings.intervalMinutes, 45);
  assert.ok(body.nextEligibleRunAt, "an enabled scheduler with a full-day window must report a next-run time");
  resetAppSettings();
});

test("59. GET /api/scheduler reports lock.held=true and acquiredAt while a scan is in progress", async () => {
  resetScanLockForTests();
  const now = new Date();
  acquireScanLock(now);

  try {
    const res = await GET(await adminTestRequest("/api/scheduler"));
    const body = await res.json();
    assert.equal(body.lock.held, true);
    assert.ok(body.lock.acquiredAt);
  } finally {
    releaseScanLock();
  }
});

test("60. GET /api/scheduler never exposes a PATCH-writable runtime surface (route module exports GET only)", async () => {
  const routeModule = await import("../route");
  assert.equal("PATCH" in routeModule, false);
  assert.equal("POST" in routeModule, false);
});
