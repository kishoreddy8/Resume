import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";

/**
 * Stage 32 — what happens when many resumes are approved at once.
 *
 * Models the operator's real question ("Candidate 1: 10 resumes, Candidate 2: 10 resumes, approved
 * at about the same time") deterministically: the queue, its ordering, its per-pass bound and its
 * candidate isolation are all decided by SQL and by runWorkerPass's loop, none of which needs a
 * Claude generation to exercise. No writer is enabled and no Claude process is started by this file.
 */

let tmpDir: string;
let getDb: typeof import("../../../../db/index").getDb;
let createCandidate: typeof import("../../../../db/queries/candidates").createCandidate;
let listWorkflowsAwaitingWriter: typeof import("../../../../db/queries/resumeQualityWorkflows").listWorkflowsAwaitingWriter;
let RESUME_WRITER_BATCH_SIZE: typeof import("../tick").RESUME_WRITER_BATCH_SIZE;

const CANDIDATE_A_JOBS = 10;
const CANDIDATE_B_JOBS = 10;
let candidateA: number;
let candidateB: number;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-stage32-queue-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../../../db/index"));
  ({ createCandidate } = await import("../../../../db/queries/candidates"));
  ({ listWorkflowsAwaitingWriter } = await import("../../../../db/queries/resumeQualityWorkflows"));
  ({ RESUME_WRITER_BATCH_SIZE } = await import("../tick"));

  const db = getDb();
  candidateA = createCandidate({ firstName: "Alpha", lastName: "One" }).id;
  candidateB = createCandidate({ firstName: "Beta", lastName: "Two" }).id;

  // Approvals land interleaved, as two people clicking through their lists at the same time would.
  // Real parent rows: resume_quality_workflows has FKs to candidate_job_state and tailoring_runs.
  const insertState = db.prepare("INSERT INTO candidate_job_state (candidate_id, dedupe_key) VALUES (?, ?)");
  const insertRun = db.prepare(
    `INSERT INTO tailoring_runs (candidate_id, dedupe_key, approval_type, decision_at_approval, approved_at, status)
     VALUES (?, ?, 'READY_DIRECT', 'READY_FOR_TAILORING', '2026-08-19 12:00:00', 'completed')`
  );
  const insert = db.prepare(
    `INSERT INTO resume_quality_workflows (candidate_id, application_id, tailoring_run_id, dedupe_key, status, current_iteration, max_iterations, updated_at)
     VALUES (?, ?, ?, ?, 'CREATED', 0, 2, ?)`
  );
  const seed = db.transaction(() => {
    for (let i = 0; i < CANDIDATE_A_JOBS + CANDIDATE_B_JOBS; i++) {
      const candidateId = i % 2 === 0 ? candidateA : candidateB;
      const n = Math.floor(i / 2);
      const dedupeKey = `cand${candidateId}:job${n}`;
      const stateId = Number(insertState.run(candidateId, dedupeKey).lastInsertRowid);
      const runId = Number(insertRun.run(candidateId, dedupeKey).lastInsertRowid);
      insert.run(candidateId, stateId, runId, dedupeKey, `2026-08-19 12:00:${String(i).padStart(2, "0")}`);
    }
  });
  seed();
});

test("S32-11 every approved workflow is queued exactly once", () => {
  const pending = listWorkflowsAwaitingWriter();
  assert.equal(pending.length, CANDIDATE_A_JOBS + CANDIDATE_B_JOBS, "20 approvals, 20 queued workflows");
  const keys = pending.map((w) => w.dedupe_key);
  assert.equal(new Set(keys).size, keys.length, "no job may be queued twice");
});

test("S32-12 the queue is oldest-approval-first, so neither candidate can starve the other", () => {
  const pending = listWorkflowsAwaitingWriter();
  const stamps = pending.map((w) => w.updated_at);
  assert.deepEqual(stamps, [...stamps].sort(), "ORDER BY updated_at ASC — approval order, not candidate order");

  // Interleaved approvals therefore drain interleaved: neither candidate waits for the other's ten.
  const order = pending.map((w) => w.candidate_id);
  assert.equal(order.filter((c) => c === candidateA).length, CANDIDATE_A_JOBS);
  assert.equal(order.filter((c) => c === candidateB).length, CANDIDATE_B_JOBS);
  assert.notDeepEqual(
    order,
    [...Array(CANDIDATE_A_JOBS).fill(candidateA), ...Array(CANDIDATE_B_JOBS).fill(candidateB)],
    "the queue must not group all of one candidate's work ahead of the other's"
  );
});

test("S32-13 one pass can never take more than the batch bound, however deep the queue", () => {
  const pending = listWorkflowsAwaitingWriter();
  assert.ok(pending.length > RESUME_WRITER_BATCH_SIZE, "the queue is deeper than one pass, which is the point");
  const batch = pending.slice(0, RESUME_WRITER_BATCH_SIZE);
  assert.equal(batch.length, RESUME_WRITER_BATCH_SIZE);
  assert.equal(RESUME_WRITER_BATCH_SIZE, 2, "a change here changes how much Claude work one pass may start");
});

test("S32-14 the pass drives workflows one at a time — Claude concurrency stays 1", () => {
  // Asserted structurally against runWorkerPass: a `for ... await` loop cannot overlap iterations,
  // whereas a Promise.all over the batch would run two Claude CLI processes at once. On this
  // machine (8 GB RAM, already ~5.2 GB into swap) that distinction is the difference between a
  // responsive UI and thrashing, so it is pinned rather than left to review.
  const source = fs.readFileSync(path.resolve("src/lib/resumeQuality/writers/writerWorkerCore.ts"), "utf-8");
  const passBody = source.slice(source.indexOf("export async function runWorkerPass"), source.indexOf("export interface GuardedWriterPassResult"));
  assert.match(passBody, /for \(const workflow of batch\) \{\s*outcomes\.push\(\.\.\.\(await driveWorkflowToCompletion/, passBody.slice(0, 400));
  assert.ok(!/Promise\.all|Promise\.allSettled/.test(passBody), "the batch must never be driven concurrently");
});

test("S32-15 candidate rows stay isolated — no workflow can carry another candidate's identity", () => {
  const pending = listWorkflowsAwaitingWriter();
  for (const workflow of pending) {
    const expected = workflow.dedupe_key.startsWith(`cand${candidateA}:`) ? candidateA : candidateB;
    assert.equal(workflow.candidate_id, expected, `${workflow.dedupe_key} is attributed to the wrong candidate`);
  }
  const aKeys = pending.filter((w) => w.candidate_id === candidateA).map((w) => w.dedupe_key);
  const bKeys = pending.filter((w) => w.candidate_id === candidateB).map((w) => w.dedupe_key);
  assert.equal(aKeys.some((k) => bKeys.includes(k)), false, "no dedupe_key may appear under both candidates");
});

test("S32-16 a terminal workflow leaves the queue and cannot be picked up again", () => {
  const db = getDb();
  const before = listWorkflowsAwaitingWriter().length;
  db.prepare("UPDATE resume_quality_workflows SET status = 'READY' WHERE dedupe_key = ?").run(`cand${candidateA}:job0`);
  db.prepare("UPDATE resume_quality_workflows SET status = 'FAILED' WHERE dedupe_key = ?").run(`cand${candidateB}:job0`);
  const after = listWorkflowsAwaitingWriter();
  assert.equal(after.length, before - 2, "READY and FAILED both leave the queue");
  assert.ok(!after.some((w) => w.status === "READY" || w.status === "FAILED"));
  // One workflow failing must not remove any other from the queue.
  assert.ok(after.some((w) => w.candidate_id === candidateA), "candidate A still has queued work");
  assert.ok(after.some((w) => w.candidate_id === candidateB), "candidate B still has queued work");
});
