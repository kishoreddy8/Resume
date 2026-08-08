import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedJob, PipelineStatus } from "../../../types";

/**
 * Job Lifecycle Management integration tests, run against a real (temp, isolated) SQLite file via
 * CAREER_OPS_DB_PATH — see src/db/index.ts. Every DB-touching module is imported dynamically inside
 * before() rather than statically at the top of the file: static imports are hoisted and would run
 * before the env var below is set, which would make getDb() open the real data/app.db instead.
 *
 * Run with: npm test
 */

let tmpDir: string;

let createCompany: typeof import("../companies").createCompany;
let upsertJob: typeof import("../jobs").upsertJob;
let closeStaleJobs: typeof import("../jobs").closeStaleJobs;
let updateJobPipeline: typeof import("../jobs").updateJobPipeline;
let archiveJob: typeof import("../jobs").archiveJob;
let restoreJob: typeof import("../jobs").restoreJob;
let getJobHistory: typeof import("../jobs").getJobHistory;
let getJob: typeof import("../jobs").getJob;
let listJobs: typeof import("../jobs").listJobs;
let dedupeKeyForAts: typeof import("../../../lib/dedupe").dedupeKeyForAts;
let ARCHIVE_AFTER_MISSED_SCANS: number;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-lifecycle-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ createCompany } = await import("../companies"));
  ({ upsertJob, closeStaleJobs, updateJobPipeline, archiveJob, restoreJob, getJobHistory, getJob, listJobs } =
    await import("../jobs"));
  ({ dedupeKeyForAts } = await import("../../../lib/dedupe"));
  ({ ARCHIVE_AFTER_MISSED_SCANS } = await import("../../../lib/jobLifecycle"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let companyCounter = 0;
function makeCompany() {
  companyCounter++;
  return createCompany({
    name: `Test Co ${companyCounter}`,
    source_type: "greenhouse",
    ats_board_token: `token-${companyCounter}`,
  });
}

function makeNormalizedJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "ext-1",
    title: "Test Role",
    location: null,
    department: null,
    url: "https://example.com/job",
    descriptionHtml: null,
    descriptionText: null,
    employmentType: null,
    workplaceType: null,
    salaryText: null,
    postedAt: null,
    raw: null,
    ...overrides,
  };
}

function seedJob(companyId: number, dedupeKey: string, overrides: Partial<NormalizedJob> = {}) {
  return upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: makeNormalizedJob(overrides),
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedSignal: "Unknown",
  });
}

test("upsertJob refreshes an existing job by dedupe_key instead of creating a duplicate", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");

  const first = seedJob(company.id, key, { title: "Data Engineer" });
  const second = seedJob(company.id, key, { title: "Senior Data Engineer" });

  assert.equal(first, "inserted");
  assert.equal(second, "updated");

  const jobs = listJobs({ companyId: company.id });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "Senior Data Engineer");
});

test("a job missing from one scan is closed, not archived", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  const { jobsClosed, jobsArchived } = closeStaleJobs(company.id, []);
  assert.equal(jobsClosed, 1);
  assert.equal(jobsArchived, 0);

  const job = getJob(jobId)!;
  assert.equal(job.is_active, 0);
  assert.equal(job.is_archived, 0);
  assert.equal(job.missed_scan_count, 1);
  assert.ok(job.closed_at);

  const history = getJobHistory(jobId);
  assert.ok(history.some((h) => h.change_type === "lifecycle" && h.old_value === "Active" && h.new_value === "Closed"));
});

test("a job missing for N consecutive scans (the configured threshold) is archived", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  let lastResult = { jobsClosed: 0, jobsArchived: 0 };
  for (let i = 0; i < ARCHIVE_AFTER_MISSED_SCANS; i++) {
    lastResult = closeStaleJobs(company.id, []);
  }

  assert.equal(lastResult.jobsArchived, 1);

  const job = getJob(jobId)!;
  assert.equal(job.is_archived, 1);
  assert.equal(job.missed_scan_count, ARCHIVE_AFTER_MISSED_SCANS);
  assert.match(job.archived_reason ?? "", /consecutive scans/);

  const history = getJobHistory(jobId);
  assert.ok(history.some((h) => h.change_type === "lifecycle" && h.old_value === "Closed" && h.new_value === "Archived"));

  // Archived jobs are excluded from the default (non-archived) jobs view.
  assert.equal(listJobs({ companyId: company.id }).length, 0);
  assert.equal(listJobs({ companyId: company.id, archived: true }).length, 1);
});

test("a job marked Applied is closed but never auto-archived, even after many missed scans", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  updateJobPipeline(jobId, { pipelineStatus: "Applied" as PipelineStatus });

  for (let i = 0; i < ARCHIVE_AFTER_MISSED_SCANS + 3; i++) {
    closeStaleJobs(company.id, []);
  }

  const job = getJob(jobId)!;
  assert.equal(job.is_active, 0, "still closed — the board really doesn't have it anymore");
  assert.equal(job.is_archived, 0, "never archived while Applied");
  assert.ok(job.missed_scan_count >= ARCHIVE_AFTER_MISSED_SCANS);

  // Once the pipeline status moves off the protected set, the very next miss archives it
  // immediately using the miss count already accumulated — no need to wait through another
  // full window.
  updateJobPipeline(jobId, { pipelineStatus: "Rejected" as PipelineStatus });
  const { jobsArchived } = closeStaleJobs(company.id, []);
  assert.equal(jobsArchived, 1);
  assert.equal(getJob(jobId)!.is_archived, 1);
});

test("a closed job that reappears in a scan is reopened, not duplicated", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  closeStaleJobs(company.id, []);
  assert.equal(getJob(jobId)!.is_active, 0);

  const outcome = seedJob(company.id, key, { title: "Reposted Role" });
  assert.equal(outcome, "updated");

  const jobs = listJobs({ companyId: company.id });
  assert.equal(jobs.length, 1, "no duplicate row created for the reappeared posting");
  const job = getJob(jobId)!;
  assert.equal(job.is_active, 1);
  assert.equal(job.missed_scan_count, 0);
  assert.equal(job.closed_at, null);

  const history = getJobHistory(jobId);
  assert.ok(history.some((h) => h.change_type === "lifecycle" && h.old_value === "Closed" && h.new_value === "Active"));
});

test("an archived job that reappears in a scan is auto-restored", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  for (let i = 0; i < ARCHIVE_AFTER_MISSED_SCANS; i++) closeStaleJobs(company.id, []);
  assert.equal(getJob(jobId)!.is_archived, 1);

  seedJob(company.id, key);

  const job = getJob(jobId)!;
  assert.equal(job.is_archived, 0);
  assert.equal(job.is_active, 1);
  assert.equal(listJobs({ companyId: company.id }).length, 1);

  const history = getJobHistory(jobId);
  assert.ok(
    history.some(
      (h) => h.change_type === "lifecycle" && h.old_value === "Archived" && h.new_value === "Active"
    )
  );
});

test("notes, tags, and pipeline stage survive a rescan refresh; pipeline changes are logged", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key, { title: "Original title" });
  const jobId = listJobs({ companyId: company.id })[0].id;

  updateJobPipeline(jobId, {
    pipelineStatus: "Interested" as PipelineStatus,
    notes: "Recruiter reached out directly",
    tags: ["referral", "remote"],
  });

  // Simulate a rescan refreshing the title/description — must not clobber user-set fields.
  seedJob(company.id, key, { title: "Updated title from rescan" });

  const job = getJob(jobId)!;
  assert.equal(job.title, "Updated title from rescan");
  assert.equal(job.pipeline_status, "Interested");
  assert.equal(job.notes, "Recruiter reached out directly");
  assert.deepEqual(JSON.parse(job.tags ?? "[]"), ["referral", "remote"]);

  const history = getJobHistory(jobId);
  assert.ok(
    history.some(
      (h) => h.change_type === "pipeline_status" && h.old_value === "New" && h.new_value === "Interested"
    )
  );
});

test("archiveJob refuses to archive an Applied/Interview job and archives everything else", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  updateJobPipeline(jobId, { pipelineStatus: "Interview" as PipelineStatus });
  const blocked = archiveJob(jobId);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.blockedReason, /Interview/);
  assert.equal(getJob(jobId)!.is_archived, 0);

  updateJobPipeline(jobId, { pipelineStatus: "Rejected" as PipelineStatus });
  const allowed = archiveJob(jobId, "Went with another candidate");
  assert.equal(allowed.ok, true);
  if (allowed.ok) {
    assert.equal(allowed.job.is_archived, 1);
    assert.equal(allowed.job.archived_reason, "Went with another candidate");
  }

  const history = getJobHistory(jobId);
  assert.ok(
    history.some(
      (h) =>
        h.change_type === "lifecycle" && h.new_value === "Archived" && h.reason === "Went with another candidate"
    )
  );
});

test("restoreJob brings an archived job back with a clean lifecycle slate", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  for (let i = 0; i < ARCHIVE_AFTER_MISSED_SCANS; i++) closeStaleJobs(company.id, []);
  assert.equal(getJob(jobId)!.is_archived, 1);

  const restored = restoreJob(jobId)!;
  assert.equal(restored.is_archived, 0);
  assert.equal(restored.is_active, 1);
  assert.equal(restored.missed_scan_count, 0);
  assert.equal(restored.archived_at, null);

  const history = getJobHistory(jobId);
  assert.ok(
    history.some(
      (h) => h.change_type === "lifecycle" && h.old_value === "Archived" && h.reason === "Manually restored"
    )
  );
});

test("listJobs defaults to excluding archived jobs; archived:true shows only archived jobs", () => {
  const company = makeCompany();
  const keyA = dedupeKeyForAts("greenhouse", company.id, "ext-a");
  const keyB = dedupeKeyForAts("greenhouse", company.id, "ext-b");
  seedJob(company.id, keyA, { externalId: "ext-a", title: "Job A" });
  seedJob(company.id, keyB, { externalId: "ext-b", title: "Job B" });

  const jobB = listJobs({ companyId: company.id }).find((j) => j.title === "Job B")!;
  archiveJob(jobB.id);

  const defaultView = listJobs({ companyId: company.id });
  assert.equal(defaultView.length, 1);
  assert.equal(defaultView[0].title, "Job A");

  const archivedView = listJobs({ companyId: company.id, archived: true });
  assert.equal(archivedView.length, 1);
  assert.equal(archivedView[0].title, "Job B");
});
