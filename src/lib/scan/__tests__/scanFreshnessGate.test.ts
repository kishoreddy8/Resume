import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { isJobFreshForIngestion } from "@/lib/ats/jobFreshness";
import type { NormalizedJob } from "@/types";

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let listJobs: typeof import("@/db/queries/jobs").listJobs;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-freshness-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  getDb = (await import("@/db")).getDb;
  createCompany = (await import("@/db/queries/companies")).createCompany;
  upsertJob = (await import("@/db/queries/jobs")).upsertJob;
  getJobByDedupeKey = (await import("@/db/queries/jobs")).getJobByDedupeKey;
  listJobs = (await import("@/db/queries/jobs")).listJobs;
  dedupeKeyForAts = (await import("@/lib/dedupe")).dedupeKeyForAts;

  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function makeJob(id: string, postedAt: string | null, title = "Software Engineer"): NormalizedJob {
  return {
    externalId: id,
    title,
    location: "Austin, TX, United States",
    department: "Engineering",
    url: `https://example.com/jobs/${id}`,
    descriptionHtml: "<p>Complete position description.</p>",
    descriptionText: "Complete position description.",
    employmentType: "Full-time",
    workplaceType: "hybrid",
    salaryText: "$130,000",
    postedAt,
    raw: null,
  };
}

test("Centralized Ingestion Freshness Gate filters stale new jobs while preserving fresh and rescan jobs", () => {
  const company = createCompany({
    name: "Freshness Test Corp",
    source_type: "greenhouse",
    ats_board_token: "testcorp",
    career_page_url: "https://boards.greenhouse.io/testcorp",
  });

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const daysAgo = (d: number) => new Date(now.getTime() - d * dayMs).toISOString();

  const jobsFromAts: NormalizedJob[] = [
    makeJob("fresh-1", daysAgo(5), "Fresh Senior Engineer"),
    makeJob("stale-1", daysAgo(45), "Stale Obsolete Role"),
    makeJob("nodate-1", null, "No Date Role"),
  ];

  // Pipeline simulation: for each job, check freshness before upsertJob
  for (const job of jobsFromAts) {
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, job.externalId!);
    const before = getJobByDedupeKey(dedupeKey);
    const freshness = isJobFreshForIngestion(job, before ? { id: before.id } : undefined, company.source_type, 20, now);

    if (freshness.eligible) {
      upsertJob({
        companyId: company.id,
        sourceType: company.source_type,
        dedupeKey,
        job,
        descriptionSections: null,
        sponsorshipMentioned: false,
        sponsorshipPolarity: "none",
        sponsorshipSnippet: null,
        h1bCombinedConfidence: "High",
      });
    }
  }

  // Verify Round 1 insertions
  const jobsInDb = listJobs({ companyId: company.id });
  const externalIds = jobsInDb.map((j) => j.external_id);
  assert.equal(externalIds.includes("fresh-1"), true, "Fresh job must be inserted");
  assert.equal(externalIds.includes("nodate-1"), true, "Missing date job must be inserted via fallback");
  assert.equal(externalIds.includes("stale-1"), false, "Stale job (> 20 days) must NOT be inserted into database");

  // Round 2: Rescan occurs where fresh-1 is now 25 days old on the employer's board
  // Since it already exists in the database, the freshness gate must permit it and update last_seen_at
  const rescanJobs: NormalizedJob[] = [
    makeJob("fresh-1", daysAgo(25), "Fresh Senior Engineer - Rescanned"),
    makeJob("new-fresh-2", daysAgo(2), "New Fresh Engineer"),
  ];

  for (const job of rescanJobs) {
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, job.externalId!);
    const before = getJobByDedupeKey(dedupeKey);
    const freshness = isJobFreshForIngestion(job, before ? { id: before.id } : undefined, company.source_type, 20, now);

    assert.equal(freshness.eligible, true, "Both existing job and new fresh job must be eligible");

    if (freshness.eligible) {
      upsertJob({
        companyId: company.id,
        sourceType: company.source_type,
        dedupeKey,
        job,
        descriptionSections: null,
        sponsorshipMentioned: false,
        sponsorshipPolarity: "none",
        sponsorshipSnippet: null,
        h1bCombinedConfidence: "High",
      });
    }
  }

  const fresh1 = getJobByDedupeKey(`greenhouse:${company.id}:fresh-1`);
  assert.equal(fresh1 !== undefined, true, "Existing job must not be dropped");
  assert.equal(fresh1?.title, "Fresh Senior Engineer - Rescanned", "Existing job must be updated");

  const newFresh2 = getJobByDedupeKey(`greenhouse:${company.id}:new-fresh-2`);
  assert.equal(newFresh2 !== undefined, true, "New fresh job must be inserted");
});
