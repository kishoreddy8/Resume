import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyConnectorHealth,
  classifyMatchingHealth,
  classifyNotificationsHealth,
  classifyResumePipelineHealth,
  classifyScanningHealth,
  classifySchedulerHealth,
} from "../healthRules";
import type { SchedulerRuntimeState } from "@/lib/scheduler/state";
import type { SchedulerSettings } from "@/lib/scheduler/window";

function scheduler(overrides: Partial<SchedulerSettings> = {}): SchedulerSettings {
  return {
    enabled: true,
    scanEnabled: true,
    productionEnabled: true,
    evaluationEnabled: true,
    writerEnabled: true,
    intervalMinutes: 60,
    windowStartHour: 0,
    windowEndHour: 24,
    timezone: "UTC",
    ...overrides,
  };
}

function runtime(overrides: Partial<SchedulerRuntimeState> = {}): SchedulerRuntimeState {
  return { lastEvaluatedAt: null, lastStartedAt: null, lastCompletedAt: null, lastSuccessfulAt: null, lastFailedAt: null, lastError: null, ...overrides };
}

// --- Scheduler ------------------------------------------------------------------------------

test("8. scheduler disabled classified correctly", () => {
  assert.equal(classifySchedulerHealth({ settings: scheduler({ enabled: false }), runtime: runtime() }), "DISABLED");
});

test("scheduler never run -> NO_DATA", () => {
  assert.equal(classifySchedulerHealth({ settings: scheduler(), runtime: runtime() }), "NO_DATA");
});

test("10. scheduler failed classified correctly (most recent outcome is a failure)", () => {
  const state = runtime({
    lastStartedAt: "2026-01-15T09:00:00.000Z",
    lastCompletedAt: "2026-01-15T09:05:00.000Z",
    lastFailedAt: "2026-01-15T09:05:00.000Z",
    lastSuccessfulAt: "2026-01-15T08:00:00.000Z",
    lastError: "boom",
  });
  const now = new Date("2026-01-15T09:06:00.000Z");
  assert.equal(classifySchedulerHealth({ settings: scheduler(), runtime: state, now }), "ERROR");
});

test("a later success supersedes an earlier failure -> not ERROR", () => {
  const state = runtime({
    lastStartedAt: "2026-01-15T09:00:00.000Z",
    lastCompletedAt: "2026-01-15T09:05:00.000Z",
    lastFailedAt: "2026-01-15T08:00:00.000Z",
    lastSuccessfulAt: "2026-01-15T09:05:00.000Z",
    lastError: null,
  });
  const now = new Date("2026-01-15T09:06:00.000Z");
  assert.equal(classifySchedulerHealth({ settings: scheduler(), runtime: state, now }), "HEALTHY");
});

test("11. stale/overdue scheduler classification correct (past next eligible run by more than one interval)", () => {
  const state = runtime({
    lastStartedAt: "2026-01-15T09:00:00.000Z",
    lastCompletedAt: "2026-01-15T09:05:00.000Z",
    lastSuccessfulAt: "2026-01-15T09:05:00.000Z",
  });
  // intervalMinutes=60 -> next eligible ~10:00; 2+ hours later is more than one interval overdue.
  const now = new Date("2026-01-15T12:30:00.000Z");
  assert.equal(classifySchedulerHealth({ settings: scheduler({ intervalMinutes: 60 }), runtime: state, now }), "WARNING");
});

test("9. scheduler healthy classified correctly (recently succeeded, not overdue)", () => {
  const state = runtime({
    lastStartedAt: "2026-01-15T09:00:00.000Z",
    lastCompletedAt: "2026-01-15T09:05:00.000Z",
    lastSuccessfulAt: "2026-01-15T09:05:00.000Z",
  });
  const now = new Date("2026-01-15T09:10:00.000Z");
  assert.equal(classifySchedulerHealth({ settings: scheduler({ intervalMinutes: 60 }), runtime: state, now }), "HEALTHY");
});

// --- Scanning -------------------------------------------------------------------------------

test("scanning: zero runs, scheduler enabled -> WARNING", () => {
  assert.equal(classifyScanningHealth({ window: { runs: 0, successCount: 0, partialCount: 0, failedCount: 0 }, schedulerEnabled: true }), "WARNING");
});

test("scanning: zero runs, scheduler disabled -> NO_DATA", () => {
  assert.equal(classifyScanningHealth({ window: { runs: 0, successCount: 0, partialCount: 0, failedCount: 0 }, schedulerEnabled: false }), "NO_DATA");
});

test("scanning: all successes -> HEALTHY", () => {
  assert.equal(classifyScanningHealth({ window: { runs: 5, successCount: 5, partialCount: 0, failedCount: 0 }, schedulerEnabled: true }), "HEALTHY");
});

test("scanning: some partial -> WARNING", () => {
  assert.equal(classifyScanningHealth({ window: { runs: 5, successCount: 4, partialCount: 1, failedCount: 0 }, schedulerEnabled: true }), "WARNING");
});

test("scanning: all failed, zero success -> ERROR", () => {
  assert.equal(classifyScanningHealth({ window: { runs: 3, successCount: 0, partialCount: 0, failedCount: 3 }, schedulerEnabled: true }), "ERROR");
});

// --- Connectors -----------------------------------------------------------------------------

test("16. connector healthy count correct — zero degraded/down -> HEALTHY", () => {
  assert.equal(classifyConnectorHealth({ healthy: 10, degraded: 0, down: 0, unknown: 3 }), "HEALTHY");
});

test("17. connector degraded/failing count correct — degraded present, no down -> WARNING", () => {
  assert.equal(classifyConnectorHealth({ healthy: 10, degraded: 2, down: 0, unknown: 0 }), "WARNING");
});

test("connectors: any down -> ERROR regardless of degraded count", () => {
  assert.equal(classifyConnectorHealth({ healthy: 10, degraded: 0, down: 1, unknown: 0 }), "ERROR");
});

test("connectors: only unknown (never scanned) -> NO_DATA", () => {
  assert.equal(classifyConnectorHealth({ healthy: 0, degraded: 0, down: 0, unknown: 50 }), "NO_DATA");
});

test("connectors: no companies at all -> NO_DATA", () => {
  assert.equal(classifyConnectorHealth({ healthy: 0, degraded: 0, down: 0, unknown: 0 }), "NO_DATA");
});

// --- Matching -------------------------------------------------------------------------------

test("matching: zero runs -> NO_DATA", () => {
  assert.equal(classifyMatchingHealth({ runs: 0, jobsErrored: 0 }), "NO_DATA");
});

test("matching: errored jobs present -> WARNING", () => {
  assert.equal(classifyMatchingHealth({ runs: 3, jobsErrored: 2 }), "WARNING");
});

test("matching: runs with zero errors -> HEALTHY", () => {
  assert.equal(classifyMatchingHealth({ runs: 3, jobsErrored: 0 }), "HEALTHY");
});

// --- Notifications ---------------------------------------------------------------------------

test("notifications: zero ever created -> NO_DATA", () => {
  assert.equal(classifyNotificationsHealth(0), "NO_DATA");
});

test("notifications: at least one ever created -> HEALTHY", () => {
  assert.equal(classifyNotificationsHealth(9), "HEALTHY");
});

// --- Resume pipeline --------------------------------------------------------------------------

test("resume pipeline: zero workflows -> NO_DATA", () => {
  assert.equal(classifyResumePipelineHealth({ workflows: 0, failed: 0 }), "NO_DATA");
});

test("resume pipeline: any FAILED -> WARNING", () => {
  assert.equal(classifyResumePipelineHealth({ workflows: 4, failed: 1 }), "WARNING");
});

test("resume pipeline: no FAILED -> HEALTHY", () => {
  assert.equal(classifyResumePipelineHealth({ workflows: 4, failed: 0 }), "HEALTHY");
});
