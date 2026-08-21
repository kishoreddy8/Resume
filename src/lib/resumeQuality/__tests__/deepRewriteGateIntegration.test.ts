import { test } from "node:test";
import assert from "node:assert/strict";
import { currentInstructionIdentity } from "../canonicalInstructions";
import { evaluateQualityGate } from "../qualityGate";
import { evaluateApplicationReadiness } from "../applicationReadiness";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES, type InstructionComplianceChecks, type StructuredResumeReview } from "../types";

/**
 * End-to-end gate behaviour for the workflow-11 signature.
 *
 * THE OBSERVED SHAPE, reproduced exactly as a fixture: a targeted repair fixed every outstanding
 * finding and produced overallScore 100, zero requiredCorrections, zero blockingIssues, zero
 * blockingFailures and recruiterQualityAssessment PASS — and was blocked because deepRewrite was
 * FAIL at 84% unchanged bullets. This suite pins BOTH sides of the fix: the same package now clears
 * when the check is recorded as inapplicable, and it still does not clear if anything else is wrong.
 *
 * humanMaySend is never set by hand anywhere below. It is read from evaluateApplicationReadiness,
 * which is the only authority, and a 100 score is deliberately shown NOT to be sufficient on its own.
 */

function checks(overrides: Partial<InstructionComplianceChecks> = {}): InstructionComplianceChecks {
  const base = Object.fromEntries(
    INSTRUCTION_COMPLIANCE_CHECK_NAMES.map((n) => [n, "PASS" as const])
  ) as unknown as InstructionComplianceChecks;
  return { ...base, ...overrides };
}

/** The workflow-11 iteration-2 signature. `deepRewrite` is the only variable. */
function workflow11Review(
  deepRewrite: InstructionComplianceChecks["deepRewrite"],
  overrides: Partial<StructuredResumeReview> = {}
): StructuredResumeReview {
  return {
    overallScore: 100,
    atsScore: 100,
    keywordAlignmentScore: 100,
    recruiterReadabilityScore: 100,
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
    instructionCompliance: {
      ...currentInstructionIdentity(),
      checks: checks({ deepRewrite }),
      notes: [],
      checkNotes:
        deepRewrite === "NOT_APPLICABLE"
          ? { deepRewrite: ["This iteration was governed by a targeted repair plan…"] }
          : undefined,
    },
    recruiterQualityAssessment: { status: "PASS", score: 92, issues: [] },
    ...overrides,
  } as StructuredResumeReview;
}

/* ── BEFORE: the exact failure that motivated the fix ──────────────────────────────────────── */

test("BEFORE — deepRewrite FAIL blocks a package that is otherwise perfect", () => {
  const review = workflow11Review("FAIL");
  assert.notEqual(evaluateQualityGate(review, 2, 3), "READY");
  const readiness = evaluateApplicationReadiness(review, 2, 3);
  assert.equal(readiness.humanMaySend, false, "score 100 with one failing compliance check is not sendable");
});

/* ── AFTER: the same package under its actual repair contract ──────────────────────────────── */

test("AFTER — deepRewrite NOT_APPLICABLE lets the remaining gates decide", () => {
  const review = workflow11Review("NOT_APPLICABLE");
  assert.equal(evaluateQualityGate(review, 2, 3), "READY");
  const readiness = evaluateApplicationReadiness(review, 2, 3);
  assert.equal(readiness.readiness, "READY_FOR_HUMAN_APPLICATION");
  assert.equal(readiness.humanMaySend, true);
  assert.deepEqual(readiness.blockingReasons, []);
});

/* ── The applicability state is not a skeleton key ─────────────────────────────────────────── */

test("scoped repair + a blocking failure is still BLOCKED", () => {
  const review = workflow11Review("NOT_APPLICABLE", {
    blockingFailures: [
      { type: "UNSUPPORTED_CLAIM", description: 'EMPLOYER_CONTRADICTION: Cover letter attributes "Python" to Comerica Bank.' },
    ],
  } as Partial<StructuredResumeReview>);
  assert.notEqual(evaluateQualityGate(review, 2, 3), "READY");
  const readiness = evaluateApplicationReadiness(review, 2, 3);
  assert.equal(readiness.readiness, "BLOCKED");
  assert.equal(readiness.humanMaySend, false);
});

test("scoped repair + a failing instruction-compliance check is still blocked", () => {
  const review = workflow11Review("NOT_APPLICABLE", {
    instructionCompliance: {
      ...currentInstructionIdentity(),
      checks: checks({ deepRewrite: "NOT_APPLICABLE", architectureIntegrity: "FAIL" }),
      notes: [],
    },
  } as Partial<StructuredResumeReview>);
  assert.notEqual(evaluateQualityGate(review, 2, 3), "READY");
  assert.equal(evaluateApplicationReadiness(review, 2, 3).humanMaySend, false);
});

test("scoped repair + recruiter quality not PASS is still blocked", () => {
  const review = workflow11Review("NOT_APPLICABLE", {
    recruiterQualityAssessment: {
      status: "REVIEW",
      score: 61,
      issues: [
        { dimension: "targetRoleClarity", severity: "BLOCKING", description: "Positioning is generic." },
      ],
    },
  } as Partial<StructuredResumeReview>);
  assert.notEqual(evaluateQualityGate(review, 2, 3), "READY");
  assert.equal(evaluateApplicationReadiness(review, 2, 3).humanMaySend, false);
});

test("scoped repair + truthfulness below 100 is still blocked", () => {
  const review = workflow11Review("NOT_APPLICABLE", {
    truthfulnessScore: 96,
    truthfulnessIssues: ["Snowflake is claimed at an employer that does not evidence it."],
  } as Partial<StructuredResumeReview>);
  assert.notEqual(evaluateQualityGate(review, 2, 3), "READY");
});

test("a 100 score is still not sufficient on its own", () => {
  /* The whole point of the original defect report: numeric score has never been the authority, and
   * making one check inapplicable must not have quietly turned it into one. */
  const review = workflow11Review("NOT_APPLICABLE", {
    blockingIssues: ["Contact block contains a placeholder phone number."],
  } as Partial<StructuredResumeReview>);
  assert.equal(review.overallScore, 100);
  assert.notEqual(evaluateQualityGate(review, 2, 3), "READY");
  assert.equal(evaluateApplicationReadiness(review, 2, 3).humanMaySend, false);
});

/* ── Historical reviews are interpreted exactly as recorded ────────────────────────────────── */

test("a historical review recording deepRewrite FAIL still reads as blocked", () => {
  /* Old review_json is never rewritten and never reinterpreted: a workflow that failed under the
   * previous rule stays failed until it is genuinely re-reviewed. Clearance comes from a new
   * review, via the normal re-tailor/revalidate path — never retroactively. */
  const historical = workflow11Review("FAIL");
  const before = JSON.stringify(historical);
  assert.notEqual(evaluateQualityGate(historical, 2, 3), "READY");
  assert.equal(evaluateApplicationReadiness(historical, 2, 3).humanMaySend, false);
  assert.equal(JSON.stringify(historical), before, "evaluating a review must not mutate it");
});
