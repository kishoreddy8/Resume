import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let createTailoringRun: typeof import("../tailoringRuns").createTailoringRun;
let getTailoringRun: typeof import("../tailoringRuns").getTailoringRun;
let listTailoringRuns: typeof import("../tailoringRuns").listTailoringRuns;
let completeTailoringRun: typeof import("../tailoringRuns").completeTailoringRun;
let failTailoringRun: typeof import("../tailoringRuns").failTailoringRun;
let TailoringRunNotStartedError: typeof import("../tailoringRuns").TailoringRunNotStartedError;
let createCandidate: typeof import("../candidates").createCandidate;
let getLatestJobMatchResult: typeof import("../jobMatches").getLatestJobMatchResult;
let candidateBId: number;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-tailoring-runs-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ createTailoringRun, getTailoringRun, listTailoringRuns, completeTailoringRun, failTailoringRun, TailoringRunNotStartedError } =
    await import("../tailoringRuns"));
  ({ createCandidate } = await import("../candidates"));
  ({ getLatestJobMatchResult } = await import("../jobMatches"));
  const { getDb } = await import("../../index");
  getDb();
  candidateBId = createCandidate({ firstName: "Candidate", lastName: "B" }).id;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseInput(overrides: Partial<Parameters<typeof createTailoringRun>[0]> = {}) {
  return {
    candidateId: 1,
    dedupeKey: "greenhouse:1:tailoring-test",
    jobId: 42,
    approvalType: "READY_DIRECT" as const,
    decisionAtApproval: "READY_FOR_TAILORING",
    approvedAt: new Date().toISOString(),
    masterResumeHash: "resume-hash-abc",
    masterSkillsHash: "skills-hash-def",
    candidateProfileHash: "resume-hash-abc:skills-hash-def",
    jdContentHash: "jd-hash-xyz",
    matchEngineVersion: 2,
    recommendedTrack: "Data Engineer",
    methodologyVersion: 1,
    rendererVersion: 1,
    ...overrides,
  };
}

test("1. create started run", () => {
  const run = createTailoringRun(baseInput());
  assert.equal(run.status, "started");
  assert.equal(run.candidate_id, 1);
  assert.equal(run.dedupe_key, "greenhouse:1:tailoring-test");
  assert.equal(run.job_id, 42);
  assert.equal(run.approval_type, "READY_DIRECT");
  assert.equal(run.decision_at_approval, "READY_FOR_TAILORING");
  assert.equal(run.output_files, null);
  assert.equal(run.validation_passed, null);
  assert.equal(run.completed_at, null);
  assert.ok(run.id > 0);
});

test("2. started -> completed", () => {
  const run = createTailoringRun(baseInput({ dedupeKey: "greenhouse:1:started-to-completed" }));
  const completed = completeTailoringRun(1, run.id, {
    outputFiles: ["Resume.docx", "CoverLetter.docx", "ATS_Report.md", "Recruiter_Report.md", "ColdFollowupEmail.md"],
    validationPassed: true,
    jobFitClassification: "STRONG APPLY",
    selectedTrack: "Data Engineer",
    executedBy: "claude-code",
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(JSON.parse(completed.output_files!), ["Resume.docx", "CoverLetter.docx", "ATS_Report.md", "Recruiter_Report.md", "ColdFollowupEmail.md"]);
  assert.equal(completed.validation_passed, 1);
  assert.equal(completed.job_fit_classification, "STRONG APPLY");
  assert.equal(completed.selected_track, "Data Engineer");
  assert.equal(completed.executed_by, "claude-code");
  assert.ok(completed.completed_at);
});

test("3. started -> failed", () => {
  const run = createTailoringRun(baseInput({ dedupeKey: "greenhouse:1:started-to-failed" }));
  const failed = failTailoringRun(1, run.id, "Master Resume manifest missing sha256 for skills slot");
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure_reason, "Master Resume manifest missing sha256 for skills slot");
  assert.ok(failed.completed_at, "a failed run must still be recorded, never left 'started' forever");
});

test("4. a completed run is immutable — cannot be completed or failed again", () => {
  const run = createTailoringRun(baseInput({ dedupeKey: "greenhouse:1:immutable-completed" }));
  completeTailoringRun(1, run.id, { outputFiles: ["Resume.docx"], validationPassed: true });
  assert.throws(
    () => completeTailoringRun(1, run.id, { outputFiles: ["Resume.docx"], validationPassed: true }),
    (err: unknown) => err instanceof TailoringRunNotStartedError
  );
  assert.throws(
    () => failTailoringRun(1, run.id, "should never apply"),
    (err: unknown) => err instanceof TailoringRunNotStartedError
  );
});

test("4b. a failed run is also immutable — cannot be completed or failed again", () => {
  const run = createTailoringRun(baseInput({ dedupeKey: "greenhouse:1:immutable-failed" }));
  failTailoringRun(1, run.id, "engine validation failed");
  assert.throws(
    () => completeTailoringRun(1, run.id, { outputFiles: ["Resume.docx"], validationPassed: true }),
    (err: unknown) => err instanceof TailoringRunNotStartedError
  );
  assert.throws(
    () => failTailoringRun(1, run.id, "second failure"),
    (err: unknown) => err instanceof TailoringRunNotStartedError
  );
});

test("5. candidate A cannot retrieve candidate B's run", () => {
  const run = createTailoringRun(baseInput({ candidateId: 1, dedupeKey: "greenhouse:1:isolation-test" }));
  assert.ok(getTailoringRun(1, run.id));
  assert.equal(getTailoringRun(candidateBId, run.id), undefined, "the run belongs to candidate 1, must be invisible to candidate B by id");
});

test("6. the same job (dedupe_key) may have independent runs for different candidates", () => {
  const dedupeKey = "greenhouse:1:shared-job-independent-runs";
  const runA = createTailoringRun(baseInput({ candidateId: 1, dedupeKey }));
  const runB = createTailoringRun(baseInput({ candidateId: candidateBId, dedupeKey, approvalType: "NEEDS_REVIEW_OVERRIDE", decisionAtApproval: "NEEDS_REVIEW" }));

  completeTailoringRun(1, runA.id, { outputFiles: ["A_Resume.docx"], validationPassed: true });
  failTailoringRun(candidateBId, runB.id, "B's run failed independently");

  const aRun = getTailoringRun(1, runA.id)!;
  const bRun = getTailoringRun(candidateBId, runB.id)!;
  assert.equal(aRun.status, "completed");
  assert.equal(bRun.status, "failed", "candidate B's run outcome must be fully independent of candidate A's");

  const historyForA = listTailoringRuns(1, dedupeKey);
  const historyForB = listTailoringRuns(candidateBId, dedupeKey);
  assert.equal(historyForA.length, 1);
  assert.equal(historyForB.length, 1);
  assert.equal(historyForA[0].id, runA.id);
  assert.equal(historyForB[0].id, runB.id);
});

test("7. multiple runs for the same candidate/job are all preserved (run 2 does not overwrite run 1)", () => {
  const dedupeKey = "greenhouse:1:multiple-runs-preserved";
  const run1 = createTailoringRun(baseInput({ dedupeKey }));
  completeTailoringRun(1, run1.id, { outputFiles: ["Resume_v1.docx"], validationPassed: true });

  const run2 = createTailoringRun(baseInput({ dedupeKey }));
  completeTailoringRun(1, run2.id, { outputFiles: ["Resume_v2.docx"], validationPassed: true });

  assert.notEqual(run1.id, run2.id);
  const stillRun1 = getTailoringRun(1, run1.id)!;
  assert.deepEqual(JSON.parse(stillRun1.output_files!), ["Resume_v1.docx"], "run 1's outcome must be untouched by run 2's creation/completion");

  const history = listTailoringRuns(1, dedupeKey);
  assert.equal(history.length, 2, "both runs must exist independently");
});

test("8. history ordering — newest run first", () => {
  const dedupeKey = "greenhouse:1:history-ordering";
  const first = createTailoringRun(baseInput({ dedupeKey }));
  const second = createTailoringRun(baseInput({ dedupeKey }));
  const third = createTailoringRun(baseInput({ dedupeKey }));
  const history = listTailoringRuns(1, dedupeKey);
  assert.deepEqual(history.map((r) => r.id), [third.id, second.id, first.id]);
});

test("12. creating and completing a tailoring run never writes to job_match_results — Phase 2 stays authoritative", () => {
  const dedupeKey = "greenhouse:1:phase2-untouched";
  const before = getLatestJobMatchResult(1, dedupeKey);
  const run = createTailoringRun(baseInput({ dedupeKey }));
  completeTailoringRun(1, run.id, { outputFiles: ["Resume.docx"], validationPassed: true });
  failTailoringRun(1, createTailoringRun(baseInput({ dedupeKey })).id, "irrelevant");
  const after = getLatestJobMatchResult(1, dedupeKey);
  assert.equal(before, undefined, "no job_match_results row existed before (sanity check on the fixture)");
  assert.equal(after, undefined, "the tailoring_runs table must never create, modify, or reference a job_match_results row");
});

test("completing a run with no prior existing run for that candidate throws TailoringRunNotFoundError-shaped error, not a silent no-op", () => {
  assert.throws(() => completeTailoringRun(1, 999999, { outputFiles: [], validationPassed: true }));
});
