import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * Structured Job Intelligence integration tests — real, temporary, isolated SQLite file via
 * CAREER_OPS_DB_PATH (see src/db/index.ts), never touching data/app.db. Same convention as
 * src/db/queries/__tests__/h1bSponsors.test.ts. See src/lib/jobIntel/__tests__/ for the
 * pure-function extraction tests that don't need a database at all.
 *
 * Run with: npm test
 */

let tmpDir: string;

let getDb: typeof import("../../index").getDb;
let createCompany: typeof import("../companies").createCompany;
let upsertJob: typeof import("../jobs").upsertJob;
let getJob: typeof import("../jobs").getJob;
let upsertJobIntel: typeof import("../jobIntel").upsertJobIntel;
let getJobSkills: typeof import("../jobIntel").getJobSkills;
let getJobCertifications: typeof import("../jobIntel").getJobCertifications;
let dedupeKeyForAts: typeof import("../../../lib/dedupe").dedupeKeyForAts;
let extractJobIntel: typeof import("../../../lib/jobIntel/extractJobIntel").extractJobIntel;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-jobintel-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("../../index"));
  ({ createCompany } = await import("../companies"));
  ({ upsertJob, getJob } = await import("../jobs"));
  ({ upsertJobIntel, getJobSkills, getJobCertifications } = await import("../jobIntel"));
  ({ dedupeKeyForAts } = await import("../../../lib/dedupe"));
  ({ extractJobIntel } = await import("../../../lib/jobIntel/extractJobIntel"));

  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JD_HTML = `
  <h2>Required Qualifications</h2>
  <ul>
    <li>5+ years of experience with Python and SQL.</li>
    <li>Bachelor's degree in Computer Science or equivalent experience.</li>
  </ul>
  <h2>Nice to Have</h2>
  <ul><li>Experience with Snowflake preferred.</li></ul>
`;

let seedCounter = 0;

function seedJob() {
  seedCounter += 1;
  const company = createCompany({ name: `Acme Data Co ${seedCounter}`, source_type: "greenhouse" });
  const dedupeKey = dedupeKeyForAts("greenhouse", company.id, `job-${seedCounter}`);
  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: `job-${seedCounter}`,
      title: "Senior Data Engineer",
      location: "Austin, TX",
      department: "Engineering",
      url: `https://example.com/job-${seedCounter}`,
      descriptionHtml: JD_HTML,
      descriptionText: JD_HTML.replace(/<[^>]+>/g, " "),
      employmentType: "Full-time",
      workplaceType: "Hybrid",
      salaryText: "$140,000 - $170,000",
      postedAt: null,
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  const row = getDb().prepare("SELECT id FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as { id: number };
  return getJob(row.id)!;
}

function getJobRow(jobId: number) {
  return getJob(jobId)!;
}

test("upsertJobIntel writes scalar fields and skill/certification rows", () => {
  const company = createCompany({ name: "Beta Corp", source_type: "greenhouse" });
  const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "beta-1");
  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "beta-1",
      title: "Senior Data Engineer",
      location: "Austin, TX",
      department: "Engineering",
      url: "https://example.com/beta-1",
      descriptionHtml: JD_HTML,
      descriptionText: JD_HTML.replace(/<[^>]+>/g, " "),
      employmentType: "Full-time",
      workplaceType: "Hybrid",
      salaryText: "$140,000 - $170,000",
      postedAt: null,
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  const row = getDb().prepare("SELECT id FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as { id: number };
  const jobId = row.id;

  const intel = extractJobIntel({
    title: "Senior Data Engineer",
    descriptionText: JD_HTML.replace(/<[^>]+>/g, " "),
    descriptionHtml: JD_HTML,
    employmentTypeNative: "Full-time",
    workplaceTypeNative: "Hybrid",
    locationNative: "Austin, TX",
    salaryTextNative: "$140,000 - $170,000",
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
  });
  upsertJobIntel(jobId, intel);

  const job = getJobRow(jobId);
  assert.equal(job.seniority, "Senior");
  assert.equal(job.employment_type_normalized, "Full-Time");
  assert.equal(job.workplace_type_normalized, "Hybrid");
  assert.equal(job.salary_min, 140000);
  assert.equal(job.salary_max, 170000);
  assert.equal(job.structured_extraction_version, intel.extractionVersion);
  assert.ok(job.structured_extracted_at);

  const skills = getJobSkills(jobId);
  assert.ok(skills.some((s) => s.skill_name === "Python" && s.requirement_level === "Required"));
  assert.ok(skills.some((s) => s.skill_name === "Snowflake" && s.requirement_level === "Preferred"));
});

test("re-extraction is idempotent: no duplicate skill/certification rows on a re-run", () => {
  const job = seedJob();
  const intel = extractJobIntel({
    title: "Senior Data Engineer",
    descriptionText: JD_HTML.replace(/<[^>]+>/g, " "),
    descriptionHtml: JD_HTML,
    employmentTypeNative: "Full-time",
    workplaceTypeNative: "Hybrid",
    locationNative: "Austin, TX",
    salaryTextNative: "$140,000 - $170,000",
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
  });

  upsertJobIntel(job.id, intel);
  const firstCount = getJobSkills(job.id).length;
  upsertJobIntel(job.id, intel);
  const secondCount = getJobSkills(job.id).length;

  assert.equal(firstCount, secondCount, "re-running extraction on the same JD must not duplicate skill rows");
  assert.ok(firstCount > 0);
});

test("re-extraction on a changed JD replaces stale skill values rather than accumulating them", () => {
  const job = seedJob();
  const firstIntel = extractJobIntel({
    title: "Senior Data Engineer",
    descriptionText: JD_HTML.replace(/<[^>]+>/g, " "),
    descriptionHtml: JD_HTML,
    employmentTypeNative: "Full-time",
    workplaceTypeNative: "Hybrid",
    locationNative: "Austin, TX",
    salaryTextNative: "$140,000 - $170,000",
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
  });
  upsertJobIntel(job.id, firstIntel);
  assert.ok(getJobSkills(job.id).some((s) => s.skill_name === "Python"));

  const changedHtml = "<h2>Required Qualifications</h2><ul><li>Must have Kubernetes experience.</li></ul>";
  const secondIntel = extractJobIntel({
    title: "Senior Data Engineer",
    descriptionText: changedHtml.replace(/<[^>]+>/g, " "),
    descriptionHtml: changedHtml,
    employmentTypeNative: "Full-time",
    workplaceTypeNative: "Hybrid",
    locationNative: "Austin, TX",
    salaryTextNative: null,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
  });
  upsertJobIntel(job.id, secondIntel);

  const skills = getJobSkills(job.id);
  assert.ok(!skills.some((s) => s.skill_name === "Python"), "stale skill from the old JD should be gone");
  assert.ok(skills.some((s) => s.skill_name === "Kubernetes"));
});

test("re-extraction preserves pipeline_status, notes, tags, and pinned untouched", () => {
  const job = seedJob();
  const db = getDb();
  db.prepare("UPDATE jobs SET pipeline_status = 'Applied', notes = 'great fit', tags = '[\"referral\"]', pinned = 1 WHERE id = ?").run(job.id);

  const intel = extractJobIntel({
    title: "Senior Data Engineer",
    descriptionText: JD_HTML.replace(/<[^>]+>/g, " "),
    descriptionHtml: JD_HTML,
    employmentTypeNative: "Full-time",
    workplaceTypeNative: "Hybrid",
    locationNative: "Austin, TX",
    salaryTextNative: "$140,000 - $170,000",
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
  });
  upsertJobIntel(job.id, intel);

  const updated = getJobRow(job.id);
  assert.equal(updated.pipeline_status, "Applied");
  assert.equal(updated.notes, "great fit");
  assert.equal(updated.tags, '["referral"]');
  assert.equal(updated.pinned, 1);
});

test("deleting a job cascades to its job_skills and job_certifications rows", () => {
  const job = seedJob();
  const intel = extractJobIntel({
    title: "Senior Data Engineer",
    descriptionText: JD_HTML.replace(/<[^>]+>/g, " "),
    descriptionHtml: JD_HTML,
    employmentTypeNative: "Full-time",
    workplaceTypeNative: "Hybrid",
    locationNative: "Austin, TX",
    salaryTextNative: "$140,000 - $170,000",
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
  });
  upsertJobIntel(job.id, intel);
  assert.ok(getJobSkills(job.id).length > 0);

  getDb().prepare("DELETE FROM jobs WHERE id = ?").run(job.id);

  assert.equal(getJobSkills(job.id).length, 0);
  assert.equal(getJobCertifications(job.id).length, 0);
});
