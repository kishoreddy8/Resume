import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyCandidateJobBucket,
  computeCandidateJobBadges,
  type CandidateJobBucketInput,
} from "../candidateJobBucket";

const now = new Date("2026-08-14T12:00:00Z");
const todayIso = "2026-08-14T08:00:00Z";
const threeDaysAgoIso = "2026-08-11T12:00:00Z";

test("1. Fresh job without match or pipeline progress -> NEW_TODAY", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "New",
    postedAt: todayIso,
    firstSeenAt: todayIso,
    now,
  };
  assert.equal(classifyCandidateJobBucket(input), "NEW_TODAY");
  const badges = computeCandidateJobBadges(input);
  assert.equal(badges.isNewToday, true);
  assert.equal(badges.isReadyForTailoring, false);
});

test("2. Current high score (>=90) that is not READY_FOR_TAILORING or NEEDS_REVIEW -> TOP_MATCH", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "New",
    postedAt: threeDaysAgoIso,
    firstSeenAt: threeDaysAgoIso,
    match: {
      decision: "BLOCKED", // blocked can NOT be top match
      overallScore: 95,
      isCurrent: true,
    },
    now,
  };
  // BLOCKED with 95 score is NOT TOP_MATCH
  assert.equal(classifyCandidateJobBucket(input), null);

  const eligibleTopMatchInput: CandidateJobBucketInput = {
    pipelineStatus: "New",
    postedAt: threeDaysAgoIso,
    firstSeenAt: threeDaysAgoIso,
    match: {
      decision: "NOT_EVALUATED" as unknown as import("@/lib/match/types").Decision,
      overallScore: 92,
      isCurrent: true,
    },
    now,
  };
  assert.equal(classifyCandidateJobBucket(eligibleTopMatchInput), "TOP_MATCH");
});

test("3. READY_FOR_TAILORING decision -> READY_FOR_TAILORING", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "New",
    postedAt: threeDaysAgoIso,
    firstSeenAt: threeDaysAgoIso,
    match: {
      decision: "READY_FOR_TAILORING",
      overallScore: 88,
      isCurrent: true,
    },
    now,
  };
  assert.equal(classifyCandidateJobBucket(input), "READY_FOR_TAILORING");
});

test("4. NEEDS_REVIEW decision -> NEEDS_REVIEW", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "New",
    postedAt: threeDaysAgoIso,
    firstSeenAt: threeDaysAgoIso,
    match: {
      decision: "NEEDS_REVIEW",
      overallScore: 82,
      isCurrent: true,
    },
    now,
  };
  assert.equal(classifyCandidateJobBucket(input), "NEEDS_REVIEW");
});

test("5. Phase 3 READY workflow -> READY_TO_APPLY", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "New",
    postedAt: threeDaysAgoIso,
    firstSeenAt: threeDaysAgoIso,
    match: {
      decision: "READY_FOR_TAILORING",
      overallScore: 92,
      isCurrent: true,
    },
    latestResumeQualityWorkflow: {
      status: "READY",
    },
    now,
  };
  // READY_TO_APPLY outranks READY_FOR_TAILORING
  assert.equal(classifyCandidateJobBucket(input), "READY_TO_APPLY");
});

test("6. Applied overrides READY_TO_APPLY", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "Applied",
    postedAt: todayIso,
    firstSeenAt: todayIso,
    match: {
      decision: "READY_FOR_TAILORING",
      overallScore: 96,
      isCurrent: true,
    },
    latestResumeQualityWorkflow: {
      status: "READY",
    },
    now,
  };
  assert.equal(classifyCandidateJobBucket(input), "APPLIED");
});

test("7. Interviewing overrides APPLIED and READY_TO_APPLY", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "Interviewing",
    postedAt: todayIso,
    firstSeenAt: todayIso,
    latestResumeQualityWorkflow: {
      status: "READY",
    },
    now,
  };
  assert.equal(classifyCandidateJobBucket(input), "INTERVIEWING");
});

test("8. Precedence: READY_FOR_TAILORING outranks TOP_MATCH and NEW_TODAY", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "New",
    postedAt: todayIso,
    firstSeenAt: todayIso,
    match: {
      decision: "READY_FOR_TAILORING",
      overallScore: 95,
      isCurrent: true,
    },
    now,
  };
  assert.equal(classifyCandidateJobBucket(input), "READY_FOR_TAILORING");
  const badges = computeCandidateJobBadges(input);
  assert.equal(badges.isReadyForTailoring, true);
  assert.equal(badges.isTopMatch, true);
  assert.equal(badges.isNewToday, true);
});

test("9. Precedence: NEEDS_REVIEW outranks TOP_MATCH and NEW_TODAY", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "New",
    postedAt: todayIso,
    firstSeenAt: todayIso,
    match: {
      decision: "NEEDS_REVIEW",
      overallScore: 92,
      isCurrent: true,
    },
    now,
  };
  assert.equal(classifyCandidateJobBucket(input), "NEEDS_REVIEW");
  const badges = computeCandidateJobBadges(input);
  assert.equal(badges.isNeedsReview, true);
  assert.equal(badges.isTopMatch, true);
  assert.equal(badges.isNewToday, true);
});

test("10. Stale match (isCurrent=false) cannot surface as READY_FOR_TAILORING or TOP_MATCH", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "New",
    postedAt: threeDaysAgoIso,
    firstSeenAt: threeDaysAgoIso,
    match: {
      decision: "READY_FOR_TAILORING",
      overallScore: 98,
      isCurrent: false, // Stale!
    },
    now,
  };
  assert.equal(classifyCandidateJobBucket(input), null);
});

test("11. Stale match on fresh job surfaces as NEW_TODAY, not READY_FOR_TAILORING", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "New",
    postedAt: todayIso,
    firstSeenAt: todayIso,
    match: {
      decision: "READY_FOR_TAILORING",
      overallScore: 98,
      isCurrent: false, // Stale!
    },
    now,
  };
  assert.equal(classifyCandidateJobBucket(input), "NEW_TODAY");
});

test("12. Terminal status 'Offer' does NOT appear in active buckets", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "Offer",
    postedAt: todayIso,
    firstSeenAt: todayIso,
    match: {
      decision: "READY_FOR_TAILORING",
      overallScore: 95,
      isCurrent: true,
    },
    latestResumeQualityWorkflow: {
      status: "READY",
    },
    now,
  };
  assert.equal(classifyCandidateJobBucket(input), null);
  const badges = computeCandidateJobBadges(input);
  assert.equal(badges.isTerminal, true);
});

test("13. Terminal status 'Employer Rejected' does NOT appear in active buckets", () => {
  const input: CandidateJobBucketInput = {
    pipelineStatus: "Employer Rejected",
    postedAt: todayIso,
    firstSeenAt: todayIso,
    match: {
      decision: "READY_FOR_TAILORING",
      overallScore: 95,
      isCurrent: true,
    },
    latestResumeQualityWorkflow: {
      status: "READY",
    },
    now,
  };
  assert.equal(classifyCandidateJobBucket(input), null);
  const badges = computeCandidateJobBadges(input);
  assert.equal(badges.isTerminal, true);
});
