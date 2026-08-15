import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateQualityGate } from "../qualityGate";
import type { StructuredResumeReview } from "../types";
import { fullyCompliantInstructionCompliance } from "./complianceTestHelpers";

function perfectReview(overrides: Partial<StructuredResumeReview> = {}): StructuredResumeReview {
  return {
    overallScore: 97,
    atsScore: 96,
    keywordAlignmentScore: 95,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 95,
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
    // Resume Quality Hardening: evaluateQualityGate() now ALSO requires instructionCompliance to be
    // present, current, and fully PASS (see qualityGate.ts) — every "perfect" fixture in this file
    // needs one so these tests keep exercising the ORIGINAL four-condition rules they're named for,
    // not incidentally failing on the new, separately-tested compliance gate.
    instructionCompliance: fullyCompliantInstructionCompliance(),
    ...overrides,
  };
}

test("READY when overallScore >= 95, truthfulness/architecture are exactly 100, and there are zero blocking issues", () => {
  assert.equal(evaluateQualityGate(perfectReview(), 1, 3), "READY");
});

test("NOT READY when overallScore is below 95, even with perfect truthfulness/architecture and zero blocking issues", () => {
  const review = perfectReview({ overallScore: 94.9 });
  assert.equal(evaluateQualityGate(review, 1, 3), "IMPROVEMENT_NEEDED");
});

test("a high overall score never compensates for an imperfect truthfulness score — the exact 'never let a score hide a factual error' rule", () => {
  const review = perfectReview({ overallScore: 100, truthfulnessScore: 99 });
  assert.equal(evaluateQualityGate(review, 1, 3), "IMPROVEMENT_NEEDED");
});

test("a high overall score never compensates for an imperfect architecture-consistency score", () => {
  const review = perfectReview({ overallScore: 100, architectureConsistencyScore: 99 });
  assert.equal(evaluateQualityGate(review, 1, 3), "IMPROVEMENT_NEEDED");
});

test("a single blocking issue prevents READY regardless of every score being perfect", () => {
  const review = perfectReview({ overallScore: 100, blockingIssues: ["Claims AWS experience with no supporting evidence"] });
  assert.equal(evaluateQualityGate(review, 1, 3), "IMPROVEMENT_NEEDED");
});

test("iteration < maxIterations and the gate fails -> IMPROVEMENT_NEEDED", () => {
  const review = perfectReview({ overallScore: 50 });
  assert.equal(evaluateQualityGate(review, 1, 3), "IMPROVEMENT_NEEDED");
  assert.equal(evaluateQualityGate(review, 2, 3), "IMPROVEMENT_NEEDED");
});

test("iteration == maxIterations and the gate still fails -> NEEDS_HUMAN_REVIEW", () => {
  const review = perfectReview({ overallScore: 50 });
  assert.equal(evaluateQualityGate(review, 3, 3), "NEEDS_HUMAN_REVIEW");
});

test("maxIterations defaults to 3 in practice (documented contract, exercised via DEFAULT_MAX_ITERATIONS)", async () => {
  const { DEFAULT_MAX_ITERATIONS } = await import("../types");
  assert.equal(DEFAULT_MAX_ITERATIONS, 3);
});

test("READY is possible on iteration 1 — the gate never forces unnecessary improvement cycles when quality is already perfect", () => {
  assert.equal(evaluateQualityGate(perfectReview(), 1, 3), "READY");
});
