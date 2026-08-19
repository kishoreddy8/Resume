import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/**
 * Stage 27 — the writer health model must describe reality.
 *
 * The defect these cover: an approved workflow whose technical budget was exhausted reported
 * "TECHNICAL_FAILURE … the writer retries on its own schedule", which was false — nothing would ever
 * retry it — and a workflow the writer declined every pass for a stale approval was indistinguishable
 * from ordinary waiting. In both cases the user was left watching a queue that could never move.
 *
 * Isolated temp database; the real data/app.db is never opened, and no Claude process is ever spawned.
 */

let tmpDbDir: string;
let tmpDataDir: string;

let getDb: typeof import("@/db/index").getDb;
let getResumeWriterHealth: typeof import("../writerHealth").getResumeWriterHealth;
let updateAppSettings: typeof import("@/db/queries/settings").updateAppSettings;
let recordResumeWriterTick: typeof import("../writerState").recordResumeWriterTick;
let recordResumeWriterPassCompleted: typeof import("../writerState").recordResumeWriterPassCompleted;
let recordWriterOperationalBlock: typeof import("../writerState").recordWriterOperationalBlock;
let clearWriterOperationalBlock: typeof import("../writerState").clearWriterOperationalBlock;
let getWriterOperationalBlock: typeof import("../writerState").getWriterOperationalBlock;
let resetResumeWriterStateForTests: typeof import("../writerState").resetResumeWriterStateForTests;

/** One approved, queued workflow, so pendingWorkflowCount is non-zero and the health model has
 *  something to describe. Written directly because this file tests reporting, not creation. */
function seedQueuedWorkflow(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO candidates (id, first_name, last_name, display_name, status) VALUES (1, 'Test', 'User', 'Test User', 'active')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO candidate_job_state (id, candidate_id, dedupe_key, marked_for_tailoring) VALUES (1, 1, 'test:1:1', 1)"
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO tailoring_runs (id, candidate_id, dedupe_key, job_id, status, approval_type, decision_at_approval,
       approved_at, master_resume_hash, master_skills_hash, candidate_profile_hash, jd_content_hash, match_engine_version, recommended_track)
     VALUES (1, 1, 'test:1:1', 1, 'started', 'READY_DIRECT', 'READY_FOR_TAILORING', datetime('now'), 'h', 'h', 'h', 'h', 6, 'Track')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO resume_quality_workflows (id, candidate_id, application_id, tailoring_run_id, dedupe_key, status, current_iteration)
     VALUES (1, 1, 1, 1, 'test:1:1', 'IMPROVEMENT_RUNNING', 1)`
  ).run();
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s27-health-db-"));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s27-health-data-"));
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
  ({ getResumeWriterHealth } = await import("../writerHealth"));
  ({ updateAppSettings } = await import("@/db/queries/settings"));
  ({
    recordResumeWriterTick,
    recordResumeWriterPassCompleted,
    recordWriterOperationalBlock,
    clearWriterOperationalBlock,
    getWriterOperationalBlock,
    resetResumeWriterStateForTests,
  } = await import("../writerState"));

  getDb();
  seedQueuedWorkflow();
  updateAppSettings({ scheduler: { enabled: true, writerEnabled: true, windowStartHour: 0, windowEndHour: 24 } });
});

beforeEach(() => {
  resetResumeWriterStateForTests();
  // A live scheduler, so states are not masked by "nothing is running the scheduler".
  recordResumeWriterTick(new Date());
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

test("S27-70 an exhausted technical budget is reported as terminal, not as a self-retrying failure", () => {
  recordResumeWriterPassCompleted(
    { attempted: 1, outcomes: [{ workflowId: 1, candidateId: 1, outcome: "BLOCKED_MAX_ATTEMPTS", error: "failed 5 times" }] },
    1000
  );
  const health = getResumeWriterHealth();
  assert.equal(health.state, "BLOCKED_MAX_ATTEMPTS");
  assert.match(health.detail, /will NOT try again on its own/i);
  assert.doesNotMatch(health.detail, /retries on its own schedule/i, "the false promise must be gone");
  assert.match(health.detail, /no quality iteration was used/i);
});

test("S27-71 an exhausted subscription is reported as itself, with no invented reset time", () => {
  recordWriterOperationalBlock("SUBSCRIPTION_LIMIT_REACHED", "Claude usage limit reached.");
  const health = getResumeWriterHealth();
  assert.equal(health.state, "SUBSCRIPTION_LIMIT_REACHED");
  assert.match(health.detail, /usage limit/i);
  assert.match(health.detail, /not told when your usage window actually resets/i, "must not present a cooldown as a reset time");
  assert.match(health.detail, /No quality iteration has been used/i);
});

test("S27-72 a logged-out CLI asks the operator to sign in and promises no automatic retry", () => {
  recordWriterOperationalBlock("AUTH_REQUIRED", "Not logged in.");
  const health = getResumeWriterHealth();
  assert.equal(health.state, "AUTH_REQUIRED");
  assert.match(health.detail, /claude login/i);
  assert.match(health.detail, /Nothing is being retried automatically/i);

  // AUTH_REQUIRED never expires on a timer — only the operator can clear it.
  const block = getWriterOperationalBlock();
  assert.equal(block.until, null, "a logged-out CLI must not get a cooldown that silently resumes");
  assert.equal(block.expired, false);
});

test("S27-73 a subscription block does expire on its own, so a recovered subscription resumes unattended", () => {
  const t0 = new Date("2026-08-18T10:00:00.000Z");
  recordWriterOperationalBlock("SUBSCRIPTION_LIMIT_REACHED", "limit", t0);
  assert.equal(getWriterOperationalBlock(new Date("2026-08-18T10:30:00.000Z")).expired, false);
  assert.equal(getWriterOperationalBlock(new Date("2026-08-18T12:00:00.000Z")).expired, true);
});

test("S27-74 a stale approval is named, instead of looking like ordinary waiting", () => {
  recordResumeWriterPassCompleted(
    {
      attempted: 1,
      outcomes: [
        {
          workflowId: 1,
          candidateId: 1,
          outcome: "SKIPPED_UNAUTHORIZED",
          error: "Tailoring approval stale: approved for READY_FOR_TAILORING, but current match decision is BLOCKED.",
        },
      ],
    },
    1000
  );
  const health = getResumeWriterHealth();
  assert.equal(health.state, "UNAUTHORIZED_APPROVAL_STALE");
  assert.match(health.detail, /approve it again/i, "the user must be told what to actually do");
  assert.match(health.detail, /no quality iteration was used/i);
});

test("S27-75 clearing the block returns the writer to ordinary waiting", () => {
  recordWriterOperationalBlock("AUTH_REQUIRED", "Not logged in.");
  assert.equal(getResumeWriterHealth().state, "AUTH_REQUIRED");
  clearWriterOperationalBlock();
  const health = getResumeWriterHealth();
  assert.notEqual(health.state, "AUTH_REQUIRED");
  assert.equal(health.pendingWorkflowCount, 1, "the approved workflow is still queued and still visible");
});

test("S27-76 an ordinary transient failure still reads as retrying — that behaviour is unchanged", () => {
  recordResumeWriterPassCompleted(
    {
      attempted: 1,
      outcomes: [{ workflowId: 1, candidateId: 1, outcome: "TECHNICAL_FAILURE", error: "boom", providerUnavailable: true }],
    },
    1000
  );
  const health = getResumeWriterHealth();
  assert.equal(health.state, "TECHNICAL_FAILURE");
  assert.match(health.detail, /temporarily unavailable/i);
  assert.match(health.detail, /no quality iteration was used/i);
});
