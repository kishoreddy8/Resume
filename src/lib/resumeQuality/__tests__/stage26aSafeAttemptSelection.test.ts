import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { selectBestResumeQualityAttempt, type ResumeQualityAttemptSummary } from "../bestAttemptSelection";
import { INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";
import { evaluateQualityGate } from "../qualityGate";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";
import type {
  BlockingFailure,
  ComplianceStatus,
  InstructionComplianceChecks,
  StructuredResumeReview,
} from "../types";

/**
 * Stage 26A — the safety invariant on best-attempt selection.
 *
 * Pure-function tests: no database, no filesystem writes, no Claude/AI, no network. The one file read
 * is the real persisted review.json set from the Stage 26 acceptance workflow, opened READ-ONLY to
 * replay the exact historical case that exposed the defect (S26A-10) — it mutates nothing and is
 * skipped when those artifacts are not present.
 *
 * Context: the comparator ranked iteration 2 (four PLACEHOLDER_CONTACT blocking failures) above
 * iteration 3 (those placeholders removed) because the two tied on every score and iteration 2 had one
 * fewer hard-gate CHECK failure. `blockingFailures` — the field qualityGate condition 7 actually
 * enforces — was never consulted, so the human-review package handed a human a resume reading
 * "candidate@example.com".
 */

function allChecks(status: ComplianceStatus): InstructionComplianceChecks {
  const checks = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) checks[name] = status;
  return checks;
}

/** A review with every gate-relevant field explicitly present, so a test's intent is never confused
 *  with an accidental absence. `blockingFailures` defaults to present-and-empty (proven clean). */
function review(
  overrides: Partial<StructuredResumeReview> & { checks?: Partial<InstructionComplianceChecks> } = {}
): StructuredResumeReview {
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
    blockingFailures: [],
    recruiterQualityAssessment: { status: "PASS", score: 100, issues: [] },
    instructionCompliance: {
      // The REAL current canonical identity, read (never modified) from canonicalInstructions.ts:
      // gate condition 5 requires matchesCurrentInstructions, so a fixture with a made-up version can
      // never be READY and could not express "this attempt genuinely passes the gate".
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      checks: { ...allChecks("PASS"), ...checks },
      notes: [],
    },
    ...rest,
  } as StructuredResumeReview;
}

function failure(type: BlockingFailure["type"], description = "test finding"): BlockingFailure {
  return { type, description };
}

// -------------------------------------------------------------------------------------------------

test("S26A-01 a gate-passing attempt outranks a non-passing one, even with lower scores", () => {
  // Built so the ONLY thing favouring iteration 1 is that it genuinely passes the gate: iteration 2
  // scores higher on both overall and ATS.
  const passing = review({ overallScore: 96, atsScore: 96 });
  const failing = review({ overallScore: 100, atsScore: 100, blockingIssues: ["a real defect"] });

  // Establish the premise via the unchanged gate rather than asserting it by hand.
  assert.equal(evaluateQualityGate(passing, 1, 3), "READY", "fixture: the first attempt must really pass");
  assert.notEqual(evaluateQualityGate(failing, 1, 3), "READY", "fixture: the second attempt must really fail");

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: passing },
    { iterationNumber: 2, review: failing },
  ]);
  assert.equal(result?.iterationNumber, 1);
  assert.equal(result?.passesQualityGate, true);
});

test("S26A-02 a placeholder-contact attempt cannot beat a clean attempt on numeric score alone", () => {
  // This is the historical defect in miniature: the unsafe attempt is strictly better on every score.
  const placeholder = review({
    overallScore: 100,
    atsScore: 100,
    blockingFailures: [failure("PLACEHOLDER_CONTACT", 'resume.email contains "candidate@example.com"')],
  });
  const clean = review({ overallScore: 96, atsScore: 80, blockingFailures: [] });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: placeholder },
    { iterationNumber: 2, review: clean },
  ]);
  assert.equal(result?.iterationNumber, 2, "a fake contact detail must never be outweighed by a higher score");
  assert.equal(result?.blockingFailureCount, 0);
  assert.match(result!.selectionReason, /0 blocking failure\(s\)/);
});

test("S26A-03 an unsupported/fabricated-claim attempt cannot beat a supported attempt on score alone", () => {
  const fabricated = review({
    overallScore: 100,
    atsScore: 100,
    truthfulnessScore: 100,
    blockingFailures: [failure("UNSUPPORTED_CLAIM"), failure("UNSUPPORTED_METRIC")],
  });
  const supported = review({ overallScore: 95, atsScore: 70, blockingFailures: [] });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: fabricated },
    { iterationNumber: 2, review: supported },
  ]);
  assert.equal(result?.iterationNumber, 2);
});

test("S26A-04 a cross-artifact contradiction cannot beat a contradiction-free attempt on score alone", () => {
  const contradictory = review({
    overallScore: 100,
    atsScore: 100,
    blockingFailures: [failure("CROSS_ARTIFACT_CONTRADICTION", 'Cover letter claims "AWS", absent from the resume')],
  });
  const consistent = review({ overallScore: 96, atsScore: 85, blockingFailures: [] });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: contradictory },
    { iterationNumber: 2, review: consistent },
  ]);
  assert.equal(result?.iterationNumber, 2);
});

test("S26A-05 two equally safe attempts retain the existing ranking semantics exactly", () => {
  // Both proven clean, so criterion 0/0b tie and the pre-Stage-26A order must decide. Under that
  // order a real architecture problem outranks a higher ATS/overall score (the module's own core
  // safety property), so iteration 2 must win despite iteration 1 scoring higher overall.
  const architectureProblem = review({
    overallScore: 100,
    atsScore: 100,
    architectureConsistencyScore: 60,
    checks: { architectureIntegrity: "FAIL" },
  });
  const sound = review({ overallScore: 90, atsScore: 90, architectureConsistencyScore: 100 });

  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: architectureProblem },
    { iterationNumber: 2, review: sound },
  ]);
  assert.equal(result?.iterationNumber, 2, "existing architecture-over-score behaviour must be untouched");

  // And the score-based tiebreakers still work among equally safe attempts.
  const higherAts = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: review({ atsScore: 70 }) },
    { iterationNumber: 2, review: review({ atsScore: 95 }) },
  ]);
  assert.equal(higherAts?.iterationNumber, 2);
});

test("S26A-06 the latest attempt does NOT automatically win", () => {
  const clean = review({ overallScore: 96 });
  const laterButUnsafe = review({
    overallScore: 100,
    blockingFailures: [failure("PLACEHOLDER_CONTACT")],
  });
  const result = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: clean },
    { iterationNumber: 2, review: laterButUnsafe },
    { iterationNumber: 3, review: laterButUnsafe },
  ]);
  assert.equal(result?.iterationNumber, 1, "recency must never override safety");

  // Recency remains the FINAL tiebreaker only, for genuinely identical attempts.
  const identical = review();
  const tie = selectBestResumeQualityAttempt([
    { iterationNumber: 1, review: identical },
    { iterationNumber: 2, review: identical },
  ]);
  assert.equal(tie?.iterationNumber, 2);
});

test("S26A-07 human-review package selection uses this same safety-aware authority", async () => {
  // Proven structurally rather than by rebuilding a workflow: humanReviewPackage delegates to this
  // module and has no comparator of its own, so it cannot disagree with it.
  const src = fs.readFileSync(new URL("../humanReviewPackage.ts", import.meta.url), "utf-8");
  assert.match(src, /selectBestResumeQualityAttempt/, "the package must call the single selection authority");
  assert.doesNotMatch(
    src,
    /\.sort\(|localeCompare|overallScore\s*[<>]/,
    "the package must not implement any ranking of its own"
  );
  const routeSrc = fs.readFileSync(
    new URL("../../../app/api/candidates/[candidateId]/jobs/[jobId]/quality-workflow/route.ts", import.meta.url),
    "utf-8"
  );
  assert.match(routeSrc, /selectBestResumeQualityAttempt/, "the API must reuse the same authority");
});

test("S26A-08 READY quality-gate requirements are unchanged by this work", () => {
  // Every one of the gate's eight conditions must still be required. Each mutation below removes
  // exactly one of them from an otherwise-passing review and must break READY.
  // The default fixture scores 90, below the gate's own >= 95 threshold, so the passing baseline is
  // stated explicitly rather than inherited.
  const passing = (extra: Parameters<typeof review>[0] = {}) => review({ overallScore: 96, ...extra });
  assert.equal(evaluateQualityGate(passing(), 1, 3), "READY", "the baseline fixture must pass");

  const mustNotBeReady: Array<[string, StructuredResumeReview]> = [
    ["overallScore < 95", passing({ overallScore: 94 })],
    ["truthfulnessScore < 100", passing({ truthfulnessScore: 99 })],
    ["architectureConsistencyScore < 100", passing({ architectureConsistencyScore: 99 })],
    ["a blocking issue", passing({ blockingIssues: ["x"] })],
    ["missing instructionCompliance", passing({ instructionCompliance: undefined })],
    ["a compliance check FAIL", passing({ checks: { hardCareerFacts: "FAIL" } })],
    ["a typed blocking failure", passing({ blockingFailures: [failure("PLACEHOLDER_CONTACT")] })],
    ["missing blockingFailures", passing({ blockingFailures: undefined })],
    ["recruiter quality not PASS", passing({ recruiterQualityAssessment: { status: "REVIEW", score: 100, issues: [] } })],
    ["missing recruiterQualityAssessment", passing({ recruiterQualityAssessment: undefined })],
  ];
  for (const [label, r] of mustNotBeReady) {
    assert.notEqual(evaluateQualityGate(r, 1, 3), "READY", `${label} must still block READY`);
  }
});

test("S26A-09 selection is deterministic and independent of input order", () => {
  const attempts: ResumeQualityAttemptSummary[] = [
    { iterationNumber: 1, review: review({ overallScore: 100, blockingFailures: [failure("PLACEHOLDER_CONTACT")] }) },
    { iterationNumber: 2, review: review({ overallScore: 97 }) },
    { iterationNumber: 3, review: review({ overallScore: 96, blockingFailures: undefined }) },
  ];
  const forward = selectBestResumeQualityAttempt(attempts);
  const reversed = selectBestResumeQualityAttempt([...attempts].reverse());
  const shuffled = selectBestResumeQualityAttempt([attempts[1], attempts[2], attempts[0]]);
  assert.equal(forward?.iterationNumber, 2);
  assert.equal(reversed?.iterationNumber, forward?.iterationNumber);
  assert.equal(shuffled?.iterationNumber, forward?.iterationNumber);
  assert.equal(reversed?.selectionReason, forward?.selectionReason);

  // Repeated calls agree, and a legacy review (blockingFailures absent) never outranks a proven-clean
  // one purely by having nothing recorded against it.
  for (let i = 0; i < 5; i++) {
    assert.equal(selectBestResumeQualityAttempt(attempts)?.iterationNumber, 2);
  }
});

test("S26A-10 the historical Stage 26 workflow-2 case now chooses the safer attempt (real artifacts, read-only)", () => {
  const iterRoot = path.join(
    process.cwd(),
    "data/generated/candidates/1/jobs/68ab1bfcc865b0de/runs/2/quality/2/iterations"
  );
  if (!fs.existsSync(iterRoot)) {
    // The historical artifacts are environment-specific; the invariant itself is covered by S26A-02.
    return;
  }
  const attempts: ResumeQualityAttemptSummary[] = [];
  for (const n of [1, 2, 3]) {
    const p = path.join(iterRoot, String(n), "review.json");
    if (fs.existsSync(p)) {
      attempts.push({ iterationNumber: n, review: JSON.parse(fs.readFileSync(p, "utf-8")) as StructuredResumeReview });
    }
  }
  if (attempts.length < 3) return;

  // The premise that made this case pathological: iterations 2 and 3 tie on every score the comparator
  // used to consult, and iteration 2 carries the placeholder failures.
  const two = attempts.find((a) => a.iterationNumber === 2)!.review;
  const three = attempts.find((a) => a.iterationNumber === 3)!.review;
  assert.equal(two.overallScore, three.overallScore, "fixture premise: overall scores tie");
  assert.equal(two.atsScore, three.atsScore, "fixture premise: ATS scores tie");
  assert.ok(
    (two.blockingFailures ?? []).some((f) => f.type === "PLACEHOLDER_CONTACT"),
    "fixture premise: iteration 2 carries the placeholder failures"
  );
  assert.equal(
    (three.blockingFailures ?? []).some((f) => f.type === "PLACEHOLDER_CONTACT"),
    false,
    "fixture premise: iteration 3 had the placeholders removed"
  );

  const result = selectBestResumeQualityAttempt(attempts);
  assert.equal(result?.iterationNumber, 3, "the attempt without placeholder contact details must win");
  assert.match(result!.selectionReason, /CROSS_ARTIFACT_CONTRADICTION/);
  assert.doesNotMatch(result!.selectionReason, /PLACEHOLDER_CONTACT/);
});

test("S26A-11 this module still performs no AI/LLM call and has no process/network surface", () => {
  const source = fs.readFileSync(new URL("../bestAttemptSelection.ts", import.meta.url), "utf-8");
  assert(
    !/child_process|node-fetch|fetch\(|anthropic|openai|claude/i.test(source),
    "selection must remain a pure function with zero AI/process/network surface"
  );
});
