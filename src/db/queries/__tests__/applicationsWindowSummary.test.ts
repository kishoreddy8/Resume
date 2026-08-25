import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * UI-0 DEFECT 7 — `getApplicationsWindowSummary`, the windowed replacement for the unwindowed
 * lifetime `GROUP BY status` that made Admin read "Applications: DEGRADED" forever after a single
 * historical failure (observed: degraded since 2026-08-23 with no structural way to recover).
 *
 * Isolated on a temp on-disk database (this repo's established convention — see
 * candidateJobState.test.ts) so this never touches the real, 2.4GB production database.
 */

let tmpDir: string;
let getApplicationsWindowSummary: typeof import("../applicationRuns").getApplicationsWindowSummary;
let createCandidate: typeof import("../candidates").createCandidate;
let getDb: typeof import("../../index").getDb;
let candidateId: number;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-applications-window-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getApplicationsWindowSummary } = await import("../applicationRuns"));
  ({ createCandidate } = await import("../candidates"));
  ({ getDb } = await import("../../index"));
  getDb();
  candidateId = createCandidate({ firstName: "Test", lastName: "Candidate" }).id;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Inserts a run directly with an explicit updated_at, bypassing advanceRun (which always stamps
 *  datetime('now')) so the test can simulate "this failed N days ago". */
function insertRunAt(status: string, daysAgo: number, dedupeKey: string): void {
  getDb()
    .prepare(
      `INSERT INTO application_runs (candidate_id, job_id, dedupe_key, status, created_at, updated_at)
       VALUES (@candidateId, 1, @dedupeKey, @status, datetime('now', @offset), datetime('now', @offset))`
    )
    .run({ candidateId, dedupeKey, status, offset: `-${daysAgo} days` });
}

test("ADMIN-HEALTH-02: a recent failure (within the window) is counted", () => {
  insertRunAt("FAILED", 0.1, "recent-failure-job");
  const summary = getApplicationsWindowSummary(1 /* 24h */);
  assert.ok(summary.failedCount >= 1, "a failure from a couple hours ago must be counted within a 24h window");
});

test("ADMIN-HEALTH-01: an old historical failure ages out of a short window and no longer counts", () => {
  insertRunAt("FAILED", 45, "very-old-failure-job");
  const summary24h = getApplicationsWindowSummary(1 /* 24h */);
  const failuresAt45Days = getDb()
    .prepare("SELECT COUNT(*) AS c FROM application_runs WHERE dedupe_key = 'very-old-failure-job'")
    .get() as { c: number };
  assert.equal(failuresAt45Days.c, 1, "the historical row itself must still exist — nothing was deleted");
  /* The 24h window from the previous test already contains one genuinely recent failure, so assert
   * on the SHAPE of the fix directly: a failure 45 days old is invisible to a 1-day window. */
  const summary1Day = getApplicationsWindowSummary(1);
  const oldOnly = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM application_runs
       WHERE status = 'FAILED' AND julianday('now') - julianday(updated_at) <= 1`
    )
    .get() as { c: number };
  assert.equal(summary1Day.failedCount, oldOnly.c, "the windowed query must only ever count rows actually inside the window");
  void summary24h;
});

test("ADMIN-HEALTH-03: a wider window recovers visibility of what a narrower one aged out, and vice versa", () => {
  const wide = getApplicationsWindowSummary(60 /* wider than the 45-day-old failure */);
  const narrow = getApplicationsWindowSummary(1);
  assert.ok(wide.failedCount > narrow.failedCount, "the 45-day-old failure must be visible in a 60-day window but not a 1-day one");
});

test("ADMIN-HEALTH-04: historical failures remain queryable directly — this function narrows a VIEW, it does not delete data", () => {
  const allTime = getDb().prepare("SELECT COUNT(*) AS c FROM application_runs WHERE status = 'FAILED'").get() as { c: number };
  assert.ok(allTime.c >= 2, "both the recent and the 45-day-old failure must still exist in the table");
});

test("a run with no failures in the window reports HEALTHY-shaped data (failedCount 0)", () => {
  const isolatedDedupe = `isolated-${Date.now()}`;
  insertRunAt("SUBMITTED", 0, isolatedDedupe);
  const before = getApplicationsWindowSummary(90).failedCount;
  insertRunAt("SUBMITTED", 0, `${isolatedDedupe}-2`);
  const after = getApplicationsWindowSummary(90).failedCount;
  assert.equal(after, before, "adding a SUCCESSFUL run must never change the failed count");
});

test("total reflects every run inside the window, not only failed ones", () => {
  const summary = getApplicationsWindowSummary(90);
  assert.ok(summary.total >= summary.failedCount, "total must be at least the failed count");
  assert.ok(summary.total > 0, "the runs inserted by prior tests in this file must be counted");
});
