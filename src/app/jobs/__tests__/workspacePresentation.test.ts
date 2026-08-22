import assert from "node:assert/strict";
import test from "node:test";
import { workspaceHeroPresentation } from "../[id]/workspacePresentation";
import { validationIssues } from "../[id]/validationPresentation";
import type { QualityWorkflowData } from "../[id]/useQualityWorkflow";
import type { StepKey, WorkflowStep } from "../[id]/workflowSteps";

function steps(overrides: Partial<Record<StepKey, Partial<WorkflowStep>>> = {}): WorkflowStep[] {
  return (["match", "studio", "results", "validation", "application"] as StepKey[]).map((key) => ({
    key,
    label: key,
    state: "available",
    lockedReason: null,
    ...overrides[key],
  }));
}

const base = {
  matchDecision: "READY_FOR_TAILORING",
  resumeStage: null,
  qualityLoading: false,
  readiness: null,
  humanMaySend: null,
  canRevalidate: false,
  runStatuses: [] as string[],
  steps: steps(),
};

test("a strong evaluated match leads with Tailor resume", () => {
  const result = workspaceHeroPresentation(base);
  assert.equal(result.status.label, "Ready to tailor");
  assert.deepEqual(result.action, { label: "Tailor resume", step: "studio", focus: "tailor" });
});

test("an active writer leads to progress without starting any work", () => {
  const result = workspaceHeroPresentation({ ...base, resumeStage: "improvement" });
  assert.equal(result.status.label, "Tailoring");
  assert.deepEqual(result.action, { label: "View progress", step: "results", focus: "progress" });
});

test("a pending canonical read shows a neutral status and no premature action", () => {
  const result = workspaceHeroPresentation({ ...base, qualityLoading: true });
  assert.equal(result.status.label, "Checking resume status");
  assert.equal(result.action, null);
});

test("canonical refusal overrides a high score and directs the candidate to issues", () => {
  const result = workspaceHeroPresentation({
    ...base,
    readiness: "BLOCKED",
    humanMaySend: false,
  });
  assert.equal(result.status.label, "Blocked");
  assert.deepEqual(result.action, { label: "Review issues", step: "validation", focus: "issues" });
});

test("legacy validation offers only the existing revalidation action", () => {
  const result = workspaceHeroPresentation({
    ...base,
    readiness: "BLOCKED",
    humanMaySend: false,
    canRevalidate: true,
  });
  assert.deepEqual(result.action, { label: "Re-run validation", step: "validation", focus: "revalidate" });
});

test("canonical READY plus humanMaySend unlocks Start application", () => {
  const result = workspaceHeroPresentation({
    ...base,
    readiness: "READY",
    humanMaySend: true,
  });
  assert.equal(result.status.label, "Application ready");
  assert.deepEqual(result.action, { label: "Start application", step: "application", focus: null });
});

test("an eligibility reason suppresses an otherwise requested action", () => {
  const result = workspaceHeroPresentation({
    ...base,
    readiness: "READY",
    humanMaySend: true,
    steps: steps({ application: { state: "available", lockedReason: "Not eligible." } }),
  });
  assert.equal(result.action, null);
});

test("historical structured corrections become readable validation issues", () => {
  const data = {
    workflowStatus: "FAILED",
    review: {
      overallScore: 80,
      atsScore: 80,
      keywordAlignmentScore: 80,
      truthfulnessScore: 80,
      architectureConsistencyScore: 80,
      recruiterReadabilityScore: 80,
      formattingScore: 80,
      missingRequiredSkills: [],
      truthfulnessIssues: ["Verify employer evidence"],
      blockingIssues: [],
      requiredCorrections: [{ priority: "high", description: "Remove unsupported claim" }],
    },
    gate: { passed: false, outcome: "BLOCKED" },
    readiness: {
      readiness: "BLOCKED",
      blockingReasons: ["Verify employer evidence"],
      improvementReasons: [],
      humanMaySend: false,
    },
    iterations: [],
    revalidation: null,
  } satisfies QualityWorkflowData;

  assert.deepEqual(validationIssues(data), ["Verify employer evidence", "Remove unsupported claim"]);
});
