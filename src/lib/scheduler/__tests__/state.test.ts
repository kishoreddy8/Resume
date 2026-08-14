import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let getSchedulerRuntimeState: typeof import("../state").getSchedulerRuntimeState;
let recordSchedulerTickStarted: typeof import("../state").recordSchedulerTickStarted;
let recordSchedulerTickSucceeded: typeof import("../state").recordSchedulerTickSucceeded;
let recordSchedulerTickFailed: typeof import("../state").recordSchedulerTickFailed;
let resetSchedulerRuntimeStateForTests: typeof import("../state").resetSchedulerRuntimeStateForTests;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduler-state-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("@/db"));
  ({ getSchedulerRuntimeState, recordSchedulerTickStarted, recordSchedulerTickSucceeded, recordSchedulerTickFailed, resetSchedulerRuntimeStateForTests } =
    await import("../state"));

  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  resetSchedulerRuntimeStateForTests();
});

test("29. getSchedulerRuntimeState returns all-null on a fresh/never-run database", () => {
  assert.deepEqual(getSchedulerRuntimeState(), {
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessfulAt: null,
    lastFailedAt: null,
    lastError: null,
  });
});

test("30. recordSchedulerTickStarted sets only lastStartedAt", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  recordSchedulerTickStarted(now);
  const state = getSchedulerRuntimeState();
  assert.equal(state.lastStartedAt, now.toISOString());
  assert.equal(state.lastCompletedAt, null);
});

test("31. recordSchedulerTickSucceeded sets lastCompletedAt and lastSuccessfulAt, clears lastError", () => {
  recordSchedulerTickFailed("boom", new Date("2026-01-15T11:00:00Z"));
  assert.equal(getSchedulerRuntimeState().lastError, "boom");

  const now = new Date("2026-01-15T12:00:00Z");
  recordSchedulerTickSucceeded(now);
  const state = getSchedulerRuntimeState();
  assert.equal(state.lastCompletedAt, now.toISOString());
  assert.equal(state.lastSuccessfulAt, now.toISOString());
  assert.equal(state.lastError, null);
});

test("32. recordSchedulerTickFailed sets lastCompletedAt, lastFailedAt, and lastError, but leaves lastSuccessfulAt untouched", () => {
  const successAt = new Date("2026-01-15T10:00:00Z");
  recordSchedulerTickSucceeded(successAt);

  const failAt = new Date("2026-01-15T13:00:00Z");
  recordSchedulerTickFailed("network timeout", failAt);

  const state = getSchedulerRuntimeState();
  assert.equal(state.lastSuccessfulAt, successAt.toISOString());
  assert.equal(state.lastFailedAt, failAt.toISOString());
  assert.equal(state.lastCompletedAt, failAt.toISOString());
  assert.equal(state.lastError, "network timeout");
});

test("33. resetSchedulerRuntimeStateForTests clears every field back to null", () => {
  recordSchedulerTickStarted(new Date());
  recordSchedulerTickSucceeded(new Date());
  resetSchedulerRuntimeStateForTests();
  assert.deepEqual(getSchedulerRuntimeState(), {
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessfulAt: null,
    lastFailedAt: null,
    lastError: null,
  });
});
