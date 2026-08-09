import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedJob, PipelineStatus } from "../../../types";

/**
 * Job Lifecycle Management integration tests — the final age-based policy — run against a real
 * (temp, isolated) SQLite file via CAREER_OPS_DB_PATH (see src/db/index.ts). Every DB-touching
 * module is imported dynamically inside before() rather than statically at the top of the file:
 * static imports are hoisted and would run before the env var below is set, which would make
 * getDb() open the real data/app.db instead.
 *
 * Run with: npm test
 */

let tmpDir: string;

let getDb: typeof import("../../index").getDb;
let createCompany: typeof import("../companies").createCompany;
let upsertJob: typeof import("../jobs").upsertJob;
let closeStaleJobs: typeof import("../jobs").closeStaleJobs;
let updateJobPipeline: typeof import("../jobs").updateJobPipeline;
let archiveJob: typeof import("../jobs").archiveJob;
let restoreJob: typeof import("../jobs").restoreJob;
let markNotInterested: typeof import("../jobs").markNotInterested;
let runAgeBasedSweep: typeof import("../jobs").runAgeBasedSweep;
let getJobHistory: typeof import("../jobs").getJobHistory;
let getJob: typeof import("../jobs").getJob;
let listJobs: typeof import("../jobs").listJobs;
let dedupeKeyForAts: typeof import("../../../lib/dedupe").dedupeKeyForAts;
let runScan: typeof import("../../../lib/scan").runScan;
let setCandidatePipelineStatus: typeof import("../candidateJobState").setPipelineStatus;
let setCandidatePinned: typeof import("../candidateJobState").setPinned;

// Phase 2.5: lifecycle protection (isProtectedForAnyCandidate) now reads candidate_job_state, not
// the frozen jobs.pipeline_status/jobs.pinned columns — see src/db/queries/candidateJobState.ts.
// Every protection-testing call below writes through this candidate-scoped path instead of
// updateJobPipeline (which still exists and is still exercised by the "notes/tags survive a
// rescan" test elsewhere in this file, since THAT concern is genuinely about the legacy columns'
// own persistence, not about lifecycle protection).
const CANDIDATE_ID = 1;
function protectPipeline(jobId: number, status: PipelineStatus) {
  const dedupeKey = getJob(jobId)!.dedupe_key;
  setCandidatePipelineStatus(CANDIDATE_ID, dedupeKey, status);
}
function protectPinned(jobId: number, pinned: boolean) {
  const dedupeKey = getJob(jobId)!.dedupe_key;
  setCandidatePinned(CANDIDATE_ID, dedupeKey, pinned);
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-lifecycle-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("../../index"));
  ({ createCompany } = await import("../companies"));
  ({
    upsertJob,
    closeStaleJobs,
    updateJobPipeline,
    archiveJob,
    restoreJob,
    markNotInterested,
    runAgeBasedSweep,
    getJobHistory,
    getJob,
    listJobs,
  } = await import("../jobs"));
  ({ dedupeKeyForAts } = await import("../../../lib/dedupe"));
  ({ runScan } = await import("../../../lib/scan"));
  ({ setPipelineStatus: setCandidatePipelineStatus, setPinned: setCandidatePinned } = await import("../candidateJobState"));

  getDb(); // ensure schema + migrations have run
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let companyCounter = 0;
function makeCompany(sourceType: "greenhouse" | "workday" = "greenhouse") {
  companyCounter++;
  return createCompany({
    name: `Test Co ${companyCounter}`,
    source_type: sourceType,
    ats_board_token: sourceType === "workday" ? "not-a-valid-workday-token" : `token-${companyCounter}`,
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
    h1bCombinedConfidence: "Unknown",
  });
}

/** Backdates a job's age-source columns directly — there's no public API to set first_seen_at
 *  (it's a DB-default set once on insert), so age-band tests manipulate it via raw SQL, exactly
 *  like a job that was genuinely first seen N days ago would look. */
function backdateJob(jobId: number, daysAgo: number, useSourceColumn: "posted_at" | "first_seen_at" = "first_seen_at") {
  const iso = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare(`UPDATE jobs SET ${useSourceColumn} = ? WHERE id = ?`).run(iso, jobId);
}

function seedJobAtAge(
  company: { id: number },
  daysAgo: number,
  overrides: Partial<NormalizedJob> = {},
  externalId = `ext-${Math.random().toString(36).slice(2)}`
) {
  const key = dedupeKeyForAts("greenhouse", company.id, externalId);
  seedJob(company.id, key, { externalId, ...overrides });
  const job = listJobs({ companyId: company.id }).find((j) => j.dedupe_key === key)!;
  backdateJob(job.id, daysAgo);
  return getJob(job.id)!;
}

// --- Refresh / dedupe --------------------------------------------------------------------------

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

  seedJob(company.id, key, { title: "Updated title from rescan" });

  const job = getJob(jobId)!;
  assert.equal(job.title, "Updated title from rescan");
  assert.equal(job.pipeline_status, "Interested");
  assert.equal(job.notes, "Recruiter reached out directly");
  assert.deepEqual(JSON.parse(job.tags ?? "[]"), ["referral", "remote"]);

  const history = getJobHistory(jobId);
  assert.ok(
    history.some((h) => h.change_type === "pipeline_status" && h.old_value === "New" && h.new_value === "Interested")
  );
});

// --- CLOSED JOBS policy (scan-time) -------------------------------------------------------------

test("closed unapplied archived: an unapplied job missing from an ATS scan is closed AND archived immediately", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  const { jobsClosed, jobsArchived } = closeStaleJobs(company.id, []);
  assert.equal(jobsClosed, 1);
  assert.equal(jobsArchived, 1);

  const job = getJob(jobId)!;
  assert.equal(job.is_active, 0);
  assert.equal(job.is_archived, 1);
  assert.match(job.archived_reason ?? "", /closed upstream/);

  const history = getJobHistory(jobId);
  assert.ok(history.some((h) => h.old_value === "Active" && h.new_value === "Closed"));
  assert.ok(history.some((h) => h.old_value === "Closed" && h.new_value === "Archived"));
});

test("a protected (Applied) job missing from an ATS scan is closed but never archived", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;
  protectPipeline(jobId, "Applied" as PipelineStatus);

  const { jobsClosed, jobsArchived } = closeStaleJobs(company.id, []);
  assert.equal(jobsClosed, 1);
  assert.equal(jobsArchived, 0);

  const job = getJob(jobId)!;
  assert.equal(job.is_active, 0);
  assert.equal(job.is_archived, 0);
});

test("a closed (not archived) protected job that reappears in a scan is reopened, not duplicated", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;
  updateJobPipeline(jobId, { pipelineStatus: "Applied" as PipelineStatus });
  closeStaleJobs(company.id, []);
  assert.equal(getJob(jobId)!.is_active, 0);

  const outcome = seedJob(company.id, key, { title: "Reposted Role" });
  assert.equal(outcome, "updated");

  const jobs = listJobs({ companyId: company.id });
  assert.equal(jobs.length, 1, "no duplicate row created for the reappeared posting");
  assert.equal(getJob(jobId)!.is_active, 1);
});

test("an archived job that reappears in a scan is auto-restored", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;
  closeStaleJobs(company.id, []); // unapplied -> closed AND archived immediately
  assert.equal(getJob(jobId)!.is_archived, 1);

  seedJob(company.id, key);

  const job = getJob(jobId)!;
  assert.equal(job.is_archived, 0);
  assert.equal(job.is_active, 1);
  assert.equal(listJobs({ companyId: company.id }).length, 1);
  assert.ok(getJobHistory(jobId).some((h) => h.old_value === "Archived" && h.new_value === "Active"));
});

// --- Manual archive/restore/pin -----------------------------------------------------------------

test("archiveJob refuses a protected (Interviewing) job, refuses a pinned job, and archives everything else", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  protectPipeline(jobId, "Interviewing" as PipelineStatus);
  let blocked = archiveJob(jobId);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.blockedReason, /Interviewing/);

  protectPipeline(jobId, "Interested" as PipelineStatus);
  protectPinned(jobId, true);
  blocked = archiveJob(jobId);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.blockedReason, /pinned/);

  protectPinned(jobId, false);
  const allowed = archiveJob(jobId, "Went with another candidate");
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.job.archived_reason, "Went with another candidate");
});

test("restoreJob brings an archived job back with a clean lifecycle slate", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;
  closeStaleJobs(company.id, []);
  assert.equal(getJob(jobId)!.is_archived, 1);

  const restored = restoreJob(jobId)!;
  assert.equal(restored.is_archived, 0);
  assert.equal(restored.is_active, 1);
  assert.equal(restored.missed_scan_count, 0);
});

test("listJobs defaults to excluding archived jobs; archived:true shows only archived jobs", () => {
  const company = makeCompany();
  seedJob(company.id, dedupeKeyForAts("greenhouse", company.id, "ext-a"), { externalId: "ext-a", title: "Job A" });
  seedJob(company.id, dedupeKeyForAts("greenhouse", company.id, "ext-b"), { externalId: "ext-b", title: "Job B" });
  const jobB = listJobs({ companyId: company.id }).find((j) => j.title === "Job B")!;
  archiveJob(jobB.id);

  assert.equal(listJobs({ companyId: company.id }).length, 1);
  assert.equal(listJobs({ companyId: company.id })[0].title, "Job A");
  const archived = listJobs({ companyId: company.id, archived: true });
  assert.equal(archived.length, 1);
  assert.equal(archived[0].title, "Job B");
});

// --- Age-based sweep -----------------------------------------------------------------------------

test("2-day Fresh and 5-day Active jobs are untouched by the age sweep", () => {
  const company = makeCompany();
  const fresh = seedJobAtAge(company, 2);
  const active = seedJobAtAge(company, 5);

  const result = runAgeBasedSweep();
  assert.equal(result.archived, 0);
  assert.equal(result.deleted.length, 0);
  assert.equal(getJob(fresh.id)!.is_archived, 0);
  assert.equal(getJob(active.id)!.is_archived, 0);
});

test("8-day unapplied Archive: the age sweep archives an unapplied job 8-10 days old", () => {
  const company = makeCompany();
  const job = seedJobAtAge(company, 8);

  const result = runAgeBasedSweep();
  assert.equal(result.archived, 1);
  assert.equal(getJob(job.id)!.is_archived, 1);
  assert.match(getJob(job.id)!.archived_reason ?? "", /Aged out: 8 days/);
});

test("11-day unapplied Delete: the age sweep permanently deletes an unapplied job older than 10 days", () => {
  const company = makeCompany();
  const job = seedJobAtAge(company, 11);

  const result = runAgeBasedSweep();
  assert.equal(result.deleted.length, 1);
  assert.equal(result.deleted[0].jobId, job.id);
  assert.equal(getJob(job.id), undefined, "job row is gone");

  const suppressed = getDb()
    .prepare("SELECT * FROM suppressed_jobs WHERE dedupe_key = ?")
    .get(job.dedupe_key) as { reason: string } | undefined;
  assert.ok(suppressed, "a suppression fingerprint was written");
  assert.match(suppressed!.reason, /Aged out: 11 days/);
});

test("15-day Applied job is preserved by the age sweep (never archived or deleted)", () => {
  const company = makeCompany();
  const job = seedJobAtAge(company, 15);
  protectPipeline(job.id, "Applied" as PipelineStatus);

  const result = runAgeBasedSweep();
  assert.equal(result.archived, 0);
  assert.equal(result.deleted.length, 0);
  assert.ok(getJob(job.id), "job still exists");
  assert.equal(getJob(job.id)!.is_archived, 0);
});

test("a 15-day-old Interviewing job is preserved by the age sweep", () => {
  const company = makeCompany();
  const job = seedJobAtAge(company, 15);
  protectPipeline(job.id, "Interviewing" as PipelineStatus);

  runAgeBasedSweep();
  assert.ok(getJob(job.id));
  assert.equal(getJob(job.id)!.is_archived, 0);
});

test("a 15-day-old Offer job is preserved by the age sweep", () => {
  const company = makeCompany();
  const job = seedJobAtAge(company, 15);
  protectPipeline(job.id, "Offer" as PipelineStatus);

  runAgeBasedSweep();
  assert.ok(getJob(job.id));
  assert.equal(getJob(job.id)!.is_archived, 0);
});

test("a 15-day-old Employer Rejected job is preserved by the age sweep", () => {
  const company = makeCompany();
  const job = seedJobAtAge(company, 15);
  protectPipeline(job.id, "Employer Rejected" as PipelineStatus);

  runAgeBasedSweep();
  assert.ok(getJob(job.id));
  assert.equal(getJob(job.id)!.is_archived, 0);
});

test("a 15-day-old Pinned job (New status) is preserved by the age sweep", () => {
  const company = makeCompany();
  const job = seedJobAtAge(company, 15);
  protectPinned(job.id, true);

  runAgeBasedSweep();
  assert.ok(getJob(job.id), "pinned job was not deleted");
  assert.equal(getJob(job.id)!.is_archived, 0, "pinned job was not archived");
});

test("an already-archived unapplied job that ages past 10 days is deleted by the next sweep", () => {
  const company = makeCompany();
  const job = seedJobAtAge(company, 9); // archives on this pass
  runAgeBasedSweep();
  assert.equal(getJob(job.id)!.is_archived, 1);

  backdateJob(job.id, 12); // age it further, past the delete threshold
  const result = runAgeBasedSweep();
  assert.equal(result.deleted.length, 1);
  assert.equal(getJob(job.id), undefined);
});

// --- Not Interested / suppression / dedup -------------------------------------------------------

test("Not Interested immediate deletion: markNotInterested deletes the row and suppresses it regardless of age", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key, { title: "Brand new posting" }); // age 0 — would never be touched by the sweep
  const jobId = listJobs({ companyId: company.id })[0].id;

  const deleted = markNotInterested(jobId);
  assert.ok(deleted);
  assert.equal(deleted!.dedupeKey, key);
  assert.equal(getJob(jobId), undefined);

  const suppressed = getDb().prepare("SELECT * FROM suppressed_jobs WHERE dedupe_key = ?").get(key) as
    | { reason: string }
    | undefined;
  assert.ok(suppressed);
  assert.equal(suppressed!.reason, "Not Interested");
});

test("rejected exact requisition suppressed: the same dedupe_key does not reappear after deletion", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "ext-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;
  markNotInterested(jobId);

  const outcome = seedJob(company.id, key, { title: "Same requisition, rescanned" });
  assert.equal(outcome, "suppressed");
  assert.equal(listJobs({ companyId: company.id }).length, 0);
});

test("new requisition ID allowed: a different dedupe_key for the same company is not suppressed", () => {
  const company = makeCompany();
  const rejectedKey = dedupeKeyForAts("greenhouse", company.id, "ext-old");
  seedJob(company.id, rejectedKey, { externalId: "ext-old" });
  markNotInterested(listJobs({ companyId: company.id })[0].id);

  const newKey = dedupeKeyForAts("greenhouse", company.id, "ext-new");
  const outcome = seedJob(company.id, newKey, { externalId: "ext-new", title: "A genuinely different opening" });
  assert.equal(outcome, "inserted");
  assert.equal(listJobs({ companyId: company.id }).length, 1);
});

// --- Scan failure isolation ------------------------------------------------------------------

test("failed scan changes nothing: a company whose fetch throws leaves its jobs' lifecycle state untouched", async () => {
  const workingCompany = makeCompany();
  seedJob(workingCompany.id, dedupeKeyForAts("greenhouse", workingCompany.id, "ext-1"));
  const controlJobId = listJobs({ companyId: workingCompany.id })[0].id;
  const before = getJob(controlJobId)!;

  // Workday's decodeWorkdayToken() throws synchronously on a malformed token — no network needed,
  // deterministic, and it's real unmodified ATS-connector code exercising scan.ts's real try/catch.
  const brokenCompany = makeCompany("workday");
  const brokenKey = dedupeKeyForAts("workday", brokenCompany.id, "ext-1");
  seedJob(brokenCompany.id, brokenKey);
  const brokenJobId = listJobs({ companyId: brokenCompany.id })[0].id;
  const brokenBefore = getJob(brokenJobId)!;

  const summary = await runScan([brokenCompany]);

  assert.equal(summary.errors, 1);
  assert.equal(summary.results[0].status, "error");
  assert.equal(summary.results[0].jobsClosed, 0);
  assert.equal(summary.results[0].jobsArchived, 0);

  const brokenAfter = getJob(brokenJobId)!;
  assert.equal(brokenAfter.is_active, brokenBefore.is_active);
  assert.equal(brokenAfter.is_archived, brokenBefore.is_archived);
  assert.equal(brokenAfter.missed_scan_count, brokenBefore.missed_scan_count);

  // The unrelated, working company's job is untouched too (it wasn't part of this scan at all).
  const controlAfter = getJob(controlJobId)!;
  assert.equal(controlAfter.is_active, before.is_active);
  assert.equal(controlAfter.is_archived, before.is_archived);
});
