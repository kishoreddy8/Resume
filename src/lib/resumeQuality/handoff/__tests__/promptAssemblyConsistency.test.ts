import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExternalWriterPrompt } from "../exporter";

/**
 * Phase L (Autonomous Tailoring Quality & Resilience Upgrade) — audits the structural risk that
 * `requiredCorrections`/`blockingIssues`/`blockingFailures`/`complianceCorrections` (raw fields off
 * the latest review) and `repairPlanSection` (the scoped, editable-paths-bearing contract) are two
 * independently-sourced pieces of the same prompt, and could in principle tell the writer to fix
 * something it has no authorized path to edit.
 *
 * FINDING: already correctly architected. `buildExternalWriterPrompt`'s own `priorReviewSection` is
 * conditioned on writerMode, which is itself derived solely from whether a repairPlan exists — so the
 * two can never disagree. In TARGETED_REPAIR mode, the raw correction/blocking-issue/compliance
 * sections are never rendered at all; only a pointer to the Repair Plan appears. These tests lock
 * that behavior in as a regression guard rather than changing anything.
 */

const BASE_INPUT = {
  candidateId: 1,
  candidateName: "Test Candidate",
  applicationId: 1,
  jobId: 1,
  tailoringRunId: 1,
  workflowId: 1,
  iterationNumber: 2,
  selectedTrack: "Data Engineer",
};

test("Phase L: INITIAL_GENERATION renders the raw corrections/blocking sections directly", () => {
  const prompt = buildExternalWriterPrompt({
    ...BASE_INPUT,
    writerMode: "INITIAL_GENERATION",
    requiredCorrections: [{ priority: "HIGH", description: "Tighten the summary." }],
    blockingIssues: ["Competing CI/CD platforms in one bullet."],
    blockingFailures: [{ type: "CROSS_ARTIFACT_CONTRADICTION", description: "Cover letter claims a skill absent from the resume.", evidenceSearched: [] }],
    complianceCorrections: [{ priority: "HIGH", description: "Canonical instruction compliance — hardCareerFacts: FAIL" }],
  });
  assert.match(prompt, /### Required Corrections/);
  assert.match(prompt, /Tighten the summary\./);
  assert.match(prompt, /### Blocking Issues to Resolve/);
  assert.match(prompt, /Competing CI\/CD platforms/);
});

test("Phase L: TARGETED_REPAIR never renders the raw corrections/blocking sections — only the Repair Plan governs", () => {
  const prompt = buildExternalWriterPrompt({
    ...BASE_INPUT,
    writerMode: "TARGETED_REPAIR",
    // Deliberately still supplied, exactly as the real orchestrator does (buildResumeWriterInput
    // always sets requiredCorrections/blockingIssues/etc. alongside repairPlan) — the risk under
    // test is whether these get rendered as a SEPARATE, unconstrained instruction list.
    requiredCorrections: [{ priority: "HIGH", description: "Tighten the summary." }],
    blockingIssues: ["Competing CI/CD platforms in one bullet."],
    blockingFailures: [{ type: "CROSS_ARTIFACT_CONTRADICTION", description: "Cover letter claims a skill absent from the resume.", evidenceSearched: [] }],
    complianceCorrections: [{ priority: "HIGH", description: "Canonical instruction compliance — hardCareerFacts: FAIL" }],
    repairPlanSection: "## TARGETED REPAIR\n\nEditable paths: resume.tagline\n",
  });
  assert.doesNotMatch(prompt, /### Required Corrections/);
  assert.doesNotMatch(prompt, /Tighten the summary\./);
  assert.doesNotMatch(prompt, /### Blocking Issues to Resolve/);
  assert.doesNotMatch(prompt, /Competing CI\/CD platforms/);
  assert.doesNotMatch(prompt, /### Compliance Checks Blocking Approval/);
  assert.match(prompt, /## REPAIR REVIEW CONTRACT/);
  assert.match(prompt, /## TARGETED REPAIR/);
  assert.match(prompt, /Editable paths: resume\.tagline/);
});

test("Phase L: a finalValidation compliance finding is never rendered as a fix-this correction, even though the prompt legitimately names finalValidation once to explain it is NOT a separate task", () => {
  const prompt = buildExternalWriterPrompt({
    ...BASE_INPUT,
    writerMode: "TARGETED_REPAIR",
    repairPlanSection: "## TARGETED REPAIR\n\nEditable paths: resume.tagline\n",
    complianceCorrections: [{ priority: "HIGH", description: "Canonical instruction compliance — finalValidation: FAIL" }],
  });
  // The compliance block itself is fully suppressed in repair mode (asserted in the prior test); the
  // one legitimate mention of "finalValidation" is the boilerplate explaining it is deliberately not
  // repeated as a writing task — never the actual FAIL finding/description text.
  assert.doesNotMatch(prompt, /Canonical instruction compliance — finalValidation/);
});
