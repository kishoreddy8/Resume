import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * ATS coverage summary — derived-only aggregation over companies/jobs (no new table). Same
 * isolated-temp-DB pattern as the other db/queries tests.
 */

let tmpDir: string;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let recordDiscoveryResult: typeof import("@/db/queries/companies").recordDiscoveryResult;
let recordScanSuccess: typeof import("@/db/queries/companies").recordScanSuccess;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getAtsCoverageSummary: typeof import("@/db/queries/atsCoverage").getAtsCoverageSummary;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ats-coverage-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db/index");
  ({ createCompany, recordDiscoveryResult, recordScanSuccess } = await import("@/db/queries/companies"));
  ({ upsertJob } = await import("@/db/queries/jobs"));
  ({ getAtsCoverageSummary } = await import("@/db/queries/atsCoverage"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("groups a supported ATS company under its source type with a job count and connector health", () => {
  const company = createCompany({ name: "Supported Co", source_type: "greenhouse", ats_board_token: "supportedco" });
  // Mirrors what POST /api/companies' explicit-schema branch does for a manually-added ATS company
  // (route.ts) — without this, resolution_status stays at its schema default of UNRESOLVED.
  recordDiscoveryResult(company.id, {
    status: "VERIFIED", sourceType: "greenhouse", atsBoardToken: "supportedco",
    discoveredJobsUrl: null, reason: "Manually added.", suspectedAts: null,
  });
  recordScanSuccess(company.id);
  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey: `greenhouse:${company.id}:job-1`,
    job: {
      externalId: "job-1", title: "Engineer", location: null, department: null,
      url: "https://boards.greenhouse.io/supportedco/jobs/1", descriptionHtml: null, descriptionText: "desc",
      employmentType: null, workplaceType: null, salaryText: null, postedAt: null, raw: {},
    },
    descriptionSections: null, sponsorshipMentioned: false, sponsorshipPolarity: "none",
    sponsorshipSnippet: null, h1bCombinedConfidence: "Unknown",
  });

  const summary = getAtsCoverageSummary();
  const greenhouse = summary.supported.find((g) => g.sourceType === "greenhouse");
  assert.ok(greenhouse);
  assert.equal(greenhouse!.companyCount, 1);
  assert.equal(greenhouse!.jobCount, 1);
  assert.equal(greenhouse!.healthyCount, 1);
});

test("groups NEEDS_ADAPTER companies by suspected platform, not individually", () => {
  const a = createCompany({ name: "Blocked A", source_type: "career_link", career_page_url: "https://a.example/careers" });
  const b = createCompany({ name: "Blocked B", source_type: "career_link", career_page_url: "https://b.example/careers" });
  for (const c of [a, b]) {
    recordDiscoveryResult(c.id, {
      status: "NEEDS_ADAPTER", sourceType: null, atsBoardToken: null,
      discoveredJobsUrl: `${c.career_page_url}/jobs`, reason: "Found an embedded SuccessFactors link — no connector yet.",
      suspectedAts: "SuccessFactors",
    });
  }

  const summary = getAtsCoverageSummary();
  assert.equal(summary.needsAdapter.length, 1, "both companies must fold into ONE SuccessFactors group");
  assert.equal(summary.needsAdapter[0].suspectedAts, "SuccessFactors");
  assert.equal(summary.needsAdapter[0].companyCount, 2);
});

test("unresolved includes both UNRESOLVED and FAILED_TEMPORARY, generic stays separate", () => {
  const unresolved = createCompany({ name: "Unresolved Co", source_type: "career_link", career_page_url: "https://u.example/careers" });
  recordDiscoveryResult(unresolved.id, {
    status: "UNRESOLVED", sourceType: null, atsBoardToken: null, discoveredJobsUrl: null,
    reason: "nothing found", suspectedAts: null,
  });
  const generic = createCompany({ name: "Generic Co", source_type: "career_link", career_page_url: "https://g.example/careers" });
  recordDiscoveryResult(generic.id, {
    status: "GENERIC_SUPPORTED", sourceType: null, atsBoardToken: null, discoveredJobsUrl: "https://g.example/careers/jobs",
    reason: "generic scrape", suspectedAts: null,
  });

  const summary = getAtsCoverageSummary();
  assert.equal(summary.unresolved.length, 1);
  assert.equal(summary.unresolved[0].name, "Unresolved Co");
  assert.equal(summary.generic.length, 1);
  assert.equal(summary.generic[0].name, "Generic Co");
});
