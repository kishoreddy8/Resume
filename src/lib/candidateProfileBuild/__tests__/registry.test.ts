import test from "node:test";
import assert from "node:assert/strict";
import { beginBuild, finishBuild, getBuildState, isBuilding, reportPhase } from "../registry";

/* Ids are per-test so the module-level map cannot leak state between cases. */
let next = 9000;
const fresh = () => next++;

test("REG-1 a second build cannot start while one is running", () => {
  const id = fresh();
  assert.equal(beginBuild(id), true);
  assert.equal(beginBuild(id), false, "a second concurrent build would race to write the same file");
  assert.equal(isBuilding(id), true);
});

test("REG-2 phases record in ARRIVAL order, not a declared order", () => {
  const id = fresh();
  beginBuild(id);
  // Nothing instructs the CLI to read the resume first; this is the order it may genuinely use.
  reportPhase(id, "extracting");
  reportPhase(id, "reading_skills");
  reportPhase(id, "reading_resume");
  assert.deepEqual(getBuildState(id)?.observed, ["extracting", "reading_skills", "reading_resume"]);
});

test("REG-3 an out-of-order phase is never discarded (the monotonic-counter bug)", () => {
  const id = fresh();
  beginBuild(id);
  reportPhase(id, "writing");
  reportPhase(id, "reading_resume");
  assert.ok(
    getBuildState(id)?.observed.includes("reading_resume"),
    "a real observation must never be dropped for arriving after a later-declared one"
  );
});

test("REG-4 a repeated phase is recorded once", () => {
  const id = fresh();
  beginBuild(id);
  reportPhase(id, "reading_resume");
  reportPhase(id, "reading_resume");
  assert.deepEqual(getBuildState(id)?.observed, ["reading_resume"]);
});

test("REG-5 phases are ignored once the build is no longer running", () => {
  const id = fresh();
  beginBuild(id);
  finishBuild(id, { ok: false, code: "cli_timeout", detail: "x" });
  reportPhase(id, "writing");
  assert.equal(getBuildState(id)?.observed.includes("writing"), false);
});

test("REG-6 failure keeps the phases already observed, plus a code", () => {
  const id = fresh();
  beginBuild(id);
  reportPhase(id, "extracting");
  reportPhase(id, "reading_resume");
  finishBuild(id, { ok: false, code: "validation_failed", detail: "loader said invalid" });
  const s = getBuildState(id);
  assert.equal(s?.status, "failed");
  assert.equal(s?.failure?.code, "validation_failed");
  assert.deepEqual(s?.observed, ["extracting", "reading_resume"], "what happened before the failure still happened");
});

test("REG-7 success carries real counts and preserves the start time", () => {
  const id = fresh();
  beginBuild(id);
  const started = getBuildState(id)!.startedAt;
  finishBuild(id, { ok: true, summary: { skills: 38, experience: 3, certifications: 1 } });
  const s = getBuildState(id);
  assert.equal(s?.status, "done");
  assert.deepEqual(s?.summary, { skills: 38, experience: 3, certifications: 1 });
  assert.equal(s?.startedAt, started);
});

test("REG-8 an unknown candidate has no state rather than an invented one", () => {
  assert.equal(getBuildState(fresh()), null);
  assert.equal(isBuilding(fresh()), false);
});
