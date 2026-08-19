import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/**
 * Stage 29 — an approved workflow must not wait out a cadence designed for an idle system.
 *
 * The second cause of writer starvation (the first was the worker running this tick last, behind a
 * ten-minute production cycle) lived inside the tick itself: a 30-minute minimum spacing evaluated
 * BEFORE the cheap "is anything queued?" read, so a job approved moments after a pass finished waited
 * up to half an hour before the writer would even look at it.
 *
 * Isolated temp database; no Claude is ever invoked (CAREER_OPS_DISABLE_REAL_CLAUDE_CLI is set, and
 * every case here is decided before any writer pass would spawn one).
 */

let tmpDbDir: string;
let tmpDataDir: string;

let getDb: typeof import("@/db/index").getDb;
let updateAppSettings: typeof import("@/db/queries/settings").updateAppSettings;
let runResumeWriterTick: typeof import("../tick").runResumeWriterTick;
let RESUME_WRITER_INTERVAL_MINUTES: number;
let RESUME_WRITER_PENDING_INTERVAL_MINUTES: number;
let recordResumeWriterPassStarted: typeof import("../writerState").recordResumeWriterPassStarted;
let resetResumeWriterStateForTests: typeof import("../writerState").resetResumeWriterStateForTests;
let acquireResumeWriterLease: typeof import("../writerState").acquireResumeWriterLease;
let forceReleaseResumeWriterLease: typeof import("../writerState").forceReleaseResumeWriterLease;

/** One approved, queued workflow — the thing a human is waiting on. */
function seedPendingWorkflow(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO candidates (id, first_name, last_name, display_name, status) VALUES (1,'Test','User','Test User','active')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO candidate_job_state (id, candidate_id, dedupe_key, marked_for_tailoring) VALUES (1,1,'test:1:1',1)"
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO tailoring_runs (id, candidate_id, dedupe_key, job_id, status, approval_type, decision_at_approval,
       approved_at, master_resume_hash, master_skills_hash, candidate_profile_hash, jd_content_hash, match_engine_version, recommended_track)
     VALUES (1,1,'test:1:1',1,'started','READY_DIRECT','READY_FOR_TAILORING',datetime('now'),'h','h','h','h',6,'Track')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO resume_quality_workflows (id, candidate_id, application_id, tailoring_run_id, dedupe_key, status, current_iteration)
     VALUES (1,1,1,1,'test:1:1','CREATED',0)`
  ).run();
}

function clearPendingWorkflow(): void {
  getDb().prepare("UPDATE resume_quality_workflows SET status='READY' WHERE id=1").run();
}

function restorePendingWorkflow(): void {
  getDb().prepare("UPDATE resume_quality_workflows SET status='CREATED' WHERE id=1").run();
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s29-db-"));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s29-data-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_GENERATED_DIR = tmpDataDir;
  process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = "1";

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      // Ignore.
    }
    global.__careerOpsDb = undefined;
  }

  ({ getDb } = await import("@/db/index"));
  ({ updateAppSettings } = await import("@/db/queries/settings"));
  ({ runResumeWriterTick, RESUME_WRITER_INTERVAL_MINUTES, RESUME_WRITER_PENDING_INTERVAL_MINUTES } = await import("../tick"));
  ({ recordResumeWriterPassStarted, resetResumeWriterStateForTests, acquireResumeWriterLease, forceReleaseResumeWriterLease } =
    await import("../writerState"));

  getDb();
  seedPendingWorkflow();
});

beforeEach(() => {
  resetResumeWriterStateForTests();
  restorePendingWorkflow();
  updateAppSettings({
    scheduler: { enabled: true, writerEnabled: true, windowStartHour: 0, windowEndHour: 24, timezone: "UTC" },
  });
});

after(() => {
  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      // Ignore.
    }
    global.__careerOpsDb = undefined;
  }
  for (const d of [tmpDbDir, tmpDataDir]) {
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("S29-30 the pending-work spacing is short enough to meet the ~60s dispatch target", () => {
  assert.ok(
    RESUME_WRITER_PENDING_INTERVAL_MINUTES <= 1,
    `queued work must be picked up within about a minute, got ${RESUME_WRITER_PENDING_INTERVAL_MINUTES} minutes`
  );
  assert.ok(RESUME_WRITER_INTERVAL_MINUTES > RESUME_WRITER_PENDING_INTERVAL_MINUTES, "the idle cadence stays relaxed");
});

test("S29-31 an approved workflow is not made to wait out the idle 30-minute cadence", async () => {
  // A pass started two minutes ago: under the old rule the tick refused for another 28 minutes.
  const twoMinutesAgo = new Date(Date.now() - 2 * 60_000);
  recordResumeWriterPassStarted(twoMinutesAgo);

  const outcome = await runResumeWriterTick(new Date(), { maxWorkflows: 0 });
  assert.notEqual(outcome.outcome, "SKIPPED_INTERVAL_NOT_DUE", "queued work must not be blocked by the idle cadence");
  assert.equal(outcome.outcome, "RAN", `expected the writer to run, got ${outcome.outcome}`);
});

test("S29-32 the short spacing still prevents a tight loop", async () => {
  // A pass started seconds ago — even with work queued, the tick must not immediately run again.
  recordResumeWriterPassStarted(new Date());
  const outcome = await runResumeWriterTick(new Date(), { maxWorkflows: 0 });
  assert.equal(outcome.outcome, "SKIPPED_INTERVAL_NOT_DUE");
});

test("S29-33 with nothing queued the writer reports idle and never takes the lease", async () => {
  clearPendingWorkflow();
  const outcome = await runResumeWriterTick(new Date(), { maxWorkflows: 0 });
  assert.equal(outcome.outcome, "SKIPPED_NO_PENDING_WORKFLOWS");
});

test("S29-06 writerEnabled=false means the writer is never invoked, however much work is queued", async () => {
  updateAppSettings({ scheduler: { enabled: true, writerEnabled: false } });
  const outcome = await runResumeWriterTick(new Date(), { maxWorkflows: 0 });
  assert.equal(outcome.outcome, "SKIPPED_DISABLED");
});

test("S29-07 the master switch overrides everything", async () => {
  updateAppSettings({ scheduler: { enabled: false, writerEnabled: true } });
  const outcome = await runResumeWriterTick(new Date(), { maxWorkflows: 0 });
  assert.equal(outcome.outcome, "SKIPPED_DISABLED");
});

test("S29-08 outside the automation window nothing is invoked", async () => {
  updateAppSettings({ scheduler: { enabled: true, writerEnabled: true, windowStartHour: 0, windowEndHour: 1, timezone: "UTC" } });
  // 12:00 UTC is outside a 00:00-01:00 window.
  const outcome = await runResumeWriterTick(new Date("2026-08-19T12:00:00.000Z"), { maxWorkflows: 0 });
  assert.equal(outcome.outcome, "SKIPPED_OUTSIDE_WINDOW");
});

test("S29-09 a held writer lease still prevents a second concurrent writer", async () => {
  const lease = acquireResumeWriterLease();
  assert.equal(lease.acquired, true, "test setup: the lease must be free to begin with");
  try {
    const outcome = await runResumeWriterTick(new Date(), { maxWorkflows: 0 });
    assert.equal(outcome.outcome, "SKIPPED_LEASE_HELD", "concurrency must stay at exactly one writer");
  } finally {
    forceReleaseResumeWriterLease();
  }
});

test("S29-16/17 prioritising the writer changes nothing about approval or application state", async () => {
  const db = getDb();
  const before = db.prepare("SELECT pipeline_status, marked_for_tailoring FROM candidate_job_state WHERE id=1").get() as {
    pipeline_status: string;
    marked_for_tailoring: number;
  };
  await runResumeWriterTick(new Date(), { maxWorkflows: 0 });
  const after = db.prepare("SELECT pipeline_status, marked_for_tailoring FROM candidate_job_state WHERE id=1").get() as {
    pipeline_status: string;
    marked_for_tailoring: number;
  };
  assert.deepEqual(after, before, "the scheduler must never touch approval or application status");
  assert.equal(after.pipeline_status, "New", "nothing is ever marked Applied by scheduling");
});
