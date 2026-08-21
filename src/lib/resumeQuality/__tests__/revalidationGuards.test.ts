import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateApplicationReadiness } from "../applicationReadiness";
import { isLegacyReviewMissingTypedSafetyAnalysis, canRevalidate } from "../legacyReview";
import type { StructuredResumeReview } from "../types";

/**
 * The recovery path's guarantees, stated as tests.
 *
 * The action exists so a legacy package is not permanently stuck. The danger is the opposite of the
 * one it solves: that "re-run validation" becomes a way to make something sendable without anything
 * actually having been checked. These pin the properties that prevent that.
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

test("the action is offered only for the legacy shape, never for a failing review", () => {
  assert.equal(isLegacyReviewMissingTypedSafetyAnalysis(review()), true);

  const genuinelyFailing = review({
    blockingFailures: [{ type: "UNSUPPORTED_CLAIM", description: "claimed Kafka" }],
  } as Partial<StructuredResumeReview>);
  assert.equal(isLegacyReviewMissingTypedSafetyAnalysis(genuinelyFailing), false);
});

test("a fresh review that still fails leaves the package blocked — re-running is not clearing", () => {
  /* The shape a re-run can legitimately produce: analyses now present, and one of them failed. */
  const afterRerun = review({
    blockingFailures: [{ type: "PLACEHOLDER_CONTACT", description: "your.email@example.com" }],
  } as Partial<StructuredResumeReview>);

  const result = evaluateApplicationReadiness(afterRerun, 3, 3);
  assert.equal(result.readiness, "BLOCKED");
  assert.equal(result.humanMaySend, false);
  /* And the reason is the new, real one — not the legacy "analysis is missing" message. */
  assert.ok(!result.blockingReasons.some((r) => r.includes("Typed blocking-failure analysis is missing")));
  assert.ok(result.blockingReasons.some((r) => r.includes("PLACEHOLDER_CONTACT")));
});

test("a fresh review only becomes sendable through normal readiness evaluation", () => {
  const cleared = review({
    blockingFailures: [],
    recruiterQualityAssessment: { status: "PASS", score: 100, issues: [] },
  } as Partial<StructuredResumeReview>);

  /* Still not sendable: instructionCompliance has not run, and the gate requires it. Nothing about
   * having been "re-validated" shortcuts that. */
  assert.equal(evaluateApplicationReadiness(cleared, 3, 3).humanMaySend, false);
});

test("re-validation is refused once the iteration budget is spent, rather than overwriting history", () => {
  assert.equal(canRevalidate({ current_iteration: 3, max_iterations: 3 }), false);
  assert.equal(canRevalidate({ current_iteration: 1, max_iterations: 3 }), true);
});

test("a score of 100 never substitutes for a missing analysis, before or after a re-run", () => {
  const perfectButUnanalysed = review();
  const result = evaluateApplicationReadiness(perfectButUnanalysed, 3, 3);
  assert.equal(result.humanMaySend, false, "absence is failure, never a free pass");
});
