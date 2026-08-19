import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/**
 * Stage 30.2 — the operator toggle for the resume writer.
 *
 * CareerOps already stored and honoured `scheduler.writerEnabled`; what was missing was any way to
 * change it from the UI. These cover the contract the new control depends on: a partial scheduler
 * patch flips exactly that one flag and provably leaves every other scheduler setting alone —
 * including the master switch, which must never be altered as a side effect of enabling the writer.
 *
 * Isolated temp database; the real data/app.db is never opened, and no Claude is ever invoked.
 */

let tmpDbDir: string;
let tmpDataDir: string;

let getAppSettings: typeof import("../settings").getAppSettings;
let updateAppSettings: typeof import("../settings").updateAppSettings;
let getDb: typeof import("@/db/index").getDb;
let listWorkflowsAwaitingWriter: typeof import("../resumeQualityWorkflows").listWorkflowsAwaitingWriter;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s302-db-"));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s302-data-"));
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
  ({ getAppSettings, updateAppSettings } = await import("../settings"));
  ({ listWorkflowsAwaitingWriter } = await import("../resumeQualityWorkflows"));
  getDb();
});

beforeEach(() => {
  // A representative operator configuration: automation on, writer off, everything else on.
  updateAppSettings({
    scheduler: {
      enabled: true,
      scanEnabled: true,
      productionEnabled: true,
      evaluationEnabled: true,
      writerEnabled: false,
      intervalMinutes: 60,
      windowStartHour: 0,
      windowEndHour: 24,
      timezone: "UTC",
    },
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

/** Everything about the scheduler EXCEPT the writer flag — what must never move. */
function schedulerWithoutWriter() {
  const { writerEnabled: _ignored, ...rest } = getAppSettings().scheduler;
  void _ignored;
  return rest;
}

test("S30.2-01 OFF -> ON updates only writerEnabled", () => {
  const before = schedulerWithoutWriter();
  assert.equal(getAppSettings().scheduler.writerEnabled, false);

  // Exactly the payload the UI control sends.
  const result = updateAppSettings({ scheduler: { writerEnabled: true } });
  assert.equal(result.ok, true);

  assert.equal(getAppSettings().scheduler.writerEnabled, true, "the writer flag must flip");
  assert.deepEqual(schedulerWithoutWriter(), before, "no other scheduler setting may change");
});

test("S30.2-02 ON -> OFF updates only writerEnabled", () => {
  updateAppSettings({ scheduler: { writerEnabled: true } });
  const before = schedulerWithoutWriter();

  const result = updateAppSettings({ scheduler: { writerEnabled: false } });
  assert.equal(result.ok, true);

  assert.equal(getAppSettings().scheduler.writerEnabled, false);
  assert.deepEqual(schedulerWithoutWriter(), before, "no other scheduler setting may change");
});

test("S30.2-03 the automation master switch is never altered by the writer toggle", () => {
  for (const master of [true, false]) {
    updateAppSettings({ scheduler: { enabled: master, writerEnabled: false } });
    updateAppSettings({ scheduler: { writerEnabled: true } });
    assert.equal(getAppSettings().scheduler.enabled, master, `master must stay ${master}`);
    updateAppSettings({ scheduler: { writerEnabled: false } });
    assert.equal(getAppSettings().scheduler.enabled, master, `master must still be ${master}`);
  }
});

test("S30.2-04 scan, ingestion and evaluation flags are untouched in both directions", () => {
  // Start from a deliberately mixed configuration so an accidental overwrite would be visible.
  updateAppSettings({
    scheduler: { enabled: true, scanEnabled: false, productionEnabled: true, evaluationEnabled: false, writerEnabled: false },
  });
  const before = schedulerWithoutWriter();

  updateAppSettings({ scheduler: { writerEnabled: true } });
  assert.deepEqual(schedulerWithoutWriter(), before, "turning the writer on must not reset the other ticks");

  updateAppSettings({ scheduler: { writerEnabled: false } });
  assert.deepEqual(schedulerWithoutWriter(), before, "turning it off must not either");

  const s = getAppSettings().scheduler;
  assert.equal(s.scanEnabled, false);
  assert.equal(s.productionEnabled, true);
  assert.equal(s.evaluationEnabled, false);
});

test("S30.2-05 the value persists and reads back from storage, not from memory", () => {
  updateAppSettings({ scheduler: { writerEnabled: true } });
  const stored = getDb().prepare("SELECT value FROM settings WHERE key = 'scheduler.writer_enabled'").get() as
    | { value: string }
    | undefined;
  assert.equal(stored?.value, "true", "the flag must be persisted, so the worker reads it through the normal path");
  assert.equal(getAppSettings().scheduler.writerEnabled, true, "and read back true");

  updateAppSettings({ scheduler: { writerEnabled: false } });
  const stored2 = getDb().prepare("SELECT value FROM settings WHERE key = 'scheduler.writer_enabled'").get() as
    | { value: string }
    | undefined;
  assert.equal(stored2?.value, "false");
  assert.equal(getAppSettings().scheduler.writerEnabled, false);
});

test("S30.2-06 toggling the writer approves nothing and creates no tailoring work", () => {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO candidates (id, first_name, last_name, display_name, status) VALUES (1,'Test','User','Test User','active')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO candidate_job_state (id, candidate_id, dedupe_key, marked_for_tailoring, pipeline_status) VALUES (1,1,'test:1:1',0,'New')"
  ).run();

  const before = {
    workflows: (db.prepare("SELECT COUNT(*) AS n FROM resume_quality_workflows").get() as { n: number }).n,
    runs: (db.prepare("SELECT COUNT(*) AS n FROM tailoring_runs").get() as { n: number }).n,
    approved: (db.prepare("SELECT COUNT(*) AS n FROM candidate_job_state WHERE marked_for_tailoring = 1").get() as { n: number }).n,
    applied: (db.prepare("SELECT COUNT(*) AS n FROM candidate_job_state WHERE pipeline_status <> 'New'").get() as { n: number }).n,
    queued: listWorkflowsAwaitingWriter().length,
  };

  updateAppSettings({ scheduler: { writerEnabled: true } });
  updateAppSettings({ scheduler: { writerEnabled: false } });

  const after = {
    workflows: (db.prepare("SELECT COUNT(*) AS n FROM resume_quality_workflows").get() as { n: number }).n,
    runs: (db.prepare("SELECT COUNT(*) AS n FROM tailoring_runs").get() as { n: number }).n,
    approved: (db.prepare("SELECT COUNT(*) AS n FROM candidate_job_state WHERE marked_for_tailoring = 1").get() as { n: number }).n,
    applied: (db.prepare("SELECT COUNT(*) AS n FROM candidate_job_state WHERE pipeline_status <> 'New'").get() as { n: number }).n,
    queued: listWorkflowsAwaitingWriter().length,
  };

  assert.deepEqual(after, before, "the toggle is a permission, not an action: it approves, creates and submits nothing");
  assert.equal(after.approved, 0, "no job becomes approved by enabling the writer");
  assert.equal(after.applied, 0, "no application status changes");
});

test("S30.2-07 an invalid writer value is rejected and leaves the stored setting untouched", () => {
  const before = getAppSettings().scheduler;
  const result = updateAppSettings({ scheduler: { writerEnabled: "yes" } } as never);
  assert.equal(result.ok, false, "a non-boolean must not be accepted");
  assert.deepEqual(getAppSettings().scheduler, before, "a rejected patch changes nothing");
});
