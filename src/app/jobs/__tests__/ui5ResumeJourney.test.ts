import assert from "node:assert/strict";
import test from "node:test";
import { presentResumeJourney, type JourneyStepState } from "../[id]/resumeJourneyPresentation";

/**
 * UI-5 — behavioral tests against the pure engine-state → candidate-stage mapping. These call the
 * real function with real-shaped inputs rather than regex-matching source text, per the phase's own
 * "prefer behavioral tests" instruction — this module has no React rendering to test against, so a
 * direct function call is the genuine behavioral test.
 */

function stageState(stages: { key: string; state: JourneyStepState }[] | null, key: string): JourneyStepState | undefined {
  return stages?.find((s) => s.key === key)?.state;
}

test("UI5-STAGE-01: real engine state maps to the correct user-facing stage — one case per real status", () => {
  const writer = presentResumeJourney({ status: "WRITER_RUNNING", waitingFor: "EXTERNAL_WRITER", disposition: null, blockingReason: null });
  assert.equal(writer.currentStageKey, "tailoring");

  const created = presentResumeJourney({ status: "CREATED", waitingFor: "EXTERNAL_WRITER", disposition: null, blockingReason: null });
  assert.equal(created.currentStageKey, "tailoring", "CREATED means approved-and-waiting, not unstarted");

  const review = presentResumeJourney({ status: "REVIEW_RUNNING", waitingFor: null, disposition: null, blockingReason: null });
  assert.equal(review.currentStageKey, "checking_quality");
  assert.equal(stageState(review.stages, "tailoring"), "completed");

  const improving = presentResumeJourney({ status: "IMPROVEMENT_RUNNING", waitingFor: null, disposition: null, blockingReason: null });
  assert.equal(improving.currentStageKey, "finalizing");
  assert.equal(stageState(improving.stages, "checking_quality"), "completed");

  const ready = presentResumeJourney({ status: "READY", waitingFor: "COMPLETED", disposition: "READY", blockingReason: null });
  assert.equal(ready.currentStageKey, "ready");
  assert.equal(stageState(ready.stages, "finalizing"), "completed");
  assert.equal(ready.tone, "ready");
});

test("UI5-STAGE-02: no fake or interpolated progress — stage only advances on a real status/disposition change", () => {
  const a = presentResumeJourney({ status: "WRITER_RUNNING", waitingFor: null, disposition: null, blockingReason: null });
  const b = presentResumeJourney({ status: "WRITER_RUNNING", waitingFor: null, disposition: null, blockingReason: null });
  assert.deepEqual(a, b, "identical input must always produce identical output — no clock, no randomness, no timer");
  assert.equal(a.currentStageKey, b.currentStageKey);
});

test("UI5-STAGE-03: internal enum names never leak into the headline/explanation copy", () => {
  const banned = /WRITER_RUNNING|REVIEW_COMPLETED|IMPROVEMENT_RUNNING|SAFE_BEST_ATTEMPT|workflowId|review_json|checkpoint/;
  for (const status of ["CREATED", "WRITER_RUNNING", "REVIEW_RUNNING", "IMPROVEMENT_RUNNING", "READY", "FAILED", null]) {
    for (const disposition of ["READY", "SAFE_BEST_ATTEMPT", "BLOCKED", null] as const) {
      const result = presentResumeJourney({ status, waitingFor: null, disposition, blockingReason: null });
      assert.doesNotMatch(result.headline, banned, `headline leaked an internal enum for status=${status} disposition=${disposition}`);
      assert.doesNotMatch(result.explanation, banned, `explanation leaked an internal enum for status=${status} disposition=${disposition}`);
    }
  }
});

test("UI5-READY-01: the ready state only appears from a real READY status with a non-safe-best-attempt disposition", () => {
  const ready = presentResumeJourney({ status: "READY", waitingFor: "COMPLETED", disposition: "READY", blockingReason: null });
  assert.equal(ready.tone, "ready");
  assert.equal(ready.offerDownloads, true);

  for (const status of ["CREATED", "WRITER_RUNNING", "REVIEW_RUNNING", "IMPROVEMENT_RUNNING", "FAILED", null]) {
    const notReady = presentResumeJourney({ status, waitingFor: null, disposition: null, blockingReason: null });
    assert.notEqual(notReady.tone, "ready", `status=${status} must never present as ready`);
    assert.equal(notReady.offerDownloads, false, `status=${status} must never offer downloads`);
  }
});

test("UI5-READY-02: a SAFE_BEST_ATTEMPT disposition is never presented as fully ready, and never as a plain failure", () => {
  // The disposition can occur even when the underlying workflow.status is FAILED — see
  // ResumeQualityPipeline.tsx's own isSafeBestAttempt/isBlockedUnsafe distinction, which this
  // mirrors rather than re-deriving independently.
  const safeButFailed = presentResumeJourney({ status: "FAILED", waitingFor: null, disposition: "SAFE_BEST_ATTEMPT", blockingReason: null });
  assert.equal(safeButFailed.isSafeBestAttempt, true);
  assert.equal(safeButFailed.tone, "review");
  assert.notEqual(safeButFailed.tone, "ready");
  assert.equal(safeButFailed.isBlocked, false, "a safe best attempt must not be reported as blocked");

  const genuineFailure = presentResumeJourney({ status: "FAILED", waitingFor: null, disposition: "BLOCKED", blockingReason: "A real blocking reason" });
  assert.equal(genuineFailure.isSafeBestAttempt, false);
  assert.equal(genuineFailure.isBlocked, true);
  assert.equal(genuineFailure.offerDownloads, false);
});

test("UI5-METRIC-01: the resume journey never contains interview/offer predictive language", () => {
  const banned = /interview\s*(rate|probability|likelihood|chance|score)|offer\s*(rate|probability|chance)|hiring\s*probability|predicted\s*(interview|offer|recruiter)/i;
  const statuses = ["CREATED", "WRITER_RUNNING", "REVIEW_RUNNING", "IMPROVEMENT_RUNNING", "READY", "FAILED", null];
  const dispositions = ["READY", "SAFE_BEST_ATTEMPT", "BLOCKED", null] as const;
  for (const status of statuses) {
    for (const disposition of dispositions) {
      const result = presentResumeJourney({ status, waitingFor: null, disposition, blockingReason: null });
      assert.doesNotMatch(result.headline, banned);
      assert.doesNotMatch(result.explanation, banned);
    }
  }
});

test("a workflow that does not exist yet has no stages and is not presented as blocked or ready", () => {
  const result = presentResumeJourney({ status: null, waitingFor: null, disposition: null, blockingReason: null });
  assert.equal(result.stages, null);
  assert.equal(result.currentStageKey, null);
  assert.equal(result.isBlocked, false);
  assert.equal(result.offerDownloads, false);
});
