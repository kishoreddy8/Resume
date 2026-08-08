import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedJob, PipelineStatus } from "../../../types";

/**
 * Deduplication & Repost Hardening tests — run against a real (temp, isolated) SQLite file via
 * CAREER_OPS_DB_PATH, same pattern as jobLifecycle.test.ts. Every DB-touching module is imported
 * dynamically inside before() so the env var is set before getDb() ever opens a file.
 *
 * Run with: npm test
 */

let tmpDir: string;

let getDb: typeof import("../../index").getDb;
let createCompany: typeof import("../companies").createCompany;
let upsertJob: typeof import("../jobs").upsertJob;
let updateJobPipeline: typeof import("../jobs").updateJobPipeline;
let setJobPinned: typeof import("../jobs").setJobPinned;
let markNotInterested: typeof import("../jobs").markNotInterested;
let getJob: typeof import("../jobs").getJob;
let listJobs: typeof import("../jobs").listJobs;
let dedupeKeyForAts: typeof import("../../../lib/dedupe").dedupeKeyForAts;
let dedupeKeyForCareerLink: typeof import("../../../lib/dedupe").dedupeKeyForCareerLink;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-dedupe-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("../../index"));
  ({ createCompany } = await import("../companies"));
  ({ upsertJob, updateJobPipeline, setJobPinned, markNotInterested, getJob, listJobs } = await import("../jobs"));
  ({ dedupeKeyForAts, dedupeKeyForCareerLink } = await import("../../../lib/dedupe"));

  getDb(); // ensure schema + migrations have run
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let companyCounter = 0;
function makeCompany(sourceType: "greenhouse" | "career_link" = "greenhouse") {
  companyCounter++;
  return createCompany({
    name: `Dedupe Test Co ${companyCounter}`,
    source_type: sourceType,
    ats_board_token: sourceType === "greenhouse" ? `token-${companyCounter}` : undefined,
    career_page_url: sourceType === "career_link" ? `https://acme${companyCounter}.example.com/careers` : undefined,
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

function seedJob(companyId: number, dedupeKey: string, sourceType: "greenhouse" | "career_link", overrides: Partial<NormalizedJob> = {}) {
  return upsertJob({
    companyId,
    sourceType,
    dedupeKey,
    job: makeNormalizedJob(overrides),
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
}

// --- Same external ID, changed content: must update, never duplicate ------------------------

test("same external ID with changed title/location/description updates the existing job", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");

  seedJob(company.id, key, "greenhouse", {
    title: "Software Engineer",
    location: "Remote",
    descriptionText: "Original description",
  });
  const jobId = listJobs({ companyId: company.id })[0].id;

  const outcome = seedJob(company.id, key, "greenhouse", {
    title: "Senior Software Engineer",
    location: "Austin, TX",
    descriptionText: "Updated description with new requirements",
  });

  assert.equal(outcome, "updated");
  assert.equal(listJobs({ companyId: company.id }).length, 1, "no duplicate row created");
  const job = getJob(jobId)!;
  assert.equal(job.title, "Senior Software Engineer");
  assert.equal(job.location, "Austin, TX");
  assert.equal(job.description_text, "Updated description with new requirements");
});

// --- Same title/location, different external ID: must be a new requisition ------------------

test("same title/location with a different external ID is a genuinely new requisition, not a merge", () => {
  const company = makeCompany();
  const firstKey = dedupeKeyForAts("greenhouse", company.id, "req-1");
  const secondKey = dedupeKeyForAts("greenhouse", company.id, "req-2");

  seedJob(company.id, firstKey, "greenhouse", { title: "Data Engineer", location: "Remote", externalId: "req-1" });
  const outcome = seedJob(company.id, secondKey, "greenhouse", {
    title: "Data Engineer",
    location: "Remote",
    externalId: "req-2",
  });

  assert.equal(outcome, "inserted");
  assert.equal(listJobs({ companyId: company.id }).length, 2, "two distinct requisitions, not merged");
});

// --- Repost with a new external ID: new row, fresh lifecycle age ----------------------------

test("a repost under a new external ID gets a fresh first_seen_at instead of inheriting the old job's age", () => {
  const company = makeCompany();
  const oldKey = dedupeKeyForAts("greenhouse", company.id, "req-old");
  seedJob(company.id, oldKey, "greenhouse", { title: "Product Manager", externalId: "req-old" });
  const oldJobId = listJobs({ companyId: company.id })[0].id;

  // Backdate it, simulating a posting that's been open for a while.
  getDb()
    .prepare("UPDATE jobs SET first_seen_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(), oldJobId);

  const newKey = dedupeKeyForAts("greenhouse", company.id, "req-new");
  const outcome = seedJob(company.id, newKey, "greenhouse", { title: "Product Manager", externalId: "req-new" });
  assert.equal(outcome, "inserted");

  const newJob = listJobs({ companyId: company.id }).find((j) => j.dedupe_key === newKey)!;
  const ageMs = Date.now() - new Date(newJob.first_seen_at).getTime();
  assert.ok(ageMs < 60_000, "the new requisition's first_seen_at must be fresh, not inherited");

  const oldJob = getJob(oldJobId)!;
  assert.ok(
    Date.now() - new Date(oldJob.first_seen_at).getTime() > 19 * 24 * 60 * 60 * 1000,
    "the old requisition's age must be untouched by the repost"
  );
});

test("re-scanning the same external ID (not a repost) never resets first_seen_at", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");
  seedJob(company.id, key, "greenhouse", { title: "Analyst" });
  const jobId = listJobs({ companyId: company.id })[0].id;

  const backdated = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare("UPDATE jobs SET first_seen_at = ? WHERE id = ?").run(backdated, jobId);

  seedJob(company.id, key, "greenhouse", { title: "Analyst II" }); // legitimate repost/update, same identity

  const job = getJob(jobId)!;
  assert.equal(job.first_seen_at, backdated, "same identity must preserve lifecycle age");
});

// --- Career-link canonical URL: tracking-param variants dedupe together ----------------------

test("career_link: tracking-parameter URL variants across repeated scans resolve to one job, not duplicates", () => {
  const company = makeCompany("career_link");
  const scan1Job: NormalizedJob = makeNormalizedJob({
    externalId: null,
    title: "Backend Engineer",
    url: "https://acme.example.com/careers/789-backend-engineer?utm_source=linkedin",
  });
  const scan2Job: NormalizedJob = makeNormalizedJob({
    externalId: null,
    title: "Backend Engineer",
    url: "https://acme.example.com/careers/789-backend-engineer?utm_source=twitter&utm_campaign=fall",
  });

  const key1 = dedupeKeyForCareerLink(company.id, scan1Job);
  const key2 = dedupeKeyForCareerLink(company.id, scan2Job);
  assert.equal(key1, key2, "tracking-param variants must resolve to the same identity");

  seedJob(company.id, key1, "career_link", scan1Job);
  const outcome = seedJob(company.id, key2, "career_link", scan2Job);

  assert.equal(outcome, "updated");
  assert.equal(listJobs({ companyId: company.id }).length, 1, "duplicate prevention across repeated scans");
});

test("career_link: a genuinely different job path is inserted as a new job, not merged", () => {
  const company = makeCompany("career_link");
  const jobA = makeNormalizedJob({ externalId: null, title: "Backend Engineer", url: "https://acme.example.com/careers/789-backend" });
  const jobB = makeNormalizedJob({ externalId: null, title: "Frontend Engineer", url: "https://acme.example.com/careers/790-frontend" });

  seedJob(company.id, dedupeKeyForCareerLink(company.id, jobA), "career_link", jobA);
  seedJob(company.id, dedupeKeyForCareerLink(company.id, jobB), "career_link", jobB);

  assert.equal(listJobs({ companyId: company.id }).length, 2);
});

test("career_link: generic fallback fingerprint prevents duplicate rows across repeated scans of a genericURL board", () => {
  const company = makeCompany("career_link");
  // No per-job path, no location/date — the scraper can only offer a title behind the career-page root.
  const scan1 = makeNormalizedJob({ externalId: null, title: "Support Specialist", url: "https://acme.example.com/careers" });
  const scan2 = makeNormalizedJob({ externalId: null, title: "Support Specialist", url: "https://acme.example.com/careers" });

  const key1 = dedupeKeyForCareerLink(company.id, scan1);
  const key2 = dedupeKeyForCareerLink(company.id, scan2);
  assert.equal(key1, key2);
  assert.match(key1, /^career_link:\d+:fp:/);

  seedJob(company.id, key1, "career_link", scan1);
  const outcome = seedJob(company.id, key2, "career_link", scan2);
  assert.equal(outcome, "updated");
  assert.equal(listJobs({ companyId: company.id }).length, 1);
});

// --- Suppression: exact rejected posting must not reappear -----------------------------------

test("Not Interested suppression blocks the exact same requisition from reappearing on rescan", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");
  seedJob(company.id, key, "greenhouse", { title: "QA Engineer" });
  markNotInterested(listJobs({ companyId: company.id })[0].id);

  const outcome = seedJob(company.id, key, "greenhouse", { title: "QA Engineer (rescanned)" });
  assert.equal(outcome, "suppressed");
  assert.equal(listJobs({ companyId: company.id }).length, 0);
});

test("suppression is scoped to the exact identity: a genuinely new requisition is still allowed through", () => {
  const company = makeCompany();
  const rejectedKey = dedupeKeyForAts("greenhouse", company.id, "req-old");
  seedJob(company.id, rejectedKey, "greenhouse", { title: "Support Engineer", externalId: "req-old" });
  markNotInterested(listJobs({ companyId: company.id })[0].id);

  const newKey = dedupeKeyForAts("greenhouse", company.id, "req-new");
  const outcome = seedJob(company.id, newKey, "greenhouse", { title: "Support Engineer", externalId: "req-new" });
  assert.equal(outcome, "inserted");
  assert.equal(listJobs({ companyId: company.id }).length, 1);
});

test("career_link suppression follows the same canonical-URL identity as insertion", () => {
  const company = makeCompany("career_link");
  const rejected = makeNormalizedJob({
    externalId: null,
    title: "Recruiter",
    url: "https://acme.example.com/careers/321-recruiter?utm_source=indeed",
  });
  const key = dedupeKeyForCareerLink(company.id, rejected);
  seedJob(company.id, key, "career_link", rejected);
  markNotInterested(listJobs({ companyId: company.id })[0].id);

  // Same posting reappears via a different tracking link on the next scan.
  const rescan = makeNormalizedJob({
    externalId: null,
    title: "Recruiter",
    url: "https://acme.example.com/careers/321-recruiter?utm_source=referral&utm_medium=email",
  });
  const rescanKey = dedupeKeyForCareerLink(company.id, rescan);
  assert.equal(rescanKey, key, "tracking variant must resolve to the same suppressed identity");

  const outcome = seedJob(company.id, rescanKey, "career_link", rescan);
  assert.equal(outcome, "suppressed");
});

// --- Preservation of lifecycle/application/user fields on refresh ---------------------------

test("pipeline status, notes, tags, and pinned state survive a rescan refresh", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");
  seedJob(company.id, key, "greenhouse", { title: "Original title" });
  const jobId = listJobs({ companyId: company.id })[0].id;

  updateJobPipeline(jobId, {
    pipelineStatus: "Applied" as PipelineStatus,
    notes: "Applied via referral",
    tags: ["priority", "referral"],
  });
  setJobPinned(jobId, true);

  seedJob(company.id, key, "greenhouse", { title: "Updated title from rescan", location: "New York, NY" });

  const job = getJob(jobId)!;
  assert.equal(job.title, "Updated title from rescan");
  assert.equal(job.location, "New York, NY");
  assert.equal(job.pipeline_status, "Applied", "pipeline_status must survive the refresh");
  assert.equal(job.notes, "Applied via referral", "notes must survive the refresh");
  assert.deepEqual(JSON.parse(job.tags ?? "[]"), ["priority", "referral"], "tags must survive the refresh");
  assert.equal(job.pinned, 1, "pinned state must survive the refresh");
});

// --- Duplicate prevention across repeated scans ----------------------------------------------

test("duplicate prevention across many repeated scans: same identity always resolves to one row", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");

  let lastOutcome: string | undefined;
  for (let i = 0; i < 5; i++) {
    lastOutcome = seedJob(company.id, key, "greenhouse", { title: `Scan pass ${i}` });
  }

  assert.equal(lastOutcome, "updated");
  assert.equal(listJobs({ companyId: company.id }).length, 1);
  assert.equal(getJob(listJobs({ companyId: company.id })[0].id)!.title, "Scan pass 4");
});

// --- Failed/partial scans must not affect identity or lifecycle -----------------------------

test("a failed upsert attempt (invalid company) never creates a partial/duplicate row for a valid identity", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");
  seedJob(company.id, key, "greenhouse", { title: "Stable job" });

  assert.throws(() => seedJob(999999, dedupeKeyForAts("greenhouse", 999999, "req-x"), "greenhouse"));

  assert.equal(listJobs({ companyId: company.id }).length, 1, "unrelated valid job untouched by the failed attempt");
  assert.equal(getJob(listJobs({ companyId: company.id })[0].id)!.title, "Stable job");
});
