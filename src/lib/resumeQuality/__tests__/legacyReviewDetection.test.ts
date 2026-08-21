import assert from "node:assert/strict";
import { test } from "node:test";
import { isLegacyReviewMissingTypedSafetyAnalysis, canRevalidate } from "../legacyReview";
import type { StructuredResumeReview } from "../types";

/**
 * The detector that decides whether "Re-run validation" is offered.
 *
 * The risk it guards is not that a legacy review stays blocked — that is correct — but that a
 * genuinely FAILING review gets dressed up as a schema problem, so a candidate is told to refresh
 * validation when the real answer is that the resume claims something it cannot support.
 */

function review(over: Partial<StructuredResumeReview> = {}): StructuredResumeReview {
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

test("a review with none of the three typed analyses and no findings is legacy", () => {
  assert.equal(isLegacyReviewMissingTypedSafetyAnalysis(review()), true);
});

test("a review carrying a typed blocking failure is NOT legacy — it is failing", () => {
  const failing = review({
    blockingFailures: [{ type: "UNSUPPORTED_METRIC", description: "claims 30% with no evidence" }],
  } as Partial<StructuredResumeReview>);
  assert.equal(isLegacyReviewMissingTypedSafetyAnalysis(failing), false);
});

test("a review that ran instruction compliance is NOT legacy, even if it failed it", () => {
  const assessed = review({ instructionCompliance: { checks: {} } } as unknown as Partial<StructuredResumeReview>);
  assert.equal(isLegacyReviewMissingTypedSafetyAnalysis(assessed), false);
});

test("a review that ran recruiter quality is NOT legacy, even on FAIL", () => {
  const assessed = review({
    recruiterQualityAssessment: { status: "FAIL", score: 40, issues: [] },
  } as Partial<StructuredResumeReview>);
  assert.equal(isLegacyReviewMissingTypedSafetyAnalysis(assessed), false);
});

test("a review with no typed analyses but a real truthfulness finding is NOT legacy", () => {
  /* The blocking state is about the resume, not the schema — refreshing would misrepresent it. */
  assert.equal(isLegacyReviewMissingTypedSafetyAnalysis(review({ truthfulnessScore: 80 })), false);
  assert.equal(
    isLegacyReviewMissingTypedSafetyAnalysis(review({ blockingIssues: ["placeholder contact"] })),
    false
  );
  assert.equal(
    isLegacyReviewMissingTypedSafetyAnalysis(review({ architectureConsistencyScore: 90 })),
    false
  );
});

test("a partially-analysed review is NOT legacy — guessing which half to trust is the failure mode", () => {
  const partial = review({ blockingFailures: [] } as Partial<StructuredResumeReview>);
  assert.equal(isLegacyReviewMissingTypedSafetyAnalysis(partial), false);
});

test("re-validation is refused once the iteration budget is spent", () => {
  assert.equal(canRevalidate({ current_iteration: 2, max_iterations: 3 }), true);
  assert.equal(canRevalidate({ current_iteration: 3, max_iterations: 3 }), false);
});
