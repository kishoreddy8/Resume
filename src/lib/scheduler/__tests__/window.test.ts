import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isEnabled,
  isIntervalDue,
  isSchedulerDueToRun,
  isWithinWindow,
  nextEligibleRunAt,
  type SchedulerSettings,
} from "../window";

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

test("1. isEnabled reflects scheduler.enabled=true", () => {
  assert.equal(isEnabled(scheduler({ enabled: true })), true);
});

test("2. isEnabled reflects scheduler.enabled=false", () => {
  assert.equal(isEnabled(scheduler({ enabled: false })), false);
});

test("3. isWithinWindow: default full-day window (0-24) is true at any UTC hour", () => {
  assert.equal(isWithinWindow(new Date("2026-01-15T00:00:00Z"), scheduler()), true);
  assert.equal(isWithinWindow(new Date("2026-01-15T23:00:00Z"), scheduler()), true);
});

test("4. isWithinWindow: hour before windowStartHour is false", () => {
  const s = scheduler({ windowStartHour: 9, windowEndHour: 17 });
  assert.equal(isWithinWindow(new Date("2026-01-15T08:00:00Z"), s), false);
});

test("5. isWithinWindow: hour exactly at windowStartHour is true (start inclusive)", () => {
  const s = scheduler({ windowStartHour: 9, windowEndHour: 17 });
  assert.equal(isWithinWindow(new Date("2026-01-15T09:00:00Z"), s), true);
});

test("6. isWithinWindow: hour exactly at windowEndHour is false (end exclusive)", () => {
  const s = scheduler({ windowStartHour: 9, windowEndHour: 17 });
  assert.equal(isWithinWindow(new Date("2026-01-15T17:00:00Z"), s), false);
});

test("7. isWithinWindow: hour one before windowEndHour is true", () => {
  const s = scheduler({ windowStartHour: 9, windowEndHour: 17 });
  assert.equal(isWithinWindow(new Date("2026-01-15T16:30:00Z"), s), true);
});

test("8. isWithinWindow: honors a non-UTC timezone (America/New_York, EST = UTC-5 in January)", () => {
  const s = scheduler({ windowStartHour: 9, windowEndHour: 17, timezone: "America/New_York" });
  // 14:00 UTC = 09:00 EST — inside a 9-17 window.
  assert.equal(isWithinWindow(new Date("2026-01-15T14:00:00Z"), s), true);
  // 13:00 UTC = 08:00 EST — before a 9-17 window.
  assert.equal(isWithinWindow(new Date("2026-01-15T13:00:00Z"), s), false);
});

test("9. isWithinWindow: the same instant can be in-window in one timezone and out-of-window in another", () => {
  const s1 = scheduler({ windowStartHour: 9, windowEndHour: 17, timezone: "UTC" });
  const s2 = scheduler({ windowStartHour: 9, windowEndHour: 17, timezone: "Asia/Kolkata" });
  const instant = new Date("2026-01-15T09:30:00Z"); // 09:30 UTC = 15:00 IST (+5:30)
  assert.equal(isWithinWindow(instant, s1), true);
  assert.equal(isWithinWindow(instant, s2), true); // 15:00 is still within 9-17 for IST too
  const instant2 = new Date("2026-01-15T20:00:00Z"); // 20:00 UTC = 01:30 IST next day
  assert.equal(isWithinWindow(instant2, s1), false); // 20:00 UTC outside 9-17
  assert.equal(isWithinWindow(instant2, s2), false); // 01:30 IST outside 9-17
});

test("10. isIntervalDue: never run before (lastStartedAt=null) is always due", () => {
  assert.equal(isIntervalDue(null, 60, new Date("2026-01-15T12:00:00Z")), true);
});

test("11. isIntervalDue: elapsed >= intervalMinutes is due", () => {
  const last = "2026-01-15T11:00:00.000Z";
  const now = new Date("2026-01-15T12:00:00Z"); // exactly 60 minutes later
  assert.equal(isIntervalDue(last, 60, now), true);
});

test("12. isIntervalDue: elapsed < intervalMinutes is not due", () => {
  const last = "2026-01-15T11:31:00.000Z";
  const now = new Date("2026-01-15T12:00:00Z"); // 29 minutes later
  assert.equal(isIntervalDue(last, 30, now), false);
});

test("13. isSchedulerDueToRun: false when disabled, regardless of window/interval", () => {
  const s = scheduler({ enabled: false, windowStartHour: 0, windowEndHour: 24 });
  assert.equal(isSchedulerDueToRun(s, null, new Date("2026-01-15T12:00:00Z")), false);
});

test("14. isSchedulerDueToRun: false when outside window even if enabled and interval due", () => {
  const s = scheduler({ enabled: true, windowStartHour: 9, windowEndHour: 17 });
  assert.equal(isSchedulerDueToRun(s, null, new Date("2026-01-15T20:00:00Z")), false);
});

test("15. isSchedulerDueToRun: true when enabled, within window, and interval due", () => {
  const s = scheduler({ enabled: true, windowStartHour: 0, windowEndHour: 24, intervalMinutes: 30 });
  assert.equal(isSchedulerDueToRun(s, null, new Date("2026-01-15T12:00:00Z")), true);
});

test("16. nextEligibleRunAt: null when scheduler is disabled", () => {
  const s = scheduler({ enabled: false });
  assert.equal(nextEligibleRunAt(s, null, new Date("2026-01-15T12:00:00Z")), null);
});

test("17. nextEligibleRunAt: returns ~now when already due and within window", () => {
  const s = scheduler({ enabled: true, windowStartHour: 0, windowEndHour: 24 });
  const now = new Date("2026-01-15T12:00:00Z");
  const result = nextEligibleRunAt(s, null, now);
  assert.ok(result);
  assert.equal(new Date(result!).getTime(), now.getTime());
});

test("18. nextEligibleRunAt: when currently outside window, returns a future instant that IS within the window", () => {
  const s = scheduler({ enabled: true, windowStartHour: 9, windowEndHour: 17, intervalMinutes: 30 });
  const now = new Date("2026-01-15T20:00:00Z"); // 8pm UTC, outside 9-17
  const result = nextEligibleRunAt(s, null, now);
  assert.ok(result);
  const resultDate = new Date(result!);
  assert.ok(resultDate.getTime() > now.getTime());
  assert.equal(isWithinWindow(resultDate, s), true);
});

test("19. nextEligibleRunAt: respects a not-yet-due interval by not returning before the interval elapses", () => {
  const s = scheduler({ enabled: true, windowStartHour: 0, windowEndHour: 24, intervalMinutes: 120 });
  const lastStartedAt = "2026-01-15T12:00:00.000Z";
  const now = new Date("2026-01-15T12:30:00Z");
  const result = nextEligibleRunAt(s, lastStartedAt, now);
  assert.ok(result);
  // Interval-ready is 14:00Z (12:00 + 120min); with a full-day window that's also the answer.
  assert.equal(new Date(result!).toISOString(), "2026-01-15T14:00:00.000Z");
});
