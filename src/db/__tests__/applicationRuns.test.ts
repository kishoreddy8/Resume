import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The storage layer must ENFORCE the approval contract, not merely document it. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-runs-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";

/* eslint-disable @typescript-eslint/no-require-imports */
// require, not top-level await: the env vars above must be set before the db module initialises,
// and the test runner transforms to CJS where top-level await is unavailable.
const {
  createRun,
  advanceRun,
  getRun,
  listWaitingRuns,
  listEvents,
  IllegalTransitionError,
} = require("../queries/applicationRuns") as typeof import("../queries/applicationRuns");

function newRun() {
  return createRun({ candidateId: 1, jobId: 42, dedupeKey: `k-${Math.round(performance.now() * 1000)}`, ats: "greenhouse" });
}

test("RUNDB-1 a run starts queued and records its creation", () => {
  const run = newRun();
  assert.equal(run.status, "QUEUED");
  assert.ok(listEvents(run.id).some((e) => e.event_type === "run_created"));
});

test("RUNDB-2 an illegal transition is refused", () => {
  const run = newRun();
  assert.throws(() => advanceRun(run.id, "SUBMITTED"), IllegalTransitionError);
  assert.equal(getRun(run.id)!.status, "QUEUED", "a refused transition must not change state");
});

test("RUNDB-3 submission without an approval is refused", () => {
  const run = newRun();
  advanceRun(run.id, "STARTING");
  advanceRun(run.id, "NAVIGATING");
  advanceRun(run.id, "FILLING");
  advanceRun(run.id, "READY_FOR_REVIEW");
  advanceRun(run.id, "WAITING_FOR_SUBMIT_APPROVAL");
  assert.throws(() => advanceRun(run.id, "SUBMITTING"), /explicit approval/i);
  assert.equal(getRun(run.id)!.status, "WAITING_FOR_SUBMIT_APPROVAL");
});

test("RUNDB-4 an approval from ANOTHER run cannot submit this one", () => {
  const a = newRun();
  const b = newRun();
  for (const r of [a, b]) {
    advanceRun(r.id, "STARTING");
    advanceRun(r.id, "NAVIGATING");
    advanceRun(r.id, "FILLING");
    advanceRun(r.id, "READY_FOR_REVIEW");
    advanceRun(r.id, "WAITING_FOR_SUBMIT_APPROVAL");
  }
  assert.throws(
    () => advanceRun(b.id, "SUBMITTING", { submitApproval: { runId: a.id } }),
    /explicit approval/i,
    "approval is per application — reusing one job's approval for another must be impossible"
  );
});

test("RUNDB-5 an approval for this run submits, and the timestamp is recorded", () => {
  const run = newRun();
  advanceRun(run.id, "STARTING");
  advanceRun(run.id, "NAVIGATING");
  advanceRun(run.id, "FILLING");
  advanceRun(run.id, "READY_FOR_REVIEW");
  advanceRun(run.id, "WAITING_FOR_SUBMIT_APPROVAL");
  const submitting = advanceRun(run.id, "SUBMITTING", { submitApproval: { runId: run.id } });
  assert.equal(submitting.status, "SUBMITTING");
  assert.ok(submitting.submit_approved_at, "the approval moment is recorded");

  const done = advanceRun(run.id, "SUBMITTED", { confirmationText: "Application received" });
  assert.ok(done.submitted_at);
  assert.equal(done.confirmation_text, "Application received");
});

test("RUNDB-6 waiting runs surface for the inbox, terminal ones do not", () => {
  const waiting = newRun();
  advanceRun(waiting.id, "STARTING");
  advanceRun(waiting.id, "NAVIGATING");
  advanceRun(waiting.id, "FILLING");
  advanceRun(waiting.id, "WAITING_FOR_ANSWER", { blockingQuestion: "What is your desired base salary?" });

  const inbox = listWaitingRuns(1);
  const found = inbox.find((r) => r.id === waiting.id);
  assert.ok(found, "a run waiting on the user must appear in the inbox");
  assert.equal(found!.blocking_question, "What is your desired base salary?");

  const cancelled = newRun();
  advanceRun(cancelled.id, "CANCELLED");
  assert.ok(!listWaitingRuns(1).some((r) => r.id === cancelled.id), "a cancelled run is not waiting on anyone");
});

test("RUNDB-7 a checkpoint survives, so a restart does not lose the run", () => {
  const run = newRun();
  advanceRun(run.id, "STARTING");
  advanceRun(run.id, "NAVIGATING", { checkpoint: { url: "https://example.test/apply", step: 2, filled: ["email"] } });
  const stored = JSON.parse(getRun(run.id)!.checkpoint_json!);
  assert.equal(stored.step, 2);
  assert.deepEqual(stored.filled, ["email"]);
});

test("RUNDB-8 no password or verification code is ever written to run storage", () => {
  const run = newRun();
  advanceRun(run.id, "STARTING");
  advanceRun(run.id, "NAVIGATING");
  advanceRun(run.id, "ACCOUNT_REQUIRED", { blockingReason: "This site needs an account before you can apply." });
  const row = JSON.stringify(getRun(run.id)) + JSON.stringify(listEvents(run.id));
  assert.doesNotMatch(row, /password|passwd|otp|verification_code|secret/i);
});
