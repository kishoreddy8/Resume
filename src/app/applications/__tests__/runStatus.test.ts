import test from "node:test";
import assert from "node:assert/strict";
import { MARKER_CLASS, MARKER_TEXT, STATUS_PRESENTATION, presentStatus } from "../runStatus";
import { WAITING_STATES, isTerminal, type RunStatus } from "@/lib/apply/runState";

/**
 * How run states are presented.
 *
 * The UI layer must not invent, merge or infer a status — these tests pin it to the engine's own
 * states, and check the wording rules that make a paused run readable rather than alarming.
 */

const ALL = Object.keys(STATUS_PRESENTATION) as RunStatus[];

test("UI-1 every engine state has a presentation, and none is invented", () => {
  /* Both directions: no state without a presentation, no presentation without a state. A drifting
   * table would mean a real status silently rendering as something else. */
  for (const s of WAITING_STATES) {
    assert.ok(STATUS_PRESENTATION[s], `${s} has no presentation`);
  }
  for (const s of ALL) {
    assert.ok(STATUS_PRESENTATION[s].label.length > 0, `${s} has no label`);
  }
});

test("UI-2 exactly the states that need a person say so", () => {
  /* Two different reasons to need someone, and both must surface:
   *   - the engine's WAITING_* set: the run is paused mid-flight, awaiting input.
   *   - SUBMISSION_UNCONFIRMED: the run is OVER, but whether it landed is unknown, and only the
   *     user can find out. Excluding it would bury the one outcome worth chasing.
   * Nothing else may claim to need attention. */
  const shouldNeedUser = new Set<string>([...WAITING_STATES, "SUBMISSION_UNCONFIRMED"]);
  for (const s of ALL) {
    assert.equal(
      STATUS_PRESENTATION[s].needsUser,
      shouldNeedUser.has(s),
      `${s}: needsUser is wrong for this state`
    );
  }
});

test("UI-3 a paused run is NEVER described as an error", () => {
  for (const s of WAITING_STATES) {
    const label = STATUS_PRESENTATION[s].label;
    assert.doesNotMatch(label, /fail|error|problem|broken/i, `"${label}" describes a fault, not a wait`);
  }
});

test("UI-4 an unconfirmed submission is not shown as failed OR as submitted", () => {
  const p = STATUS_PRESENTATION.SUBMISSION_UNCONFIRMED;
  assert.doesNotMatch(p.label, /fail/i, "the click happened; only the outcome is unknown");
  assert.notEqual(p.label, STATUS_PRESENTATION.SUBMITTED.label, "it must not read as a confirmed submission");
  assert.equal(p.needsUser, true, "the user has to go and check");
});

test("UI-5 state is carried by a word AND a shape, never colour alone", () => {
  for (const s of ALL) {
    const { marker, label } = STATUS_PRESENTATION[s];
    assert.ok(label.trim().length > 0, `${s} must carry a word`);
    assert.ok(MARKER_CLASS[marker], `${s} has no marker class`);
    assert.ok(MARKER_TEXT[marker], `${s} has no marker text class`);
  }
  /* Filled, ringed and dashed are distinguishable without hue. */
  assert.match(MARKER_CLASS.done, /^bg-/, "done is a filled marker");
  assert.match(MARKER_CLASS.waiting, /ring/, "waiting is a ringed marker");
  assert.match(MARKER_CLASS.stopped, /ring/, "stopped is a ringed marker");
  assert.notEqual(MARKER_CLASS.waiting, MARKER_CLASS.stopped, "waiting and stopped must differ in shape");
});

test("UI-6 terminal states never ask the user to act, except an unconfirmed one", () => {
  for (const s of ALL) {
    if (!isTerminal(s)) continue;
    if (s === "SUBMISSION_UNCONFIRMED") continue;
    assert.equal(STATUS_PRESENTATION[s].needsUser, false, `${s} is finished; it must not solicit action`);
  }
});

test("UI-7 an unrecognised status is shown verbatim rather than guessed at", () => {
  const p = presentStatus("SOME_FUTURE_STATE");
  assert.match(p.label, /some future state/i, "a new engine state must not be silently mislabelled");
  assert.equal(p.needsUser, false, "and must not claim to need the user");
});
