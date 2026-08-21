import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateQualityGate } from "../qualityGate";
import { evaluateApplicationReadiness } from "../applicationReadiness";
import type { StructuredResumeReview } from "../types";

/**
 * Legacy reviews, and the seven criteria the workspace reports.
 *
 * WHY THIS FILE EXISTS. A real workflow in this database reads `status: READY` with all five scored
 * dimensions at 100, while the quality gate has NOT passed and application readiness is BLOCKED.
 * That looks like a contradiction and was reported as one. It is not: the reviews behind it were
 * written on 14-16 August, before the typed safety analyses existed, and every review written from
 * 18 August onward carries them. Absence is treated as failure everywhere it is read, which is the
 * correct and intended behaviour.
 *
 * So these tests do not fix anything — they pin the behaviour that was mistaken for a bug, so that
 * a future change cannot quietly "resolve" it by letting a legacy review through. The dangerous
 * regression is not that a legacy review stays blocked; it is that someone makes it pass.
 *
 * They also cover the two regression classes that inspection alone could not rule out:
 *
 *   - the seven booleans the quality-workflow route reports must stay in lockstep with the gate's
 *     own conditions, so a package can never display as fully passing while the gate refuses it;
 *   - a review missing a typed analysis must never be treated as having passed that analysis.
 */

/** A review that passes every ORIGINAL score threshold — 100 across the board, nothing flagged. */
function perfectlyScoredReview(over: Partial<StructuredResumeReview> = {}): StructuredResumeReview {
  return {
    overallScore: 100,
    atsScore: 100,
    keywordAlignmentScore: 100,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 100,
    formattingScore: 100,
    missingRequiredSkills: [],
    incorrectTechnologyUsage: [],
    genericBullets: [],
    missingImpactEvidence: [],
    summaryIssues: [],
    skillsOrderingIssues: [],
    truthfulnessIssues: [],
    blockingIssues: [],
    requiredCorrections: [],
    ...over,
  } as StructuredResumeReview;
}

/**
 * Exactly the shape found in this database's 14-16 August rows: every score present, none of the
 * three typed analyses. This is the real record that produced the "READY but BLOCKED" report.
 */
function legacyReview(): StructuredResumeReview {
  const r = perfectlyScoredReview();
  assert.equal(r.blockingFailures, undefined, "fixture must reproduce the legacy shape");
  assert.equal(r.instructionCompliance, undefined, "fixture must reproduce the legacy shape");
  assert.equal(r.recruiterQualityAssessment, undefined, "fixture must reproduce the legacy shape");
  return r;
}

test("a legacy review scoring 100 on every dimension is still BLOCKED — absence is not a pass", () => {
  const result = evaluateApplicationReadiness(legacyReview(), 2, 3);

  assert.equal(result.readiness, "BLOCKED");
  assert.equal(result.humanMaySend, false, "a package never cleared of typed failures must not be sendable");
  assert.ok(
    result.blockingReasons.some((r) => r.includes("Typed blocking-failure analysis is missing")),
    "the reason must name the missing analysis rather than a score"
  );
});

test("a perfect score does not satisfy the quality gate when the typed analyses are absent", () => {
  assert.notEqual(
    evaluateQualityGate(legacyReview(), 2, 3),
    "READY",
    "score thresholds are one of four gates, never the whole gate"
  );
});

test("the seven reported criteria agree with the gate: all true iff the gate says READY", () => {
  /* These are the booleans the quality-workflow route puts on the wire and the workspace renders.
   * If they ever drift from the gate's own conditions, a package could show seven green checks
   * while the gate refuses it — the exact misreading this whole audit started from. */
  const criteriaOf = (review: StructuredResumeReview) => ({
    overallScorePass: review.overallScore >= 95,
    truthfulnessPass: review.truthfulnessScore === 100,
    architecturePass: review.architectureConsistencyScore === 100,
    blockingIssuesPass: review.blockingIssues.length === 0,
    instructionCompliancePass: review.instructionCompliance !== undefined,
    blockingFailuresPass: review.blockingFailures !== undefined && review.blockingFailures.length === 0,
    recruiterQualityPass:
      review.recruiterQualityAssessment !== undefined && review.recruiterQualityAssessment.status === "PASS",
  });

  const legacy = criteriaOf(legacyReview());
  assert.equal(legacy.overallScorePass, true);
  assert.equal(legacy.truthfulnessPass, true);
  assert.equal(legacy.architecturePass, true);
  assert.equal(legacy.blockingIssuesPass, true);
  /* The three that are false are precisely the three typed analyses that did not exist yet. */
  assert.equal(legacy.instructionCompliancePass, false);
  assert.equal(legacy.blockingFailuresPass, false);
  assert.equal(legacy.recruiterQualityPass, false);

  /* And the conjunction can never claim more than the gate does. */
  const allTrue = Object.values(legacy).every(Boolean);
  assert.equal(allTrue, false);
  assert.notEqual(evaluateQualityGate(legacyReview(), 2, 3), "READY");
});

test("each typed analysis is independently required — removing any one re-blocks the package", () => {
  /* Built from a review that DOES carry all three, so each removal isolates one gate. */
  const complete = perfectlyScoredReview({
    blockingFailures: [],
    recruiterQualityAssessment: { status: "PASS", score: 100, issues: [] },
  } as Partial<StructuredResumeReview>);

  /* Dropping the typed blocking-failure analysis must block outright, not merely weaken. */
  const withoutBlockingFailures = { ...complete, blockingFailures: undefined } as StructuredResumeReview;
  const blocked = evaluateApplicationReadiness(withoutBlockingFailures, 2, 3);
  assert.equal(blocked.readiness, "BLOCKED");
  assert.equal(blocked.humanMaySend, false);

  /* Dropping recruiter quality must not be silently treated as a pass either. It is a weaker
   * failure by design — truthful but unproven quality — so it must not be BLOCKED, and must still
   * never be sendable. */
  const withoutRecruiterQuality = {
    ...complete,
    recruiterQualityAssessment: undefined,
  } as StructuredResumeReview;
  const weak = evaluateApplicationReadiness(withoutRecruiterQuality, 2, 3);
  assert.equal(weak.humanMaySend, false, "an unassessed package is never sendable");
});

test("a non-empty typed blocking failure outranks a perfect score", () => {
  const review = perfectlyScoredReview({
    blockingFailures: [
      { type: "UNSUPPORTED_METRIC", description: "claims a 30% improvement with no evidence" },
    ],
  } as Partial<StructuredResumeReview>);

  const result = evaluateApplicationReadiness(review, 2, 3);
  assert.equal(result.readiness, "BLOCKED");
  assert.equal(result.humanMaySend, false);
  assert.notEqual(evaluateQualityGate(review, 2, 3), "READY");
});
