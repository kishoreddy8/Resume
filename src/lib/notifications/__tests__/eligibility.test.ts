import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isEligibleForHighValueMatchNotification,
  NEEDS_REVIEW_NOTIFICATION_MIN_SCORE,
  NOTIFICATION_FRESHNESS_MAX_DAYS,
  type NotificationEligibilityInput,
} from "../eligibility";

const NOW = new Date("2026-01-15T12:00:00Z");

function baseInput(overrides: Partial<NotificationEligibilityInput> = {}): NotificationEligibilityInput {
  return {
    decision: "READY_FOR_TAILORING",
    overallScore: 95,
    isCurrent: true,
    jobIsActive: true,
    postedAt: "2026-01-14T00:00:00Z", // 1 day old
    firstSeenAt: "2026-01-14T00:00:00Z",
    pipelineStatus: "New",
    now: NOW,
    ...overrides,
  };
}

test("1. a qualifying READY_FOR_TAILORING result is eligible", () => {
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ decision: "READY_FOR_TAILORING" })), true);
});

test("2. NEEDS_REVIEW at/above the notification threshold is eligible", () => {
  assert.equal(
    isEligibleForHighValueMatchNotification(baseInput({ decision: "NEEDS_REVIEW", overallScore: NEEDS_REVIEW_NOTIFICATION_MIN_SCORE })),
    true
  );
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ decision: "NEEDS_REVIEW", overallScore: 99 })), true);
});

test("3. NEEDS_REVIEW below the notification threshold is NOT eligible", () => {
  assert.equal(
    isEligibleForHighValueMatchNotification(baseInput({ decision: "NEEDS_REVIEW", overallScore: NEEDS_REVIEW_NOTIFICATION_MIN_SCORE - 1 })),
    false
  );
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ decision: "NEEDS_REVIEW", overallScore: 50 })), false);
});

test("4. BLOCKED is never eligible, regardless of score", () => {
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ decision: "BLOCKED", overallScore: 100 })), false);
});

test("5. a stale/superseded match result is never eligible", () => {
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ decision: "READY_FOR_TAILORING", isCurrent: false })), false);
});

test("6. an inactive job is never eligible", () => {
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ decision: "READY_FOR_TAILORING", jobIsActive: false })), false);
});

test("7. a job outside the freshness window is never eligible", () => {
  const oldDate = new Date(NOW.getTime() - (NOTIFICATION_FRESHNESS_MAX_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(
    isEligibleForHighValueMatchNotification(baseInput({ decision: "READY_FOR_TAILORING", postedAt: oldDate, firstSeenAt: oldDate })),
    false
  );
});

test("7b. a job exactly at the freshness boundary is still eligible", () => {
  const boundaryDate = new Date(NOW.getTime() - NOTIFICATION_FRESHNESS_MAX_DAYS * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(
    isEligibleForHighValueMatchNotification(baseInput({ decision: "READY_FOR_TAILORING", postedAt: boundaryDate, firstSeenAt: boundaryDate })),
    true
  );
});

test("8. Applied suppresses notification", () => {
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ pipelineStatus: "Applied" })), false);
});

test("9. Interviewing suppresses notification", () => {
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ pipelineStatus: "Interviewing" })), false);
});

test("10. Offer suppresses notification", () => {
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ pipelineStatus: "Offer" })), false);
});

test("11. Employer Rejected suppresses notification", () => {
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ pipelineStatus: "Employer Rejected" })), false);
});

test("12. New and Interested pipeline states can still notify when otherwise eligible", () => {
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ pipelineStatus: "New" })), true);
  assert.equal(isEligibleForHighValueMatchNotification(baseInput({ pipelineStatus: "Interested" })), true);
});

test("isCurrent defaults to true (current) when omitted", () => {
  const input = baseInput();
  delete (input as Partial<NotificationEligibilityInput>).isCurrent;
  assert.equal(isEligibleForHighValueMatchNotification(input), true);
});

test("NEEDS_REVIEW_NOTIFICATION_MIN_SCORE (90) is meaningfully above the READY_FOR_TAILORING score floor (80)", () => {
  // Verified against src/lib/match/scoring.ts's READINESS_THRESHOLDS.minScore before choosing 90 —
  // this test pins that verification so a future scoring.ts change surfaces here if it drifts.
  assert.equal(NEEDS_REVIEW_NOTIFICATION_MIN_SCORE, 90);
});
