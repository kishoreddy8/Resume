import assert from "node:assert/strict";
import test from "node:test";
import {
  jobWorkspaceUrl,
  parseWorkspaceRoute,
  resolveWorkspaceRouteStep,
} from "../[id]/workspaceRoute";
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

test("workspace URL builder creates exact Studio, Results, and Validation deep links", () => {
  assert.equal(jobWorkspaceUrl(41, { step: "studio", focus: "tailor" }), "/jobs/41?step=studio&focus=tailor");
  assert.equal(jobWorkspaceUrl(41, { step: "results", focus: "progress" }), "/jobs/41?step=results&focus=progress");
  assert.equal(jobWorkspaceUrl(41, { step: "validation", focus: "issues" }), "/jobs/41?step=validation&focus=issues");
});

test("valid step and focus query values are accepted without executing anything", () => {
  assert.deepEqual(parseWorkspaceRoute({ step: "validation", focus: "revalidate" }), {
    step: "validation",
    focus: "revalidate",
  });
});

test("invalid and repeated query values fail closed", () => {
  assert.deepEqual(parseWorkspaceRoute({ step: "delete", focus: "run-now" }), { step: null, focus: null });
  assert.deepEqual(parseWorkspaceRoute({ step: ["studio", "application"], focus: ["tailor"] }), {
    step: "studio",
    focus: "tailor",
  });
});

test("an unavailable step falls back to the nearest meaningful valid step", () => {
  const input = steps({
    validation: { state: "locked", lockedReason: "A resume is required." },
  });
  assert.equal(resolveWorkspaceRouteStep("validation", input, "studio"), "results");
});

test("Application deep links cannot bypass readiness or another eligibility reason", () => {
  const input = steps({
    application: { state: "available", lockedReason: "The validator has not cleared this resume to be sent." },
  });
  assert.equal(resolveWorkspaceRouteStep("application", input, "results"), "validation");
});

test("a valid explicit deep link takes precedence over the generic default", () => {
  assert.equal(resolveWorkspaceRouteStep("studio", steps(), "application"), "studio");
});

test("a same-job query update selects Validation instead of retaining the prior local step", () => {
  const request = parseWorkspaceRoute({ step: "validation", focus: "issues" });
  assert.equal(resolveWorkspaceRouteStep(request.step, steps(), "results"), "validation");
  assert.equal(request.focus, "issues");
});
