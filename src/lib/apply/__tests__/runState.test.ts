import test from "node:test";
import assert from "node:assert/strict";
import { canTransition, isTerminal, isWaiting, WAITING_PROMPT, WAITING_STATES, type RunStatus } from "../runState";

/**
 * The state machine, and the one property the whole auto-apply contract rests on: nothing reaches
 * SUBMITTING except an explicit approval for that run.
 */

const ALL: RunStatus[] = [
  "QUEUED", "STARTING", "NAVIGATING", "ACCOUNT_REQUIRED", "FILLING",
  "WAITING_FOR_ANSWER", "WAITING_FOR_CAPTCHA", "WAITING_FOR_MFA", "WAITING_FOR_EMAIL_VERIFICATION",
  "READY_FOR_REVIEW", "WAITING_FOR_SUBMIT_APPROVAL", "SUBMITTING", "SUBMITTED",
  "SUBMISSION_UNCONFIRMED", "FAILED", "CANCELLED",
];

test("RUN-1 SUBMITTING is reachable ONLY from explicit submit approval", () => {
  const sources = ALL.filter((s) => canTransition(s, "SUBMITTING"));
  assert.deepEqual(sources, ["WAITING_FOR_SUBMIT_APPROVAL"], `submission must have exactly one entrance, got ${sources}`);
});

test("RUN-2 no filling or waiting state can jump straight to submission", () => {
  for (const s of ["FILLING", "READY_FOR_REVIEW", "WAITING_FOR_ANSWER", "WAITING_FOR_CAPTCHA", "NAVIGATING"] as RunStatus[]) {
    assert.equal(canTransition(s, "SUBMITTING"), false, `${s} must not reach SUBMITTING`);
    assert.equal(canTransition(s, "SUBMITTED"), false, `${s} must not reach SUBMITTED`);
  }
});

test("RUN-3 a click is not a confirmation — SUBMITTING may end unconfirmed", () => {
  assert.equal(canTransition("SUBMITTING", "SUBMITTED"), true);
  assert.equal(canTransition("SUBMITTING", "SUBMISSION_UNCONFIRMED"), true);
  assert.equal(canTransition("SUBMISSION_UNCONFIRMED", "SUBMITTED"), true, "the user can confirm it later");
});

test("RUN-4 terminal states are terminal", () => {
  for (const s of ["SUBMITTED", "FAILED", "CANCELLED"] as RunStatus[]) {
    assert.equal(isTerminal(s), true);
    assert.deepEqual(ALL.filter((t) => canTransition(s, t)), [], `${s} must have no outgoing transitions`);
  }
});

test("RUN-5 every waiting state can be cancelled and can resume", () => {
  for (const s of WAITING_STATES) {
    assert.equal(isWaiting(s), true);
    assert.equal(canTransition(s, "CANCELLED"), true, `${s} must be abandonable`);
    const resumes = ALL.some((t) => !isTerminal(t) && canTransition(s, t));
    assert.ok(resumes, `${s} must have a way forward`);
  }
});

test("RUN-6 every waiting state tells the user what to do, in their words", () => {
  for (const s of WAITING_STATES) {
    const prompt = WAITING_PROMPT[s];
    assert.ok(prompt && prompt.length > 0, `${s} has no prompt`);
    assert.doesNotMatch(prompt, /blocked|error|failure/i, `"${prompt}" describes a fault rather than an action`);
  }
});

test("RUN-7 verification states never route around the human", () => {
  // A CAPTCHA/MFA state must go back into the flow, never forward to review or submission.
  for (const s of ["WAITING_FOR_CAPTCHA", "WAITING_FOR_MFA", "WAITING_FOR_EMAIL_VERIFICATION"] as RunStatus[]) {
    assert.equal(canTransition(s, "READY_FOR_REVIEW"), false, `${s} must not skip ahead to review`);
    assert.equal(canTransition(s, "SUBMITTING"), false);
    assert.equal(canTransition(s, "FILLING"), true, "it resumes the form it interrupted");
  }
});
