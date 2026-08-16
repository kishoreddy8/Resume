import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { selectBestResumeQualityAttempt, type ResumeQualityAttemptSummary } from "../bestAttemptSelection";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";
import type { ComplianceStatus, InstructionComplianceChecks, StructuredResumeReview } from "../types";

/**
 * Pure-function tests — no database, no filesystem, no Claude/AI, no network. This file itself proves
 * "best-attempt selection uses no AI": it imports nothing but ../bestAttemptSelection and ../types.
 */

function allChecks(status: ComplianceStatus): InstructionComplianceChecks {
  const checks = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) checks[name] = status;
  return checks;
}

function review(overrides: Partial<StructuredResumeReview> & { checks?: Partial<InstructionComplianceChecks> }): StructuredResumeReview {
  const { checks, ...rest } = overrides;
  return {
    overallScore: 90,
    atsScore: 90,
    keywordAlignmentScore: 90,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 90,
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
    instructionCompliance: {
      instructionVersion: "test-version",
      instructionHash: "test-hash",
      checks: { ...allChecks("PASS"), ...checks },
      notes: [],
    },
    ...rest,
  };
}

test("1. single attempt is trivially selected", () => {
  const attempts: ResumeQualityAttemptSummary[] = [{ iterationNumber: 1, review: review({}) }];
  const result = selectBestResumeQualityAttempt(attempts);
  assert.equal(result?.iterationNumber, 1);
});

test("2. empty input returns null, never fabricates a selection", () => {
  assert.equal(selectBestResumeQualityAttempt([]), null);
});

test("3. a real architecture problem (lower architectureConsistencyScore) outranks a higher ATS/overall score — the core safety property", () => {
  // Iteration 1: a genuine architecture violation, reflected realistically in BOTH the dedicated
  // score AND the corresponding hard-gate check (as the real deterministic reviewer always couples
  // them — see this file's own regression-derived design note in bestAttemptSelection.ts), but with a
  // deceptively high ATS/overall score.
  const iter1 = review({
    atsScore: 100,
    overallScore: 99,
    architectureConsistencyScore: 60,
    checks: { architectureIntegrity: "FAIL", noContradictingTechnologies: "FAIL" },
  });
  // Iteration 2: no architecture problem at all, lower ATS score.
  const iter2 = review({ atsScore: 60, overallScore: 80, architectureConsistencyScore: 100 });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: iter1 },
    { iterationNumber: 2, review: iter2 },
  ]);

  assert.equal(result?.iterationNumber, 2, "a real architecture problem must never be out-ranked by a higher ATS/overall score");
});

test("3b. blocking issues outrank a higher ATS/overall score even when scores are otherwise identical", () => {
  const iter1 = review({ atsScore: 100, overallScore: 99, blockingIssues: ["a real named defect"] });
  const iter2 = review({ atsScore: 60, overallScore: 80, blockingIssues: [] });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: iter1 },
    { iterationNumber: 2, review: iter2 },
  ]);

  assert.equal(result?.iterationNumber, 2, "a concrete blocking issue must never be out-ranked by a higher ATS/overall score");
});

test("4. Ostium-shaped regression fixture: iteration 2 (strong scores, minor compliance fails) beats iteration 3 (architecture-risk failures)", () => {
  // Modeled directly on the real acceptance-test observation.
  const iteration2 = review({
    overallScore: 100,
    atsScore: 100,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    blockingIssues: [],
    checks: { crossDocumentConsistency: "FAIL", finalValidation: "FAIL" },
  });
  const iteration3 = review({
    overallScore: 40,
    atsScore: 100,
    truthfulnessScore: 100,
    architectureConsistencyScore: 50,
    blockingIssues: ["Azure Synapse Analytics + Snowflake positioned as primary in one bullet"],
    checks: {
      architectureIntegrity: "FAIL",
      technologyAdaptation: "FAIL",
      migrationIntegrity: "FAIL",
      noContradictingTechnologies: "FAIL",
      finalValidation: "FAIL",
    },
  });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 2, review: iteration2 },
    { iterationNumber: 3, review: iteration3 },
  ]);

  assert.equal(result?.iterationNumber, 2, "iteration 2 must be selected over the higher-risk iteration 3");
});

test("5. fewer total compliance FAILs breaks a tie when hard-gate-failure counts are equal", () => {
  // Both fail exactly one hard-gate check, but iter A also fails an additional soft check.
  const iterA = review({ checks: { architectureIntegrity: "FAIL", bulletWriting: "FAIL" } });
  const iterB = review({ checks: { architectureIntegrity: "FAIL" } });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: iterA },
    { iterationNumber: 2, review: iterB },
  ]);

  assert.equal(result?.iterationNumber, 2);
});

test("6. fewer blocking issues wins outright — this is the first criterion checked", () => {
  const iterA = review({ blockingIssues: ["issue one", "issue two"] });
  const iterB = review({ blockingIssues: ["issue one"] });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: iterA },
    { iterationNumber: 2, review: iterB },
  ]);

  assert.equal(result?.iterationNumber, 2);
});

test("7. higher architecture score breaks a tie when compliance/blocking counts are equal", () => {
  const iterA = review({ architectureConsistencyScore: 70 });
  const iterB = review({ architectureConsistencyScore: 90 });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: iterA },
    { iterationNumber: 2, review: iterB },
  ]);

  assert.equal(result?.iterationNumber, 2);
});

test("8. higher truthfulness score breaks a tie when blocking issues are equal", () => {
  const iterA = review({ truthfulnessScore: 80 });
  const iterB = review({ truthfulnessScore: 100 });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: iterA },
    { iterationNumber: 2, review: iterB },
  ]);

  assert.equal(result?.iterationNumber, 2);
});

test("9. higher overall score breaks a tie after truthfulness ties", () => {
  const iterA = review({ overallScore: 70 });
  const iterB = review({ overallScore: 95 });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: iterA },
    { iterationNumber: 2, review: iterB },
  ]);

  assert.equal(result?.iterationNumber, 2);
});

test("10. higher ATS score breaks a tie after overall score ties", () => {
  const iterA = review({ atsScore: 50 });
  const iterB = review({ atsScore: 90 });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: iterA },
    { iterationNumber: 2, review: iterB },
  ]);

  assert.equal(result?.iterationNumber, 2);
});

test("11. fully identical reviews: later iteration wins the final tie, deterministically", () => {
  const same = review({});
  const result1 = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: same },
    { iterationNumber: 2, review: same },
    { iterationNumber: 3, review: same },
  ]);
  assert.equal(result1?.iterationNumber, 3);

  // Order-independence: shuffling input order must not change the deterministic outcome.
  const result2 = selectBestResumeQualityAttempt([
    { iterationNumber: 3, review: same },
    { iterationNumber: 1, review: same },
    { iterationNumber: 2, review: same },
  ]);
  assert.equal(result2?.iterationNumber, 3);
});

test("12. legacy review missing instructionCompliance degrades safely (never throws) and never beats a fully-evaluated safe attempt", () => {
  const legacy = review({});
  delete (legacy as { instructionCompliance?: unknown }).instructionCompliance;
  const evaluated = review({});

  assert.doesNotThrow(() => {
    const result = selectBestResumeQualityAttempt([
      { iterationNumber: 1, review: legacy },
      { iterationNumber: 2, review: evaluated },
    ]);
    assert.equal(result?.iterationNumber, 2, "a legacy review with no compliance evidence must never out-rank a fully-evaluated safe one");
  });
});

test("13. a workflow with ONLY a legacy review still returns a safe (non-throwing) result", () => {
  const legacy = review({});
  delete (legacy as { instructionCompliance?: unknown }).instructionCompliance;

  assert.doesNotThrow(() => {
    const result = selectBestResumeQualityAttempt([{ iterationNumber: 1, review: legacy }]);
    assert.equal(result?.iterationNumber, 1);
  });
});

test("14. this module performs no AI/LLM call and has no process/network capability (source-level proof)", () => {
  const source = fs.readFileSync(new URL("../bestAttemptSelection.ts", import.meta.url), "utf-8");
  assert(!/child_process|node-fetch|fetch\(|anthropic|openai|claude/i.test(source), "selection module must be a pure function with zero AI/process/network surface");
});
