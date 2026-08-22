import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";
import { buildExternalWriterPrompt } from "../handoff/exporter";
import { gateBlockingComplianceCorrections, HARD_GATE_CHECKS, SOFT_GATE_CHECKS } from "../instructionCompliance";
import { evaluateQualityGate } from "../qualityGate";
import { renderReviewFeedbackMarkdown } from "../reviewFeedback";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";
import type {
  ComplianceStatus,
  InstructionComplianceChecks,
  InstructionComplianceResult,
  StructuredResumeReview,
} from "../types";

/**
 * Stage 26B — the writer must be told about EVERY issue that can prevent READY.
 *
 * Pure-function tests: no database, no filesystem, no Claude/AI, no network.
 *
 * The defect these cover, observed on the real corpus (job 33038, workflow 5, iteration 2): a resume
 * scoring 100/100/100/100 with zero blocking failures, zero hard-gate failures and PASS recruiter
 * quality was correctly refused for `technologyGrouping: REVIEW` — a SOFT-gate check that still blocks
 * gate condition 6 — and the next writer package said "Required Corrections: None identified". The
 * writer rewrote blind and iteration 3 regressed from 0 to 8 blocking failures.
 */

function allChecks(status: ComplianceStatus): InstructionComplianceChecks {
  const checks = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) checks[name] = status;
  return checks;
}

function compliance(
  overrides: Partial<InstructionComplianceChecks> = {},
  checkNotes?: InstructionComplianceResult["checkNotes"]
): InstructionComplianceResult {
  return {
    instructionVersion: INSTRUCTION_VERSION,
    instructionHash: INSTRUCTION_HASH,
    checks: { ...allChecks("PASS"), ...overrides },
    notes: Object.values(checkNotes ?? {}).flat(),
    checkNotes,
  };
}

function review(overrides: Partial<StructuredResumeReview> = {}): StructuredResumeReview {
  return {
    overallScore: 96,
    atsScore: 96,
    keywordAlignmentScore: 96,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 96,
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
    instructionCompliance: compliance(),
    ...overrides,
  } as StructuredResumeReview;
}

const TECH_GROUPING_REASON =
  'Technical Skills group "Cloud Platforms" mixes AWS/Azure without a migration/integration framing.';

// -------------------------------------------------------------------------------------------------

test("S26B-01 hard-gate failures appear as CRITICAL corrections", () => {
  const corrections = gateBlockingComplianceCorrections(compliance({ hardCareerFacts: "FAIL" }));
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].priority, "CRITICAL");
  assert.match(corrections[0].description, /hardCareerFacts: FAIL/);
  assert.match(corrections[0].description, /hard-gate check/);
});

test("S26B-02 soft-gate failures that block READY also appear — the defect that let a writer rewrite blind", () => {
  const c = compliance({ technologyGrouping: "REVIEW" }, { technologyGrouping: [TECH_GROUPING_REASON] });

  // The premise: this really does block READY, via gate condition 6, with nothing else wrong.
  assert.notEqual(evaluateQualityGate(review({ instructionCompliance: c }), 1, 3), "READY");

  const corrections = gateBlockingComplianceCorrections(c);
  assert.equal(corrections.length, 1, "exactly the one failing check, no spam from the 21 passing ones");
  assert.equal(corrections[0].priority, "HIGH", "blocking but not a hard gate");
  assert.match(corrections[0].description, /technologyGrouping: REVIEW/);
});

test("S26B-03 a REVIEW status carries its concrete reviewer reason, verbatim", () => {
  const c = compliance({ technologyGrouping: "REVIEW" }, { technologyGrouping: [TECH_GROUPING_REASON] });
  const corrections = gateBlockingComplianceCorrections(c);
  assert.ok(
    corrections[0].description.includes(TECH_GROUPING_REASON),
    `the exact reviewer text must reach the writer, got: ${corrections[0].description}`
  );
});

test("S26B-04 PASS checks generate no corrections at all", () => {
  assert.deepEqual(gateBlockingComplianceCorrections(compliance()), []);
  // And a fully-passing compliance result really is gate-clean.
  assert.equal(evaluateQualityGate(review(), 1, 3), "READY");
});

test("S26B-04b NOT_APPLICABLE checks (e.g. deepRewrite during a TARGETED_REPAIR iteration) generate no correction — a check that did not apply cannot have been violated", () => {
  // The exact live defect: workflow 21 (candidate 13, job 33017) had deepRewrite: NOT_APPLICABLE
  // (correct — that iteration was a targeted repair, so the deep-rewrite comparison genuinely does
  // not apply) and every other check PASS, yet gateBlockingComplianceCorrections still surfaced
  // deepRewrite as a "must PASS before READY" correction — an unfixable instruction, since the
  // writer has no way to turn "does not apply" into "PASS". isComplianceBlocking (the one place that
  // decides) already correctly excludes NOT_APPLICABLE; this function must ask the same question.
  const c = compliance({ deepRewrite: "NOT_APPLICABLE" }, { deepRewrite: ["Targeted repair — full-document rewrite comparison does not apply."] });
  assert.deepEqual(gateBlockingComplianceCorrections(c), [], "NOT_APPLICABLE must never be reported as a blocking correction");
  // And a review with only this one NOT_APPLICABLE check (everything else PASS) is not blocked by
  // condition 6 at all — matching allChecksPass/isComplianceBlocking's own semantics.
  const gateOutcome = evaluateQualityGate(review({ instructionCompliance: c }), 1, 3);
  assert.notEqual(gateOutcome, "NEEDS_HUMAN_REVIEW", "a NOT_APPLICABLE-only compliance result must never itself force human review");
});

test("S26B-05 corrections stay scoped to the exact findings — one per failing check, none for the rest", () => {
  const c = compliance(
    { technologyGrouping: "REVIEW", bannedLanguage: "FAIL", hardCareerFacts: "FAIL" },
    { technologyGrouping: [TECH_GROUPING_REASON], hardCareerFacts: ["No Master Resume profile supplied."] }
  );
  const corrections = gateBlockingComplianceCorrections(c);
  assert.equal(corrections.length, 3);
  const named = corrections.map((x) => x.description);
  for (const check of ["technologyGrouping", "bannedLanguage", "hardCareerFacts"]) {
    assert.equal(named.filter((d) => d.includes(`— ${check}:`)).length, 1, `${check} must appear exactly once`);
  }
  // A check with no recorded note gets the plain statement — never an invented reason.
  const bannedLanguage = corrections.find((x) => x.description.includes("bannedLanguage"))!;
  assert.doesNotMatch(bannedLanguage.description, /Reason:/, "no reason may be fabricated where the reviewer recorded none");
});

test("S26B-06 no duplicate correction spam in the writer prompt", () => {
  // The reviewer already emits its own boilerplate hard-gate corrections; the prompt must state each
  // failing check ONCE, not once per source.
  const c = compliance({ hardCareerFacts: "FAIL" }, { hardCareerFacts: ["No Master Resume profile supplied."] });
  const reviewerBoilerplate = {
    priority: "CRITICAL" as const,
    description: "Canonical instruction compliance — hardCareerFacts: FAIL. This is a hard-gate check and must PASS before this resume can be marked READY.",
  };
  const realCorrection = { priority: "HIGH" as const, description: "Reorder the Comerica bullets so the strongest evidence leads." };

  const prompt = buildExternalWriterPrompt({
    candidateId: 1,
    candidateName: "Alice Smith",
    applicationId: 1,
    jobId: 1,
    tailoringRunId: 1,
    workflowId: 1,
    iterationNumber: 2,
    selectedTrack: null,
    latestReview: review({ instructionCompliance: c }),
    requiredCorrections: [reviewerBoilerplate, realCorrection],
    blockingIssues: [],
    complianceCorrections: gateBlockingComplianceCorrections(c),
  });

  const occurrences = prompt.split("hardCareerFacts: FAIL").length - 1;
  assert.equal(occurrences, 1, `hardCareerFacts must be stated exactly once, found ${occurrences}`);
  assert.match(prompt, /Reorder the Comerica bullets/, "genuine non-compliance corrections must still be shown");
});

test("S26B-07 Stage 21 gate semantics are unchanged by this work", () => {
  assert.equal(evaluateQualityGate(review(), 1, 3), "READY", "baseline must pass");
  const mustBlock: Array<[string, StructuredResumeReview]> = [
    ["overallScore < 95", review({ overallScore: 94 })],
    ["truthfulness < 100", review({ truthfulnessScore: 99 })],
    ["architecture < 100", review({ architectureConsistencyScore: 99 })],
    ["a blocking issue", review({ blockingIssues: ["x"] })],
    ["missing compliance", review({ instructionCompliance: undefined })],
    ["a hard-gate FAIL", review({ instructionCompliance: compliance({ hardCareerFacts: "FAIL" }) })],
    ["a soft-gate REVIEW", review({ instructionCompliance: compliance({ technologyGrouping: "REVIEW" }) })],
    ["a typed blocking failure", review({ blockingFailures: [{ type: "PLACEHOLDER_CONTACT", description: "x" }] })],
    ["missing blockingFailures", review({ blockingFailures: undefined })],
    ["recruiter quality REVIEW", review({ recruiterQualityAssessment: { status: "REVIEW", score: 100, issues: [] } })],
  ];
  for (const [label, r] of mustBlock) {
    assert.notEqual(evaluateQualityGate(r, 1, 3), "READY", `${label} must still block READY`);
  }
});

test("S26B-08 the writer prompt never says 'None identified' while a compliance check is blocking", () => {
  const c = compliance({ technologyGrouping: "REVIEW" }, { technologyGrouping: [TECH_GROUPING_REASON] });
  const prompt = buildExternalWriterPrompt({
    candidateId: 1,
    candidateName: "Alice Smith",
    applicationId: 1,
    jobId: 1,
    tailoringRunId: 1,
    workflowId: 1,
    iterationNumber: 3,
    selectedTrack: null,
    latestReview: review({ instructionCompliance: c }),
    requiredCorrections: [],
    blockingIssues: [],
    blockingFailures: [],
    complianceCorrections: gateBlockingComplianceCorrections(c),
  });
  assert.match(prompt, /Compliance Checks Blocking Approval/);
  assert.match(prompt, /technologyGrouping: REVIEW/);
  assert.ok(prompt.includes(TECH_GROUPING_REASON), "the concrete reason must be in the prompt the writer reads");

  // The exact real-world contradiction: the prompt cannot claim there is nothing to fix.
  const complianceSectionText = prompt.slice(
    prompt.indexOf("### Compliance Checks Blocking Approval"),
    prompt.indexOf("### Blocking Issues to Resolve")
  );
  assert.doesNotMatch(complianceSectionText, /None — every named compliance check passes/);
});

test("S26B-09 review feedback markdown also names the blocking checks with reasons", () => {
  const c = compliance({ technologyGrouping: "REVIEW" }, { technologyGrouping: [TECH_GROUPING_REASON] });
  const md = renderReviewFeedbackMarkdown(review({ instructionCompliance: c }));
  assert.match(md, /## Compliance Checks Blocking Approval/);
  assert.match(md, /technologyGrouping: REVIEW/);
  assert.ok(md.includes(TECH_GROUPING_REASON));
});

test("S26B-10 every gate-relevant check name is covered — hard and soft alike", () => {
  // Guards against a future check being added to the taxonomy but silently omitted from corrections.
  for (const name of [...HARD_GATE_CHECKS, ...SOFT_GATE_CHECKS]) {
    const corrections = gateBlockingComplianceCorrections(compliance({ [name]: "FAIL" } as Partial<InstructionComplianceChecks>));
    assert.ok(
      corrections.some((c) => c.description.includes(`— ${name}:`)),
      `${name} must produce a correction when it fails`
    );
  }
  assert.equal(
    new Set([...HARD_GATE_CHECKS, ...SOFT_GATE_CHECKS]).size,
    INSTRUCTION_COMPLIANCE_CHECK_NAMES.length,
    "hard + soft must together cover every named check, or some check could block READY with no correction"
  );
});
