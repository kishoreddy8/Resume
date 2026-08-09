import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let getDb: typeof import("../../index").getDb;
let insertMatchRun: typeof import("../matchRuns").insertMatchRun;
let listMatchRuns: typeof import("../matchRuns").listMatchRuns;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-match-runs-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
  ({ insertMatchRun, listMatchRuns } = await import("../matchRuns"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("insertMatchRun writes and returns a full row, attributed to a candidate", () => {
  const run = insertMatchRun({
    candidateId: 1,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:05Z",
    jobsEvaluated: 10,
    jobsBlocked: 2,
    jobsNeedsReview: 5,
    jobsReady: 3,
    jobsErrored: 0,
  });
  assert.ok(run.id > 0);
  assert.equal(run.candidate_id, 1);
  assert.equal(run.jobs_evaluated, 10);
  assert.equal(run.error_summary, null);
});

test("listMatchRuns returns most-recent-first", () => {
  insertMatchRun({ candidateId: 1, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", jobsEvaluated: 1, jobsBlocked: 0, jobsNeedsReview: 1, jobsReady: 0, jobsErrored: 0 });
  insertMatchRun({ candidateId: 1, startedAt: "2026-01-02T00:00:00Z", finishedAt: "2026-01-02T00:00:01Z", jobsEvaluated: 1, jobsBlocked: 0, jobsNeedsReview: 0, jobsReady: 1, jobsErrored: 0 });
  const runs = listMatchRuns(undefined, 10);
  assert.ok(runs.length >= 2);
  assert.ok(new Date(runs[0].started_at) >= new Date(runs[1].started_at));
});

test("listMatchRuns(candidateId) filters to just that candidate's batch runs", () => {
  insertMatchRun({ candidateId: 2, startedAt: "2026-01-05T00:00:00Z", finishedAt: "2026-01-05T00:00:01Z", jobsEvaluated: 1, jobsBlocked: 0, jobsNeedsReview: 1, jobsReady: 0, jobsErrored: 0 });
  const candidateTwoRuns = listMatchRuns(2, 10);
  assert.ok(candidateTwoRuns.every((r) => r.candidate_id === 2));
});

test("a failed batch attempt records an error summary without losing the successfully-evaluated count", () => {
  const run = insertMatchRun({
    candidateId: 1,
    startedAt: "2026-01-03T00:00:00Z",
    finishedAt: "2026-01-03T00:00:02Z",
    jobsEvaluated: 4,
    jobsBlocked: 0,
    jobsNeedsReview: 3,
    jobsReady: 0,
    jobsErrored: 1,
    errorSummary: "job 42: unexpected error during matching",
  });
  assert.equal(run.jobs_errored, 1);
  assert.equal(run.jobs_evaluated, 4, "one bad job must not zero out the others' results — failure isolation");
  assert.match(run.error_summary ?? "", /job 42/);
});
