import assert from "node:assert/strict";
import { test } from "node:test";
import { assertValidWorkflowTransition, InvalidWorkflowTransitionError, isValidWorkflowTransition } from "../stateMachine";
import { WORKFLOW_STATUSES, type WorkflowStatus } from "../types";

test("workflow-state transitions: the full documented happy path is legal step by step", () => {
  const happyPath: WorkflowStatus[] = [
    "CREATED",
    "WRITER_RUNNING",
    "WRITER_COMPLETED",
    "REVIEW_RUNNING",
    "REVIEW_COMPLETED",
    "READY",
  ];
  for (let i = 0; i < happyPath.length - 1; i++) {
    assert.equal(isValidWorkflowTransition(happyPath[i], happyPath[i + 1]), true, `${happyPath[i]} -> ${happyPath[i + 1]} should be legal`);
  }
});

test("workflow-state transitions: an improvement cycle loops REVIEW_COMPLETED -> IMPROVEMENT_RUNNING -> REVIEW_RUNNING", () => {
  assert.equal(isValidWorkflowTransition("REVIEW_COMPLETED", "IMPROVEMENT_RUNNING"), true);
  assert.equal(isValidWorkflowTransition("IMPROVEMENT_RUNNING", "REVIEW_RUNNING"), true);
});

test("workflow-state transitions: any *_RUNNING phase can fail", () => {
  assert.equal(isValidWorkflowTransition("WRITER_RUNNING", "FAILED"), true);
  assert.equal(isValidWorkflowTransition("REVIEW_RUNNING", "FAILED"), true);
  assert.equal(isValidWorkflowTransition("IMPROVEMENT_RUNNING", "FAILED"), true);
  assert.equal(isValidWorkflowTransition("CREATED", "FAILED"), true);
});

test("workflow-state transitions: READY and FAILED are terminal — nothing transitions out of them", () => {
  for (const to of WORKFLOW_STATUSES) {
    assert.equal(isValidWorkflowTransition("READY", to), false, `READY -> ${to} must be illegal`);
    assert.equal(isValidWorkflowTransition("FAILED", to), false, `FAILED -> ${to} must be illegal`);
  }
});

test("workflow-state transitions: cannot skip phases (e.g. CREATED straight to REVIEW_RUNNING)", () => {
  assert.equal(isValidWorkflowTransition("CREATED", "REVIEW_RUNNING"), false);
  assert.equal(isValidWorkflowTransition("CREATED", "READY"), false);
  assert.equal(isValidWorkflowTransition("WRITER_RUNNING", "REVIEW_COMPLETED"), false);
});

test("workflow-state transitions: cannot go backwards (e.g. REVIEW_COMPLETED -> WRITER_RUNNING)", () => {
  assert.equal(isValidWorkflowTransition("REVIEW_COMPLETED", "WRITER_RUNNING"), false);
  assert.equal(isValidWorkflowTransition("READY", "REVIEW_COMPLETED"), false);
});

test("assertValidWorkflowTransition: throws InvalidWorkflowTransitionError with the offending states on an illegal transition", () => {
  assert.throws(
    () => assertValidWorkflowTransition("CREATED", "READY"),
    (err: unknown) => err instanceof InvalidWorkflowTransitionError && err.from === "CREATED" && err.to === "READY"
  );
});

test("assertValidWorkflowTransition: does not throw on a legal transition", () => {
  assert.doesNotThrow(() => assertValidWorkflowTransition("CREATED", "WRITER_RUNNING"));
});
