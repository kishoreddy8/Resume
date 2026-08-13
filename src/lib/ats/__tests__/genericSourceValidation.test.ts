import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedJob } from "@/types";

let tmpDir: string;
let getDb: typeof import("../../../db").getDb;
let createCompany: typeof import("../../../db/queries/companies").createCompany;
let updateCompanyDomainIdentity: typeof import("../../../db/queries/companies").updateCompanyDomainIdentity;
let listCandidates: typeof import("../genericSourceValidation").listGenericSourceValidationCandidates;
let validateSource: typeof import("../genericSourceValidation").validateGenericSource;
let listGenericReady: typeof import("../../../db/queries/organizationRegistry").listGenericAdditiveReadyCompanies;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-generic-validation-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../../db"));
  ({ createCompany, updateCompanyDomainIdentity } = await import("../../../db/queries/companies"));
  ({ listGenericSourceValidationCandidates: listCandidates, validateGenericSource: validateSource } =
    await import("../genericSourceValidation"));
  ({ listGenericAdditiveReadyCompanies: listGenericReady } =
    await import("../../../db/queries/organizationRegistry"));
});

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("generic validation stores three U.S. evidence samples outside jobs and approves additive-only loading", async () => {
  const company = createCompany({
    name: "Generic Careers Inc.",
    source_type: "career_link",
    career_page_url: "https://generic.example/careers",
  });
  updateCompanyDomainIdentity(company.id, {
    verifiedDomain: "generic.example",
    domainIdentityStatus: "VERIFIED",
  });
  const db = getDb();
  db.prepare(
    `UPDATE companies SET resolution_status='GENERIC_SUPPORTED', discovered_jobs_url=career_page_url
     WHERE id=?`
  ).run(company.id);
  db.prepare(
    `UPDATE job_sources
     SET resolution_status='GENERIC_SUPPORTED', source_url='https://generic.example/careers'
     WHERE legacy_company_id=?`
  ).run(company.id);

  const [candidate] = listCandidates(10);
  assert.ok(candidate);
  const jobs = [1, 2, 3, 4].map((id): NormalizedJob => ({
    externalId: null,
    title: `Data Engineer ${id}`,
    location: id === 4 ? "Toronto, Canada" : "Austin, TX, United States",
    department: null,
    url: `https://generic.example/jobs/${id}`,
    descriptionHtml: "<p>Build data systems.</p>",
    descriptionText: "Build data systems.",
    employmentType: null,
    workplaceType: null,
    salaryText: null,
    postedAt: "2026-08-01",
    raw: { fixture: id },
  }));
  const result = await validateSource(candidate, {
    scraper: async () => ({ jobs, extractorType: "JSON_LD" }),
  });
  assert.equal(result.outcome, "READY_ADDITIVE");
  assert.equal(result.samplesSaved, 3);
  assert.equal(result.canCloseMissing, false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 0);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM job_source_validation_samples").get() as { n: number }).n,
    3
  );
  const run = db.prepare(
    `SELECT outcome, can_ingest, can_close_missing, pagination_verified, completeness_verified
     FROM job_source_validation_runs`
  ).get() as Record<string, unknown>;
  assert.deepEqual(run, {
    outcome: "READY_ADDITIVE",
    can_ingest: 1,
    can_close_missing: 0,
    pagination_verified: 0,
    completeness_verified: 0,
  });
  const source = db.prepare(
    "SELECT review_status, is_authoritative FROM job_sources WHERE legacy_company_id=?"
  ).get(company.id) as { review_status: string; is_authoritative: number };
  assert.deepEqual(source, { review_status: "APPROVED", is_authoritative: 0 });
  assert.deepEqual(listGenericReady().map((row) => row.id), [company.id]);
});
