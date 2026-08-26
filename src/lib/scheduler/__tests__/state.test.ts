import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let getSchedulerRuntimeState: typeof import("../state").getSchedulerRuntimeState;
let recordSchedulerTickEvaluated: typeof import("../state").recordSchedulerTickEvaluated;
let recordSchedulerTickStarted: typeof import("../state").recordSchedulerTickStarted;
let recordSchedulerTickSucceeded: typeof import("../state").recordSchedulerTickSucceeded;
let recordSchedulerTickFailed: typeof import("../state").recordSchedulerTickFailed;
let resetSchedulerRuntimeStateForTests: typeof import("../state").resetSchedulerRuntimeStateForTests;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduler-state-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("@/db"));
  ({ getSchedulerRuntimeState, recordSchedulerTickEvaluated, recordSchedulerTickStarted, recordSchedulerTickSucceeded, recordSchedulerTickFailed, resetSchedulerRuntimeStateForTests } =
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
    lastEvaluatedAt: null,
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
    lastEvaluatedAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessfulAt: null,
    lastFailedAt: null,
    lastError: null,
  });
});

test("OPS1-SCHED-02: recordSchedulerTickEvaluated persists liveness without claiming a scan ran", () => {
  /* ADMIN-OPS-1 — the whole point of the new signal: a tick that evaluates and decides to do
   * nothing must leave a trace, and that trace must not imply a scan attempt. */
  const when = new Date("2026-08-26T12:00:00.000Z");
  recordSchedulerTickEvaluated(when);

  const state = getSchedulerRuntimeState();
  assert.equal(state.lastEvaluatedAt, when.toISOString(), "evaluation is recorded");
  assert.equal(state.lastStartedAt, null, "no scan attempt is implied");
  assert.equal(state.lastSuccessfulAt, null);
  assert.equal(state.lastCompletedAt, null);
});

test("OPS1-SCHED-02b: evaluation and scan-attempt bookkeeping are independent", () => {
  recordSchedulerTickEvaluated(new Date("2026-08-26T12:00:00.000Z"));
  recordSchedulerTickStarted(new Date("2026-08-26T12:00:01.000Z"));
  recordSchedulerTickSucceeded(new Date("2026-08-26T12:00:09.000Z"));

  const state = getSchedulerRuntimeState();
  assert.equal(state.lastEvaluatedAt, "2026-08-26T12:00:00.000Z");
  assert.equal(state.lastStartedAt, "2026-08-26T12:00:01.000Z");
  assert.equal(state.lastSuccessfulAt, "2026-08-26T12:00:09.000Z");
});
