import test from "node:test";
import assert from "node:assert/strict";
import { buildStages, FAILURE_GUIDANCE, shortFailure, type StageInputs } from "../stageModel";

const base: StageInputs = {
  saved: true,
  documentsPresent: true,
  status: "running",
  observed: [],
  failureCode: null,
  evaluating: false,
  evaluatedCount: 0,
  hasEvaluated: false,
};

const stateOf = (s: ReturnType<typeof buildStages>, key: string) => s.find((x) => x.key === key)?.state;

test("STAGE-0 'setup saved' never claims documents are stored when they are not", () => {
  const s = buildStages({ ...base, documentsPresent: false });
  const saved = s.find((x) => x.key === "saved");
  assert.equal(saved?.state, "done", "the details really did save");
  assert.doesNotMatch(saved?.detail ?? "", /document/, "a settings write does not prove an upload happened");

  const withDocs = buildStages({ ...base, documentsPresent: true });
  assert.match(withDocs.find((x) => x.key === "saved")?.detail ?? "", /both documents are uploaded/);
});

test("STAGE-1 nothing observed means nothing claimed as done", () => {
  const s = buildStages(base);
  for (const key of ["extracting", "reading_resume", "reading_skills", "writing"]) {
    assert.equal(stateOf(s, key), "pending", `${key} must not be marked done before it is observed`);
  }
});

test("STAGE-2 the most recent observation is the active one, earlier ones are done", () => {
  const s = buildStages({ ...base, observed: ["extracting", "reading_resume"] });
  assert.equal(stateOf(s, "extracting"), "done");
  assert.equal(stateOf(s, "reading_resume"), "active");
  assert.equal(stateOf(s, "reading_skills"), "pending");
});

test("STAGE-3 out-of-order reads are each marked from their OWN event", () => {
  const s = buildStages({ ...base, observed: ["extracting", "reading_skills"] });
  assert.equal(stateOf(s, "reading_skills"), "active");
  assert.equal(stateOf(s, "reading_resume"), "pending", "a step that has not happened is not done");
});

test("STAGE-4 validation is done ONLY when the loader accepted the profile", () => {
  const written = buildStages({ ...base, observed: ["extracting", "reading_resume", "reading_skills", "writing"] });
  assert.equal(stateOf(written, "validating"), "pending", "the CLI writing a file is not validation passing");

  const accepted = buildStages({ ...base, status: "done", observed: ["writing", "validating"] });
  assert.equal(stateOf(accepted, "validating"), "done");
});

test("STAGE-5 a rejected profile marks validation failed, never done", () => {
  const s = buildStages({
    ...base,
    status: "failed",
    failureCode: "validation_failed",
    observed: ["extracting", "reading_resume", "reading_skills", "writing", "validating"],
  });
  assert.equal(stateOf(s, "validating"), "failed");
  assert.notEqual(stateOf(s, "evaluation"), "done", "evaluation must not appear to have run on rejected data");
});

test("STAGE-6 evaluation reports the real count while running", () => {
  const s = buildStages({ ...base, status: "done", evaluating: true, evaluatedCount: 1240 });
  const ev = s.find((x) => x.key === "evaluation");
  assert.equal(ev?.state, "active");
  assert.match(ev?.detail ?? "", /1,240 scored so far/);
});

test("STAGE-7 a CLI failure does not mark later stages as done", () => {
  const s = buildStages({ ...base, status: "failed", failureCode: "cli_timeout", observed: ["extracting"] });
  assert.equal(stateOf(s, "extracting"), "failed", "the last thing seen is where it stopped");
  assert.equal(stateOf(s, "writing"), "pending");
  assert.equal(stateOf(s, "validating"), "pending");
});

test("STAGE-8 every failure code has guidance covering what/safe/next", () => {
  for (const [code, g] of Object.entries(FAILURE_GUIDANCE)) {
    assert.ok(g.title.length > 0, `${code} needs a title`);
    assert.ok(g.what.length > 0, `${code} must explain what failed`);
    assert.ok(g.safe.length > 0, `${code} must state what remains safe`);
    assert.ok(g.next.length > 0, `${code} must give a next action`);
  }
});

test("STAGE-9 an unknown failure code still yields usable guidance", () => {
  assert.equal(shortFailure("something_new"), shortFailure("unexpected"));
  assert.ok(shortFailure(null).length > 0);
});

test("STAGE-10 guidance never leaks raw output shapes into user-facing text", () => {
  for (const [code, g] of Object.entries(FAILURE_GUIDANCE)) {
    const all = `${g.title} ${g.what} ${g.safe} ${g.next}`;
    assert.doesNotMatch(all, /\bat \w+ \(|Error:|\bstack\b|undefined|\[object/, `${code} reads like raw output`);
  }
});
