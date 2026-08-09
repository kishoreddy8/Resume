import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "../decision";
import type { EligibilityResult, RequirementMatch, RequirementUnit } from "../types";

function eligibility(overrides: Partial<EligibilityResult>): EligibilityResult {
  return { status: "PASS", reasons: ["No known hard blocker identified."], sponsorship: { signal: "not_applicable", note: "n/a" }, ...overrides };
}

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: ["X"],
    categories: [],
    label: "X",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
    ...overrides,
  };
}

function gap(): RequirementMatch {
  return { requirement: unit({}), matchType: "MISSING", credit: 0 };
}

const goodBaseline = { insufficientJdSignal: false, criticalGaps: [], overallScore: 90, requirementCoverage: 0.95, employerEvidencedShare: 0.9 };

test("eligibility BLOCKED wins regardless of an otherwise excellent score", () => {
  const result = decide({ eligibility: eligibility({ status: "BLOCKED", reasons: ["hard blocker"] }), ...goodBaseline });
  assert.equal(result.decision, "BLOCKED");
  assert.deepEqual(result.blockingReasons, ["hard blocker"]);
});

test("a critical gap forces NEEDS_REVIEW even when the score is at/above threshold", () => {
  const result = decide({ eligibility: eligibility({}), ...goodBaseline, criticalGaps: [gap()] });
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.ok(result.blockingReasons.some((r) => r.includes("critical requirement")));
});

test("score below threshold alone forces NEEDS_REVIEW", () => {
  const result = decide({ eligibility: eligibility({}), ...goodBaseline, overallScore: 79 });
  assert.equal(result.decision, "NEEDS_REVIEW");
});

test("coverage below threshold alone forces NEEDS_REVIEW", () => {
  const result = decide({ eligibility: eligibility({}), ...goodBaseline, requirementCoverage: 0.5 });
  assert.equal(result.decision, "NEEDS_REVIEW");
});

test("employer-evidenced share below threshold alone forces NEEDS_REVIEW (broad inventory-only match cannot manufacture READY)", () => {
  const result = decide({ eligibility: eligibility({}), ...goodBaseline, employerEvidencedShare: 0 });
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.ok(result.blockingReasons.some((r) => r.includes("employer-attributed")));
});

test("insufficient JD signal forces NEEDS_REVIEW regardless of score", () => {
  const result = decide({ eligibility: eligibility({}), ...goodBaseline, insufficientJdSignal: true });
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.ok(result.blockingReasons.some((r) => r.toLowerCase().includes("sparse")));
});

test("eligibility UNKNOWN forces NEEDS_REVIEW, never a silent PASS-through to READY", () => {
  const result = decide({ eligibility: eligibility({ status: "UNKNOWN", reasons: ["unknown sponsorship"] }), ...goodBaseline });
  assert.equal(result.decision, "NEEDS_REVIEW");
});

test("everything passing every gate -> READY_FOR_TAILORING with empty blockingReasons", () => {
  const result = decide({ eligibility: eligibility({}), ...goodBaseline });
  assert.equal(result.decision, "READY_FOR_TAILORING");
  assert.deepEqual(result.blockingReasons, []);
});

test("multiple simultaneous failures are ALL collected, not just the first", () => {
  const result = decide({
    eligibility: eligibility({}),
    insufficientJdSignal: false,
    criticalGaps: [gap()],
    overallScore: 50,
    requirementCoverage: 0.4,
    employerEvidencedShare: 0.1,
  });
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.ok(result.blockingReasons.length >= 3);
});
