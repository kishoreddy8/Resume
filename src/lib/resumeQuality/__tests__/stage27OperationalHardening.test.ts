import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";
import { evaluateInstructionCompliance, gateBlockingComplianceCorrections } from "../instructionCompliance";
import { evaluateQualityGate } from "../qualityGate";
import { evaluateWorkflowRetry } from "../workflowRetry";
import { parseCliRunMetadata } from "../writers/claudeCliInvoker";
import {
  clearTechnicalFailures,
  getTechnicalFailureCount,
  getTechnicalFailureState,
  MAX_TECHNICAL_PASSES,
  recordNonCountingFailure,
  recordTechnicalFailure,
} from "../writers/handoffClaim";
import type { ComplianceStatus, InstructionComplianceChecks, StructuredResumeReview } from "../types";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";

/**
 * Stage 27 — operational hardening.
 *
 * Pure/filesystem-only tests: no database, no network, no Claude, no candidate evidence. Everything
 * here is about the writer being able to RECOVER and to describe itself truthfully — none of it may
 * change a quality verdict, and several cases assert exactly that.
 */

// =================================================================================================
// A. Bounded technical failure -> terminal, recoverable state (the wedge that had no reset path)
// =================================================================================================

function tmpHandoff(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s27-handoff-"));
}

test("S27-01 technical failures below the cap keep their retry budget", () => {
  const dir = tmpHandoff();
  try {
    for (let i = 1; i < MAX_TECHNICAL_PASSES; i++) {
      const count = recordTechnicalFailure(dir, `transient ${i}`, "TRANSIENT_TECHNICAL_FAILURE");
      assert.equal(count, i);
      assert.equal(getTechnicalFailureState(dir).atCap, false, `attempt ${i} must not be at the cap`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S27-02 the cap is reached exactly at MAX_TECHNICAL_PASSES and is reported as such", () => {
  const dir = tmpHandoff();
  try {
    for (let i = 1; i <= MAX_TECHNICAL_PASSES; i++) recordTechnicalFailure(dir, `boom ${i}`, "PROVIDER_UNAVAILABLE");
    const state = getTechnicalFailureState(dir);
    assert.equal(state.attempts, MAX_TECHNICAL_PASSES);
    assert.equal(state.atCap, true);
    assert.equal(state.lastFailureClass, "PROVIDER_UNAVAILABLE", "the reason the budget was spent must survive");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S27-03 an operator-actionable failure never spends the technical budget", () => {
  const dir = tmpHandoff();
  try {
    recordTechnicalFailure(dir, "a real transient failure", "TRANSIENT_TECHNICAL_FAILURE");
    assert.equal(getTechnicalFailureCount(dir), 1);

    // A subscription limit / logged-out CLI could otherwise burn the whole budget during one normal
    // usage window and wedge the workflow permanently — the exact Stage 27 P0 defect.
    for (let i = 0; i < 20; i++) recordNonCountingFailure(dir, "usage limit reached", "SUBSCRIPTION_LIMIT_REACHED");
    assert.equal(getTechnicalFailureCount(dir), 1, "the counter must not move");
    assert.equal(getTechnicalFailureState(dir).atCap, false);
    assert.equal(getTechnicalFailureState(dir).lastFailureClass, "SUBSCRIPTION_LIMIT_REACHED", "but the reason is recorded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S27-04 the operator reset clears technical bookkeeping and only that", () => {
  const dir = tmpHandoff();
  try {
    // A marker file standing in for everything else that lives beside a handoff — the reset must not
    // touch anything but its own bookkeeping file.
    fs.writeFileSync(path.join(dir, "writer_output.json"), '{"kept":true}');
    for (let i = 0; i < MAX_TECHNICAL_PASSES; i++) recordTechnicalFailure(dir, "boom", "TRANSIENT_TECHNICAL_FAILURE");
    assert.equal(getTechnicalFailureState(dir).atCap, true);

    clearTechnicalFailures(dir);

    assert.equal(getTechnicalFailureCount(dir), 0, "budget restored");
    assert.equal(getTechnicalFailureState(dir).atCap, false);
    assert.equal(fs.readFileSync(path.join(dir, "writer_output.json"), "utf-8"), '{"kept":true}', "nothing else touched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =================================================================================================
// B. Truthful runtime metadata (never fabricated)
// =================================================================================================

/** Shape captured from a real `claude -p --output-format json` run of the installed CLI (2.1.235). */
const REAL_PRINT_MODE_STDOUT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1362,
  num_turns: 1,
  session_id: "0f4d2c9a-1111-2222-3333-444455556666",
  total_cost_usd: 0.0263435,
  terminal_reason: "completed",
  modelUsage: {
    "claude-haiku-4-5-20251001": { outputTokens: 9, canonicalModel: "claude-haiku-4-5", provider: "firstParty" },
    "claude-opus-5[1m]": { outputTokens: 400, canonicalModel: "claude-opus-5", provider: "firstParty" },
  },
});

test("S27-10 run metadata is read from the CLI's own report", () => {
  const meta = parseCliRunMetadata(REAL_PRINT_MODE_STDOUT);
  assert.ok(meta);
  assert.equal(meta.provider, "claude-cli");
  assert.equal(meta.model, "claude-opus-5", "the model that produced the most output is the one credited");
  assert.equal(meta.sessionId, "0f4d2c9a-1111-2222-3333-444455556666");
  assert.equal(meta.durationMs, 1362);
  assert.equal(meta.numTurns, 1);
});

test("S27-11 a missing model stays null rather than being invented", () => {
  const meta = parseCliRunMetadata(JSON.stringify({ type: "result", subtype: "success", session_id: "abc" }));
  assert.ok(meta);
  assert.equal(meta.model, null, "no modelUsage means no model claim");
  assert.equal(meta.provider, "claude-cli", "the route we took is still a fact we know");
});

test("S27-12 unparseable stdout yields no metadata instead of throwing", () => {
  assert.equal(parseCliRunMetadata("not json at all"), null);
  assert.equal(parseCliRunMetadata(""), null);
});

// =================================================================================================
// C. Terminal-workflow retry, behind fresh human approval
// =================================================================================================

const AUTHORIZED = { isAuthorized: true, blockingReason: null };
const UNAUTHORIZED = { isAuthorized: false, blockingReason: "Tailoring approval stale: approved for READY_FOR_TAILORING, but current match decision is BLOCKED." };

test("S27-20 a job with no workflow creates its first one", () => {
  const d = evaluateWorkflowRetry({ existingWorkflow: null, tailoringMarkedAt: "2026-08-18 10:00:00", authorization: AUTHORIZED });
  assert.equal(d.action, "CREATE_FIRST");
});

test("S27-21 a non-terminal workflow is reused, never duplicated", () => {
  for (const status of ["CREATED", "IMPROVEMENT_RUNNING"]) {
    const d = evaluateWorkflowRetry({
      existingWorkflow: { id: 7, status, created_at: "2026-08-18 09:00:00" },
      tailoringMarkedAt: "2026-08-18 12:00:00",
      authorization: AUTHORIZED,
    });
    assert.equal(d.action, "REUSE_EXISTING", `${status} must be reused`);
  }
});

test("S27-22 a READY workflow is never duplicated, even after a newer approval", () => {
  const d = evaluateWorkflowRetry({
    existingWorkflow: { id: 6, status: "READY", created_at: "2026-08-18 09:00:00" },
    tailoringMarkedAt: "2026-08-18 23:00:00",
    authorization: AUTHORIZED,
  });
  assert.equal(d.action, "REUSE_EXISTING");
});

test("S27-23 a FAILED workflow retries only behind an approval recorded AFTER it", () => {
  const failed = { id: 5, status: "FAILED", created_at: "2026-08-18 18:26:02" };

  const fresh = evaluateWorkflowRetry({ existingWorkflow: failed, tailoringMarkedAt: "2026-08-18 21:00:00", authorization: AUTHORIZED });
  assert.equal(fresh.action, "CREATE_RETRY", "a genuine re-approval may start a new attempt");

  const stale = evaluateWorkflowRetry({ existingWorkflow: failed, tailoringMarkedAt: "2026-08-18 10:00:00", authorization: AUTHORIZED });
  assert.equal(stale.action, "REFUSE");
  assert.equal(stale.action === "REFUSE" && stale.code, "STALE_APPROVAL_FOR_RETRY");

  const none = evaluateWorkflowRetry({ existingWorkflow: failed, tailoringMarkedAt: null, authorization: AUTHORIZED });
  assert.equal(none.action, "REFUSE", "no approval on file can never authorize a retry");
});

test("S27-24 an unauthorized job (e.g. now BLOCKED, or stale approval) can never retry or create", () => {
  for (const existing of [
    null,
    { id: 5, status: "FAILED", created_at: "2026-08-18 09:00:00" },
    { id: 5, status: "CREATED", created_at: "2026-08-18 09:00:00" },
  ]) {
    const d = evaluateWorkflowRetry({ existingWorkflow: existing, tailoringMarkedAt: "2026-08-18 23:00:00", authorization: UNAUTHORIZED });
    assert.equal(d.action, "REFUSE");
    assert.equal(d.action === "REFUSE" && d.code, "NOT_AUTHORIZED");
  }
});

test("S27-25 a retry never mutates the failed workflow — the decision only ever describes creating a NEW one", () => {
  const failed = { id: 5, status: "FAILED", created_at: "2026-08-18 18:26:02" };
  const d = evaluateWorkflowRetry({ existingWorkflow: failed, tailoringMarkedAt: "2026-08-18 21:00:00", authorization: AUTHORIZED });
  assert.equal(d.action, "CREATE_RETRY");
  // The decision carries no instruction to reopen, patch, or transition the old row — the only
  // actions this type can express are reuse/create/refuse.
  assert.equal(failed.status, "FAILED");
});

// =================================================================================================
// D. Check-note attribution (Stage 26B pipeline gets a reason for every blocking check)
// =================================================================================================

function complianceInput(overrides: Record<string, unknown> = {}) {
  return {
    hasMasterProfile: true,
    employmentOrEducationBlockingIssues: [],
    employmentOrEducationSoftIssues: [],
    ungroundedTechnologies: [],
    deepRewriteStatus: "PASS" as ComplianceStatus,
    architectureContradictions: [],
    coverLetterContradictions: [],
    technologyGroupingFindings: [],
    laundryListFindings: [],
    metricProvenance: { entries: [], unsupportedCount: 0 },
    suspiciousRepeatedMetrics: [],
    insufficientRequirementData: false,
    keywordOptimizationStatus: "PASS" as ComplianceStatus,
    genericBulletsCount: 0,
    bannedLanguageInBulletsCount: 0,
    bannedLanguageInSummaryCount: 0,
    everySentenceAtsStatus: "PASS" as ComplianceStatus,
    crossDocumentStatus: "PASS" as ComplianceStatus,
    crossDocumentContradictions: [],
    duplicateBulletPhrasingCount: 0,
    yearsInflationIssues: [],
    educationHidden: false,
    employmentTypeStatus: "PASS" as ComplianceStatus,
    employmentTypeFlags: [],
    lengthStatus: "PASS" as ComplianceStatus,
    verbTenseStatus: "PASS" as ComplianceStatus,
    structuralBlockingIssues: [],
    formattingScore: 100,
    anyBlockingIssues: false,
    ...overrides,
  };
}

const RESUME_CONTRADICTION = 'Fiserv: "Azure Synapse Analytics + Snowflake" (competing data warehouses) with no migration framing.';
const COVER_CONTRADICTION = 'Cover letter: "Azure Synapse Analytics + Redshift + Snowflake" with no migration framing.';

test("S27-30 technologyAdaptation and migrationIntegrity now carry their reason", () => {
  const result = evaluateInstructionCompliance(
    complianceInput({
      architectureContradictions: [RESUME_CONTRADICTION],
      coverLetterContradictions: [COVER_CONTRADICTION],
    }) as never
  );

  // Premise: these really do FAIL, and really do block READY.
  assert.equal(result.checks.technologyAdaptation, "FAIL");
  assert.equal(result.checks.migrationIntegrity, "FAIL");

  for (const check of ["technologyAdaptation", "migrationIntegrity"] as const) {
    const notes = result.checkNotes?.[check] ?? [];
    assert.ok(notes.length > 0, `${check} must carry evidence, not just a status`);
    assert.ok(notes.includes(RESUME_CONTRADICTION), `${check} must cite the real finding verbatim`);
  }

  // And the writer actually receives it through the Stage 26B correction pipeline.
  const corrections = gateBlockingComplianceCorrections(result);
  const adaptation = corrections.find((c) => c.description.includes("technologyAdaptation"));
  assert.ok(adaptation, "technologyAdaptation must reach the writer as a correction");
  assert.ok(adaptation.description.includes(RESUME_CONTRADICTION), "with its concrete reason attached");
});

test("S27-31 the flat notes array is byte-for-byte unchanged by the attribution", () => {
  const input = complianceInput({
    architectureContradictions: [RESUME_CONTRADICTION],
    coverLetterContradictions: [COVER_CONTRADICTION],
  });
  const result = evaluateInstructionCompliance(input as never);

  // Exactly the pre-Stage-27 content and order: architectureIntegrity's finding, then
  // noContradictingTechnologies'. Attribution must not have duplicated either of them.
  assert.deepEqual(result.notes, [RESUME_CONTRADICTION, COVER_CONTRADICTION]);
  assert.equal(result.notes.filter((n) => n === RESUME_CONTRADICTION).length, 1, "no duplication into notes");
  assert.equal(result.notes.filter((n) => n === COVER_CONTRADICTION).length, 1, "no duplication into notes");
});

test("S27-32 attribution never invents a reason where there is no finding", () => {
  const clean = evaluateInstructionCompliance(complianceInput() as never);
  assert.equal(clean.checks.technologyAdaptation, "PASS");
  assert.equal(clean.checks.migrationIntegrity, "PASS");
  assert.equal(clean.checkNotes?.technologyAdaptation, undefined);
  assert.equal(clean.checkNotes?.migrationIntegrity, undefined);
  assert.deepEqual(clean.notes, []);
});

// =================================================================================================
// E. Frozen semantics — Stage 27 must not have moved the gate
// =================================================================================================

function allChecks(status: ComplianceStatus): InstructionComplianceChecks {
  const checks = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) checks[name] = status;
  return checks;
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
    instructionCompliance: {
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      checks: allChecks("PASS"),
      notes: [],
    },
    ...overrides,
  } as StructuredResumeReview;
}

test("S27-40 the quality gate is exactly as strict as before Stage 27", () => {
  assert.equal(evaluateQualityGate(review(), 1, 3), "READY", "a genuinely clean review still passes");
  const mustBlock: Array<[string, StructuredResumeReview]> = [
    ["overallScore < 95", review({ overallScore: 94 })],
    ["truthfulness < 100", review({ truthfulnessScore: 99 })],
    ["architecture < 100", review({ architectureConsistencyScore: 99 })],
    ["a blocking issue", review({ blockingIssues: ["x"] })],
    ["missing compliance", review({ instructionCompliance: undefined })],
    ["a typed blocking failure", review({ blockingFailures: [{ type: "PLACEHOLDER_CONTACT", description: "x" }] })],
    ["missing blockingFailures", review({ blockingFailures: undefined })],
    ["recruiter quality REVIEW", review({ recruiterQualityAssessment: { status: "REVIEW", score: 100, issues: [] } })],
  ];
  for (const [label, r] of mustBlock) {
    assert.notEqual(evaluateQualityGate(r, 1, 3), "READY", `${label} must still block READY`);
  }
});

test("S27-41 a low recruiter-quality SCORE still never blocks, and a BLOCKING status still always does", () => {
  // The exact real-corpus shape that reads like a contradiction: PASS with a heavily-deflated score.
  const advisoryOnly = review({ recruiterQualityAssessment: { status: "PASS", score: 30, issues: [] } });
  assert.equal(evaluateQualityGate(advisoryOnly, 1, 3), "READY", "score is diagnostic; only status gates");

  const blocked = review({ recruiterQualityAssessment: { status: "FAIL", score: 100, issues: [] } });
  assert.notEqual(evaluateQualityGate(blocked, 1, 3), "READY", "a perfect score cannot override a FAIL status");
});
