import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Application safety hardening tests.
 *
 * HARD-01 to HARD-15: Duplicate run protection.
 * HARD-16 to HARD-23: SUBMITTED → Applied pipeline lifecycle sync.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-hardening-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";

/* eslint-disable @typescript-eslint/no-require-imports */
// require, not import: env vars must be set before the db module initialises.
const {
  createRun,
  advanceRun,
  getExistingProtectedRun,
  RETRYABLE_STATUSES,
} = require("../queries/applicationRuns") as typeof import("../queries/applicationRuns");

const { getCandidateJobState } = require("../queries/candidateJobState") as typeof import("../queries/candidateJobState");

let keySeq = 0;
function key(prefix = "dk") {
  return `${prefix}-${++keySeq}-${Math.round(performance.now() * 1000)}`;
}

function newRunForKey(dedupeKey: string) {
  return createRun({ candidateId: 1, jobId: 99, dedupeKey, ats: "greenhouse" });
}

/** Walk a run all the way to WAITING_FOR_SUBMIT_APPROVAL. */
function toReviewApproval(run: { id: number }) {
  advanceRun(run.id, "STARTING");
  advanceRun(run.id, "NAVIGATING");
  advanceRun(run.id, "FILLING");
  advanceRun(run.id, "READY_FOR_REVIEW");
  advanceRun(run.id, "WAITING_FOR_SUBMIT_APPROVAL");
}

/** Walk all the way to SUBMITTED. */
function toSubmitted(run: { id: number }) {
  toReviewApproval(run);
  advanceRun(run.id, "SUBMITTING", { submitApproval: { runId: run.id } });
  advanceRun(run.id, "SUBMITTED", { confirmationText: "Application received." });
}

// ─── HARD-01: RETRYABLE_STATUSES only contains FAILED and CANCELLED ─────────
test("HARD-01 RETRYABLE_STATUSES is exactly FAILED and CANCELLED", () => {
  assert.deepEqual(
    [...RETRYABLE_STATUSES].sort(),
    ["CANCELLED", "FAILED"],
    "Only FAILED and CANCELLED may be retried — all other statuses are protected"
  );
});

// ─── HARD-02: no run → getExistingProtectedRun returns undefined ─────────────
test("HARD-02 getExistingProtectedRun returns undefined when no run exists", () => {
  assert.equal(getExistingProtectedRun(1, key("no-run")), undefined);
});

// ─── HARD-03: QUEUED run is protected ────────────────────────────────────────
test("HARD-03 a QUEUED run is protected", () => {
  const dk = key("queued");
  newRunForKey(dk);
  const found = getExistingProtectedRun(1, dk);
  assert.ok(found, "QUEUED is protected — the run already exists");
  assert.equal(found!.status, "QUEUED");
});

// ─── HARD-04: STARTING run is protected ──────────────────────────────────────
test("HARD-04 a STARTING run is protected", () => {
  const dk = key("starting");
  const run = newRunForKey(dk);
  advanceRun(run.id, "STARTING");
  assert.equal(getExistingProtectedRun(1, dk)?.status, "STARTING");
});

// ─── HARD-05: FILLING run is protected ───────────────────────────────────────
test("HARD-05 a FILLING run is protected", () => {
  const dk = key("filling");
  const run = newRunForKey(dk);
  advanceRun(run.id, "STARTING");
  advanceRun(run.id, "NAVIGATING");
  advanceRun(run.id, "FILLING");
  assert.equal(getExistingProtectedRun(1, dk)?.status, "FILLING");
});

// ─── HARD-06: WAITING_FOR_ANSWER run is protected ───────────────────────────
test("HARD-06 a WAITING_FOR_ANSWER run is protected", () => {
  const dk = key("wfa");
  const run = newRunForKey(dk);
  advanceRun(run.id, "STARTING");
  advanceRun(run.id, "NAVIGATING");
  advanceRun(run.id, "FILLING");
  advanceRun(run.id, "WAITING_FOR_ANSWER", { blockingQuestion: "expected salary?" });
  assert.equal(getExistingProtectedRun(1, dk)?.status, "WAITING_FOR_ANSWER");
});

// ─── HARD-07: WAITING_FOR_SUBMIT_APPROVAL run is protected ──────────────────
test("HARD-07 a WAITING_FOR_SUBMIT_APPROVAL run is protected", () => {
  const dk = key("wfsa");
  const run = newRunForKey(dk);
  toReviewApproval(run);
  assert.equal(getExistingProtectedRun(1, dk)?.status, "WAITING_FOR_SUBMIT_APPROVAL");
});

// ─── HARD-08: SUBMITTED run is protected ────────────────────────────────────
test("HARD-08 a SUBMITTED run is protected", () => {
  const dk = key("submitted-dup");
  const run = newRunForKey(dk);
  toSubmitted(run);
  const found = getExistingProtectedRun(1, dk);
  assert.ok(found, "SUBMITTED is protected — job was already applied to");
  assert.equal(found!.status, "SUBMITTED");
});

// ─── HARD-09: SUBMISSION_UNCONFIRMED run is protected ───────────────────────
test("HARD-09 a SUBMISSION_UNCONFIRMED run is protected", () => {
  const dk = key("unconfirmed");
  const run = newRunForKey(dk);
  toReviewApproval(run);
  advanceRun(run.id, "SUBMITTING", { submitApproval: { runId: run.id } });
  advanceRun(run.id, "SUBMISSION_UNCONFIRMED");
  assert.equal(getExistingProtectedRun(1, dk)?.status, "SUBMISSION_UNCONFIRMED");
});

// ─── HARD-10: FAILED run is retryable ────────────────────────────────────────
test("HARD-10 a FAILED run is retryable — getExistingProtectedRun returns undefined", () => {
  const dk = key("failed");
  const run = newRunForKey(dk);
  advanceRun(run.id, "FAILED");
  assert.equal(
    getExistingProtectedRun(1, dk),
    undefined,
    "FAILED is retryable — a new run is allowed"
  );
});

// ─── HARD-11: CANCELLED run is retryable ────────────────────────────────────
test("HARD-11 a CANCELLED run is retryable — getExistingProtectedRun returns undefined", () => {
  const dk = key("cancelled");
  const run = newRunForKey(dk);
  advanceRun(run.id, "CANCELLED");
  assert.equal(
    getExistingProtectedRun(1, dk),
    undefined,
    "CANCELLED is retryable — a new run is allowed"
  );
});

// ─── HARD-12: different candidate same key → not a conflict ─────────────────
test("HARD-12 a protected run for candidate A does not block candidate B", () => {
  const dk = key("cross-cand");
  // Candidate 1 has an active run
  newRunForKey(dk); // status = QUEUED
  // getExistingProtectedRun for candidateId=2 should see nothing
  assert.equal(
    getExistingProtectedRun(2, dk),
    undefined,
    "Isolation by candidate_id — candidate 2 is not blocked by candidate 1's run"
  );
});

// ─── HARD-13: DB partial index prevents duplicate insert ────────────────────
test("HARD-13 the DB partial unique index refuses a second protected insert", () => {
  const dk = key("db-index");
  newRunForKey(dk); // QUEUED — now protected
  // A second createRun with the same (candidateId=1, dedupeKey) must throw because the partial
  // unique index covers QUEUED (NOT IN 'FAILED','CANCELLED').
  assert.throws(
    () => newRunForKey(dk),
    /unique|constraint/i,
    "DB partial index must reject the duplicate insert"
  );
});

// ─── HARD-14: after FAILED, a new protected run is accepted ─────────────────
test("HARD-14 a new run is accepted after the previous one FAILed", () => {
  const dk = key("retry-after-fail");
  const first = newRunForKey(dk);
  advanceRun(first.id, "FAILED");
  // Now FAILED → outside the partial index → second run is legal
  const second = newRunForKey(dk);
  assert.notEqual(second.id, first.id, "A distinct run was created");
  assert.equal(second.status, "QUEUED");
});

// ─── HARD-15: after CANCELLED, a new protected run is accepted ───────────────
test("HARD-15 a new run is accepted after the previous one was CANCELLED", () => {
  const dk = key("retry-after-cancel");
  const first = newRunForKey(dk);
  advanceRun(first.id, "CANCELLED");
  const second = newRunForKey(dk);
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, "QUEUED");
});

// ─── HARD-16: SUBMITTED sets pipeline_status = Applied ──────────────────────
test("HARD-16 SUBMITTED transition sets candidate pipeline_status to Applied", () => {
  const dk = key("submit-applied");
  const run = newRunForKey(dk);
  toSubmitted(run);
  const state = getCandidateJobState(1, dk);
  assert.ok(state, "candidate_job_state row must exist");
  assert.equal(state!.pipeline_status, "Applied");
});

// ─── HARD-17: Applied is idempotent ─────────────────────────────────────────
test("HARD-17 SUBMISSION_UNCONFIRMED → SUBMITTED sets Applied without error (idempotent path)", () => {
  // SUBMISSION_UNCONFIRMED → SUBMITTED is a legal second transition
  const dk = key("idempotent-applied");
  const run = newRunForKey(dk);
  toReviewApproval(run);
  advanceRun(run.id, "SUBMITTING", { submitApproval: { runId: run.id } });
  advanceRun(run.id, "SUBMISSION_UNCONFIRMED");
  // Now advance from SUBMISSION_UNCONFIRMED → SUBMITTED (legal per transition table)
  advanceRun(run.id, "SUBMITTED", { confirmationText: "Received again." });
  const state = getCandidateJobState(1, dk);
  assert.equal(state!.pipeline_status, "Applied");
});

// ─── HARD-18: SUBMISSION_UNCONFIRMED does NOT set Applied ───────────────────
test("HARD-18 SUBMISSION_UNCONFIRMED does NOT set pipeline_status to Applied", () => {
  const dk = key("unconfirmed-no-applied");
  const run = newRunForKey(dk);
  toReviewApproval(run);
  advanceRun(run.id, "SUBMITTING", { submitApproval: { runId: run.id } });
  advanceRun(run.id, "SUBMISSION_UNCONFIRMED");
  const state = getCandidateJobState(1, dk);
  // If no candidate_job_state row exists, the default is "New" (not Applied) — correct.
  assert.notEqual(state?.pipeline_status ?? "New", "Applied");
});

// ─── HARD-19: FAILED does NOT set Applied ───────────────────────────────────
test("HARD-19 FAILED does NOT set pipeline_status to Applied", () => {
  const dk = key("failed-no-applied");
  const run = newRunForKey(dk);
  advanceRun(run.id, "FAILED");
  const state = getCandidateJobState(1, dk);
  assert.notEqual(state?.pipeline_status ?? "New", "Applied");
});

// ─── HARD-20: CANCELLED does NOT set Applied ────────────────────────────────
test("HARD-20 CANCELLED does NOT set pipeline_status to Applied", () => {
  const dk = key("cancelled-no-applied");
  const run = newRunForKey(dk);
  advanceRun(run.id, "CANCELLED");
  const state = getCandidateJobState(1, dk);
  assert.notEqual(state?.pipeline_status ?? "New", "Applied");
});

// ─── HARD-21: SUBMITTING does NOT set Applied ───────────────────────────────
test("HARD-21 SUBMITTING does NOT set pipeline_status to Applied", () => {
  const dk = key("submitting-no-applied");
  const run = newRunForKey(dk);
  toReviewApproval(run);
  advanceRun(run.id, "SUBMITTING", { submitApproval: { runId: run.id } });
  const state = getCandidateJobState(1, dk);
  assert.notEqual(state?.pipeline_status ?? "New", "Applied");
});

// ─── HARD-22: READY_FOR_REVIEW does NOT set Applied ─────────────────────────
test("HARD-22 READY_FOR_REVIEW does NOT set pipeline_status to Applied", () => {
  const dk = key("rfr-no-applied");
  const run = newRunForKey(dk);
  advanceRun(run.id, "STARTING");
  advanceRun(run.id, "NAVIGATING");
  advanceRun(run.id, "FILLING");
  advanceRun(run.id, "READY_FOR_REVIEW");
  const state = getCandidateJobState(1, dk);
  assert.notEqual(state?.pipeline_status ?? "New", "Applied");
});

// ─── HARD-23: Applied is scoped to candidate — other candidates unaffected ──
test("HARD-23 SUBMITTED sets Applied only for the submitting candidate, not others", () => {
  const dk = key("applied-scoped");
  // Candidate 1 submits
  const run = newRunForKey(dk); // candidateId: 1
  toSubmitted(run);
  assert.equal(getCandidateJobState(1, dk)?.pipeline_status, "Applied");
  // Candidate 2 has no relationship to this dedupe_key
  assert.equal(getCandidateJobState(2, dk), undefined, "Candidate 2 must not have an Applied state");
});
