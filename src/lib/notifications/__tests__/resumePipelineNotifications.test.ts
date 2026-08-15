import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDbDir: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let listNotificationsForCandidate: typeof import("@/db/queries/notifications").listNotificationsForCandidate;
let notifyResumeReady: typeof import("../resumePipelineNotifications").notifyResumeReady;
let notifyWriterFailure: typeof import("../resumePipelineNotifications").notifyWriterFailure;
let notifyQualityFailure: typeof import("../resumePipelineNotifications").notifyQualityFailure;
let notifyHumanReviewRequired: typeof import("../resumePipelineNotifications").notifyHumanReviewRequired;
let RESUME_READY_NOTIFICATION_TYPE: string;
let WRITER_FAILURE_NOTIFICATION_TYPE: string;
let QUALITY_FAILURE_NOTIFICATION_TYPE: string;
let HUMAN_REVIEW_REQUIRED_NOTIFICATION_TYPE: string;

let candidateId: number;
const DEDUPE_KEY = "greenhouse:testco:job-notify-1";

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-notify-db-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {
      // Ignore.
    }
    global.__careerOpsDb = undefined;
  }

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ listNotificationsForCandidate } = await import("@/db/queries/notifications"));
  ({
    notifyResumeReady,
    notifyWriterFailure,
    notifyQualityFailure,
    notifyHumanReviewRequired,
    RESUME_READY_NOTIFICATION_TYPE,
    WRITER_FAILURE_NOTIFICATION_TYPE,
    QUALITY_FAILURE_NOTIFICATION_TYPE,
    HUMAN_REVIEW_REQUIRED_NOTIFICATION_TYPE,
  } = await import("../resumePipelineNotifications"));
  getDb();

  candidateId = createCandidate({ firstName: "Notify", lastName: "Tester" }).id;
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
  if (tmpDbDir && fs.existsSync(tmpDbDir)) fs.rmSync(tmpDbDir, { recursive: true, force: true });
});

test("notifyResumeReady creates a RESUME_READY row with real job identity", () => {
  const dedupeKey = `${DEDUPE_KEY}:ready`;
  const created = notifyResumeReady({ candidateId, dedupeKey, companyName: "Microsoft", jobTitle: "Senior Data Engineer" });
  assert.equal(created, true);

  const rows = listNotificationsForCandidate(candidateId);
  const row = rows.find((r) => r.dedupe_key === dedupeKey && r.type === RESUME_READY_NOTIFICATION_TYPE);
  assert(row, "expected a RESUME_READY notification row");
  assert(row!.title.includes("Microsoft"));
  assert(row!.body.includes("Quality gate passed"));
});

test("notifyQualityFailure creates a QUALITY_FAILURE row identifying the triggering iteration", () => {
  const dedupeKey = `${DEDUPE_KEY}:quality`;
  const created = notifyQualityFailure({
    candidateId,
    dedupeKey,
    companyName: "Acme",
    jobTitle: "Data Engineer",
    iteration: 2,
    blockingIssue: "Architecture consistency",
  });
  assert.equal(created, true);

  const rows = listNotificationsForCandidate(candidateId);
  const row = rows.find((r) => r.dedupe_key === dedupeKey && r.type === QUALITY_FAILURE_NOTIFICATION_TYPE);
  assert(row);
  assert(row!.body.includes("Iteration 2"));
  assert(row!.body.includes("Architecture consistency"));
});

test("notifyWriterFailure creates a WRITER_FAILURE row", () => {
  const dedupeKey = `${DEDUPE_KEY}:writer-failure`;
  const created = notifyWriterFailure({ candidateId, dedupeKey, companyName: "Acme", jobTitle: "Data Engineer", technicalRetry: 5 });
  assert.equal(created, true);

  const rows = listNotificationsForCandidate(candidateId);
  const row = rows.find((r) => r.dedupe_key === dedupeKey && r.type === WRITER_FAILURE_NOTIFICATION_TYPE);
  assert(row);
  assert(row!.body.includes("Technical retry 5"));
});

test("notifyHumanReviewRequired creates a HUMAN_REVIEW_REQUIRED row", () => {
  const dedupeKey = `${DEDUPE_KEY}:human-review`;
  const created = notifyHumanReviewRequired({ candidateId, dedupeKey, companyName: "Acme", jobTitle: "Data Engineer", remainingBlockers: 2 });
  assert.equal(created, true);

  const rows = listNotificationsForCandidate(candidateId);
  const row = rows.find((r) => r.dedupe_key === dedupeKey && r.type === HUMAN_REVIEW_REQUIRED_NOTIFICATION_TYPE);
  assert(row);
  assert(row!.body.includes("Remaining blockers: 2"));
});

test("dedup: the same (candidate, job dedupe_key, type) never creates a second row", () => {
  const dedupeKey = `${DEDUPE_KEY}:dedup-check`;
  const first = notifyResumeReady({ candidateId, dedupeKey, companyName: "Acme", jobTitle: "Data Engineer" });
  const second = notifyResumeReady({ candidateId, dedupeKey, companyName: "Acme", jobTitle: "Data Engineer" });

  assert.equal(first, true);
  assert.equal(second, false, "a duplicate call must report no new row created");

  const rows = listNotificationsForCandidate(candidateId).filter((r) => r.dedupe_key === dedupeKey && r.type === RESUME_READY_NOTIFICATION_TYPE);
  assert.equal(rows.length, 1, "exactly one row must exist, never two, even after a duplicate call");
});

test("dedup key is scoped by type: QUALITY_FAILURE and HUMAN_REVIEW_REQUIRED for the same job coexist", () => {
  const dedupeKey = `${DEDUPE_KEY}:mixed-types`;
  const q = notifyQualityFailure({ candidateId, dedupeKey, companyName: "Acme", jobTitle: "Data Engineer", iteration: 1, blockingIssue: null });
  const h = notifyHumanReviewRequired({ candidateId, dedupeKey, companyName: "Acme", jobTitle: "Data Engineer", remainingBlockers: 1 });

  assert.equal(q, true);
  assert.equal(h, true, "different notification types for the same job must not be blocked by each other's dedupe row");

  const rows = listNotificationsForCandidate(candidateId).filter((r) => r.dedupe_key === dedupeKey);
  assert.equal(rows.length, 2);
});

test("a notification failure (invalid candidate) is swallowed, never thrown — must not invalidate the workflow", () => {
  const nonExistentCandidateId = 999999999;
  assert.doesNotThrow(() => {
    const result = notifyResumeReady({
      candidateId: nonExistentCandidateId,
      dedupeKey: `${DEDUPE_KEY}:invalid-candidate`,
      companyName: "Acme",
      jobTitle: "Data Engineer",
    });
    assert.equal(result, false, "a failed notification insert must report false, not throw");
  });
});
