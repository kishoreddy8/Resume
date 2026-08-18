import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateApplicationReadiness } from "../applicationReadiness";
import { currentInstructionIdentity } from "../canonicalInstructions";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";
import type { BlockingFailure, ComplianceStatus, InstructionComplianceChecks, StructuredResumeReview } from "../types";

/**
 * Stage 25 — the canonical "can a human send this?" decision must separate UNSAFE from MEDIOCRE.
 * evaluateQualityGate collapses both into NEEDS_HUMAN_REVIEW once iterations are exhausted, which is
 * the right answer for the loop and the wrong answer for a person about to send an application.
 */

function allChecks(status: ComplianceStatus): InstructionComplianceChecks {
  const checks = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) checks[name] = status;
  return checks;
}

/** Compliance computed against the CURRENT canonical instruction identity, with every check PASS —
 *  anything less would fail the gate for a reason unrelated to what each test is isolating. */
function passingCompliance(): StructuredResumeReview["instructionCompliance"] {
  return { ...currentInstructionIdentity(), checks: allChecks("PASS"), notes: [] };
}

function review(overrides: Partial<StructuredResumeReview> = {}): StructuredResumeReview {
  return {
    overallScore: 97,
    atsScore: 95,
    keywordAlignmentScore: 95,
    recruiterReadabilityScore: 95,
    formattingScore: 100,
    missingRequiredSkills: [],
    incorrectTechnologyUsage: [],
    genericBullets: [],
    missingImpactEvidence: [],
    summaryIssues: [],
    skillsOrderingIssues: [],
    truthfulnessIssues: [],
    requiredCorrections: [],
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    blockingIssues: [],
    blockingFailures: [],
    instructionCompliance: passingCompliance(),
    recruiterQualityAssessment: { status: "PASS", score: 92, issues: [] },
    ...overrides,
  } as StructuredResumeReview;
}

const failure = (type: BlockingFailure["type"], description: string): BlockingFailure => ({ type, description });

test("a clean, truthful, well-positioned package is READY_FOR_HUMAN_APPLICATION", () => {
  const result = evaluateApplicationReadiness(review(), 1, 3);
  assert.equal(result.readiness, "READY_FOR_HUMAN_APPLICATION");
  assert.equal(result.humanMaySend, true);
  assert.deepEqual(result.blockingReasons, []);
});

test("READY never means CareerOps may send it — only that a human may", () => {
  // Guards the naming: humanMaySend is the ONLY affirmative signal, and it is scoped to a person.
  const result = evaluateApplicationReadiness(review(), 1, 3);
  assert.equal(result.humanMaySend, true);
  assert.equal(result.readiness, "READY_FOR_HUMAN_APPLICATION");
});

for (const type of [
  "PLACEHOLDER_CONTACT",
  "UNSUPPORTED_METRIC",
  "UNSUPPORTED_CLAIM",
  "DATE_CONTRADICTION",
  "EMPLOYER_CONTRADICTION",
  "CERTIFICATION_CONTRADICTION",
  "CROSS_ARTIFACT_CONTRADICTION",
] as const) {
  test(`a ${type} blocking failure makes the package BLOCKED, never merely weak`, () => {
    const result = evaluateApplicationReadiness(
      review({ blockingFailures: [failure(type, "example defect")] }),
      1,
      3
    );
    assert.equal(result.readiness, "BLOCKED");
    assert.equal(result.humanMaySend, false);
    assert.equal(result.improvementReasons.length, 0, "a truthfulness failure is never reported as an improvement");
    assert.ok(result.blockingReasons.some((r) => r.startsWith(type)), "the reason must name the failure category");
  });
}

test("a perfect score can never clear a blocking failure", () => {
  const result = evaluateApplicationReadiness(
    review({ overallScore: 100, atsScore: 100, blockingFailures: [failure("UNSUPPORTED_METRIC", "invented 30%")] }),
    1,
    3
  );
  assert.equal(result.readiness, "BLOCKED");
});

test("missing blocking-failure analysis is BLOCKED — absence is failure, not a free pass", () => {
  const result = evaluateApplicationReadiness(review({ blockingFailures: undefined }), 1, 3);
  assert.equal(result.readiness, "BLOCKED");
  assert.ok(result.blockingReasons[0].includes("has not been cleared"));
});

test("a truthfulness score below 100 is BLOCKED", () => {
  const result = evaluateApplicationReadiness(review({ truthfulnessScore: 99 }), 1, 3);
  assert.equal(result.readiness, "BLOCKED");
});

test("an architecture-consistency score below 100 is BLOCKED", () => {
  const result = evaluateApplicationReadiness(review({ architectureConsistencyScore: 90 }), 1, 3);
  assert.equal(result.readiness, "BLOCKED");
});

test("a legacy blockingIssues entry is BLOCKED", () => {
  const result = evaluateApplicationReadiness(review({ blockingIssues: ["fabricated employer"] }), 1, 3);
  assert.equal(result.readiness, "BLOCKED");
});

test("truthful but weak recruiter quality is NEEDS_IMPROVEMENT, not BLOCKED", () => {
  const result = evaluateApplicationReadiness(
    review({ recruiterQualityAssessment: { status: "FAIL", score: 50, issues: [{ dimension: "targetRoleClarity", severity: "BLOCKING", description: "headline hijacked by secondary technology" }] } }),
    3,
    3
  );
  assert.equal(result.readiness, "NEEDS_IMPROVEMENT");
  assert.equal(result.humanMaySend, false);
  assert.deepEqual(result.blockingReasons, [], "a positioning weakness is never reported as a truthfulness failure");
  assert.ok(result.improvementReasons.some((r) => r.includes("truthful")));
});

test("a missing recruiter-quality assessment is NEEDS_IMPROVEMENT, not BLOCKED", () => {
  const result = evaluateApplicationReadiness(review({ recruiterQualityAssessment: undefined }), 3, 3);
  assert.equal(result.readiness, "NEEDS_IMPROVEMENT");
  assert.ok(result.improvementReasons.some((r) => r.includes("positioning was never verified")));
});

test("a low overall score alone is NEEDS_IMPROVEMENT and names the score", () => {
  const result = evaluateApplicationReadiness(review({ overallScore: 80 }), 3, 3);
  assert.equal(result.readiness, "NEEDS_IMPROVEMENT");
  assert.ok(result.improvementReasons.some((r) => r.includes("80")));
});

test("NEEDS_IMPROVEMENT always carries at least one reason — never a bare verdict", () => {
  const result = evaluateApplicationReadiness(review({ instructionCompliance: undefined }), 3, 3);
  assert.equal(result.readiness, "NEEDS_IMPROVEMENT");
  assert.ok(result.improvementReasons.length > 0);
});

test("the same review mid-loop and at max iterations yields the same readiness verdict", () => {
  // Readiness is a property of the ARTIFACT, not of how many iterations remain — unlike the quality
  // gate, whose IMPROVEMENT_NEEDED/NEEDS_HUMAN_REVIEW split is purely about loop budget.
  const weak = review({ recruiterQualityAssessment: { status: "FAIL", score: 50, issues: [] } });
  assert.equal(evaluateApplicationReadiness(weak, 1, 3).readiness, evaluateApplicationReadiness(weak, 3, 3).readiness);

  const blocked = review({ blockingFailures: [failure("PLACEHOLDER_CONTACT", "your.email@example.com")] });
  assert.equal(evaluateApplicationReadiness(blocked, 1, 3).readiness, evaluateApplicationReadiness(blocked, 3, 3).readiness);
});

test("blocking and improvement reasons are mutually exclusive by construction", () => {
  const both = review({
    blockingFailures: [failure("UNSUPPORTED_CLAIM", "claimed Kafka")],
    recruiterQualityAssessment: { status: "FAIL", score: 40, issues: [] },
    overallScore: 60,
  });
  const result = evaluateApplicationReadiness(both, 3, 3);
  assert.equal(result.readiness, "BLOCKED");
  assert.ok(result.blockingReasons.length > 0);
  assert.equal(result.improvementReasons.length, 0, "truthfulness dominates — weakness is not reported alongside it");
});
