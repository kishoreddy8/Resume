import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let getCandidateJobState: typeof import("../candidateJobState").getCandidateJobState;
let setPipelineStatus: typeof import("../candidateJobState").setPipelineStatus;
let setPinned: typeof import("../candidateJobState").setPinned;
let setNotInterested: typeof import("../candidateJobState").setNotInterested;
let setNotesAndTags: typeof import("../candidateJobState").setNotesAndTags;
let setMarkedForTailoring: typeof import("../candidateJobState").setMarkedForTailoring;
let listCandidateJobStateHistory: typeof import("../candidateJobState").listCandidateJobStateHistory;
let isProtectedForAnyCandidate: typeof import("../candidateJobState").isProtectedForAnyCandidate;
let createCandidate: typeof import("../candidates").createCandidate;
let candidateBId: number;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-candidate-job-state-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({
    getCandidateJobState,
    setPipelineStatus,
    setPinned,
    setNotInterested,
    setNotesAndTags,
    setMarkedForTailoring,
    listCandidateJobStateHistory,
    isProtectedForAnyCandidate,
  } = await import("../candidateJobState"));
  ({ createCandidate } = await import("../candidates"));
  const { getDb } = await import("../../index");
  getDb();
  candidateBId = createCandidate({ firstName: "Candidate", lastName: "B" }).id;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("a job with no candidate_job_state row has no relationship at all — absence, not a fabricated default row", () => {
  assert.equal(getCandidateJobState(1, "greenhouse:1:never-touched"), undefined);
});

test("setPipelineStatus creates a row on first write and updates it on subsequent writes, recording history", () => {
  const dedupeKey = "greenhouse:1:pipeline-test";
  const row = setPipelineStatus(1, dedupeKey, "Applied");
  assert.equal(row.pipeline_status, "Applied");
  assert.ok(row.pipeline_updated_at);

  setPipelineStatus(1, dedupeKey, "Interviewing");
  const updated = getCandidateJobState(1, dedupeKey)!;
  assert.equal(updated.pipeline_status, "Interviewing");

  const history = listCandidateJobStateHistory(1, dedupeKey) as { change_type: string; old_value: string; new_value: string }[];
  assert.equal(history.length, 2);
  assert.equal(history[0].change_type, "pipeline_status");
  assert.equal(history[0].new_value, "Interviewing");
});

test("Candidate A marking Not Interested does not affect Candidate B's view of the same job", () => {
  const dedupeKey = "ashby:1:shared-job";
  setNotInterested(1, dedupeKey, true, "Not a fit");

  const forA = getCandidateJobState(1, dedupeKey)!;
  assert.equal(forA.not_interested, 1);

  const forB = getCandidateJobState(candidateBId, dedupeKey);
  assert.equal(forB, undefined, "Candidate B has no relationship to this job at all — completely unaffected by A's action");
});

test("Candidate A = Applied, Candidate B = default/no-row for the exact same job — fully isolated", () => {
  const dedupeKey = "workday:2:isolation-test";
  setPipelineStatus(1, dedupeKey, "Applied");
  setNotesAndTags(1, dedupeKey, "Recruiter called", ["priority"]);

  const forA = getCandidateJobState(1, dedupeKey)!;
  assert.equal(forA.pipeline_status, "Applied");
  assert.equal(forA.notes, "Recruiter called");

  const forB = getCandidateJobState(candidateBId, dedupeKey);
  assert.equal(forB, undefined);
});

test("isProtectedForAnyCandidate: true if ANY candidate has the job Applied/Interviewing/Offer/Employer Rejected or pinned", () => {
  const dedupeKey = "greenhouse:1:protection-test";
  assert.equal(isProtectedForAnyCandidate(dedupeKey), false);

  setPipelineStatus(candidateBId, dedupeKey, "Applied");
  assert.equal(isProtectedForAnyCandidate(dedupeKey), true, "Candidate B alone having it Applied must protect the shared job");
});

test("isProtectedForAnyCandidate: pinned by one candidate protects the job even if another candidate has default state", () => {
  const dedupeKey = "greenhouse:1:pin-protection-test";
  assert.equal(isProtectedForAnyCandidate(dedupeKey), false);
  setPinned(1, dedupeKey, true);
  assert.equal(isProtectedForAnyCandidate(dedupeKey), true);
});

test("isProtectedForAnyCandidate: an ordinary 'New'/'Interested' status for every candidate does NOT protect the job", () => {
  const dedupeKey = "greenhouse:1:unprotected-test";
  setPipelineStatus(1, dedupeKey, "Interested");
  setPipelineStatus(candidateBId, dedupeKey, "New");
  assert.equal(isProtectedForAnyCandidate(dedupeKey), false);
});

// --- Phase 3 V1: tailoring approval provenance ----------------------------------------------

test("existing behavior is unchanged: setMarkedForTailoring(marked=true) with NO approval context still marks the job, leaving approval fields null (backward compatible with the pre-Phase-3 PATCH route)", () => {
  const dedupeKey = "greenhouse:1:tailoring-no-approval";
  const row = setMarkedForTailoring(1, dedupeKey, true);
  assert.equal(row.marked_for_tailoring, 1);
  assert.ok(row.tailoring_marked_at);
  assert.equal(row.tailoring_approval_type, null, "never inferred/guessed when omitted");
  assert.equal(row.tailoring_approved_decision, null, "never inferred/guessed when omitted");
});

test("READY_DIRECT approval is stored correctly", () => {
  const dedupeKey = "greenhouse:1:tailoring-ready-direct";
  const row = setMarkedForTailoring(1, dedupeKey, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  assert.equal(row.marked_for_tailoring, 1);
  assert.equal(row.tailoring_approval_type, "READY_DIRECT");
  assert.equal(row.tailoring_approved_decision, "READY_FOR_TAILORING");
});

test("NEEDS_REVIEW_OVERRIDE approval is stored correctly, distinguishable from READY_DIRECT", () => {
  const dedupeKey = "greenhouse:1:tailoring-needs-review-override";
  const row = setMarkedForTailoring(1, dedupeKey, true, { approvalType: "NEEDS_REVIEW_OVERRIDE", decision: "NEEDS_REVIEW" });
  assert.equal(row.tailoring_approval_type, "NEEDS_REVIEW_OVERRIDE");
  assert.equal(row.tailoring_approved_decision, "NEEDS_REVIEW");
  assert.notEqual(row.tailoring_approval_type, "READY_DIRECT");
});

test("unmarking (marked=false) clears both approval fields, even if they were previously set", () => {
  const dedupeKey = "greenhouse:1:tailoring-unmark-clears";
  setMarkedForTailoring(1, dedupeKey, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  const unmarked = setMarkedForTailoring(1, dedupeKey, false);
  assert.equal(unmarked.marked_for_tailoring, 0);
  assert.equal(unmarked.tailoring_approval_type, null);
  assert.equal(unmarked.tailoring_approved_decision, null);
});

test("re-approving after an unmark records the NEW approval context, not the old one", () => {
  const dedupeKey = "greenhouse:1:tailoring-reapprove";
  setMarkedForTailoring(1, dedupeKey, true, { approvalType: "NEEDS_REVIEW_OVERRIDE", decision: "NEEDS_REVIEW" });
  setMarkedForTailoring(1, dedupeKey, false);
  const reapproved = setMarkedForTailoring(1, dedupeKey, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  assert.equal(reapproved.tailoring_approval_type, "READY_DIRECT");
  assert.equal(reapproved.tailoring_approved_decision, "READY_FOR_TAILORING");
});
