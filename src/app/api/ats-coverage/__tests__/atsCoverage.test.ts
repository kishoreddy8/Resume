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
let recordScanPartial: typeof import("@/db/queries/companies").recordScanPartial;
let recordScanFailure: typeof import("@/db/queries/companies").recordScanFailure;
let updateCompany: typeof import("@/db/queries/companies").updateCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getAtsCoverageSummary: typeof import("@/db/queries/atsCoverage").getAtsCoverageSummary;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ats-coverage-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db/index");
  ({ createCompany, recordDiscoveryResult, recordScanSuccess, recordScanPartial, recordScanFailure, updateCompany } =
    await import("@/db/queries/companies"));
  ({ upsertJob } = await import("@/db/queries/jobs"));
  ({ getAtsCoverageSummary } = await import("@/db/queries/atsCoverage"));
  getDb();
});

function makeVerifiedCompany(name: string, sourceType: "greenhouse" | "workday" | "lever" = "greenhouse") {
  const company = createCompany({ name, source_type: sourceType, ats_board_token: `token-${name}` });
  recordDiscoveryResult(company.id, {
    status: "VERIFIED", sourceType, atsBoardToken: `token-${name}`,
    discoveredJobsUrl: null, reason: "Manually added.", suspectedAts: null,
  });
  return company;
}

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

// --- deriveHealthReason (indirect, via getAtsCoverageSummary — matches this file's own convention
// of asserting on real summary output rather than reaching into private helpers) -----------------

test("healthy company gets the HEALTHY reason", () => {
  const company = makeVerifiedCompany("Healthy Co");
  recordScanSuccess(company.id);

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "greenhouse")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.healthReasonCode, "HEALTHY");
});

test("never-scanned company gets NEVER_SCANNED, not a fabricated health label", () => {
  const company = makeVerifiedCompany("Never Scanned Co");

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "greenhouse")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.healthReasonCode, "NEVER_SCANNED");
});

test("a genuine transient failure (consecutive_failures>=1) gets TRANSIENT_FAILURE with the real error category", () => {
  const company = makeVerifiedCompany("Flaky Co");
  recordScanFailure(company.id, { errorCategory: "provider_5xx", errorMessage: "500 from board" });

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "greenhouse")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.healthReasonCode, "TRANSIENT_FAILURE");
  assert.match(row.healthReasonLabel, /provider_5xx/);
});

test("a sustained failure streak (down) gets REPEATED_FAILURES", () => {
  const company = makeVerifiedCompany("Down Co");
  recordScanFailure(company.id, { errorCategory: "timeout", errorMessage: "timed out" });
  recordScanFailure(company.id, { errorCategory: "timeout", errorMessage: "timed out" });
  recordScanFailure(company.id, { errorCategory: "timeout", errorMessage: "timed out" });

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "greenhouse")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.healthReasonCode, "REPEATED_FAILURES");
});

test("a genuine per-job data-quality issue (degraded, zero consecutive failures) gets PARTIAL_DATA_QUALITY with the real message — never a fabricated healthy label", () => {
  const company = makeVerifiedCompany("Partial Data Co");
  recordScanSuccess(company.id); // starts clean, like a company that has scanned fine before
  recordScanPartial(company.id, {
    errorCategory: null,
    errorMessage: "2 job location(s) remained UNKNOWN and were not loaded",
  });

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "greenhouse")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.connector_health, "degraded", "a degraded source with active jobs must not be reported healthy");
  assert.equal(row.healthReasonCode, "PARTIAL_DATA_QUALITY");
  assert.equal(row.healthReasonLabel, "2 job location(s) remained UNKNOWN and were not loaded");
});

test("reasonBreakdown on the provider group tallies each company's derived reason", () => {
  // Uses "lever" (untouched by every other test in this file) so the tally isn't polluted by
  // companies other tests created under "greenhouse"/"workday" against the shared temp DB.
  const healthy = makeVerifiedCompany("Breakdown Healthy", "lever");
  recordScanSuccess(healthy.id);
  const down = makeVerifiedCompany("Breakdown Down", "lever");
  recordScanFailure(down.id, { errorCategory: "timeout", errorMessage: "x" });
  recordScanFailure(down.id, { errorCategory: "timeout", errorMessage: "x" });
  recordScanFailure(down.id, { errorCategory: "timeout", errorMessage: "x" });

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "lever")!;
  assert.equal(g.reasonBreakdown.HEALTHY, 1);
  assert.equal(g.reasonBreakdown.REPEATED_FAILURES, 1);
});

// --- is_active exclusion (Finding: COMPANY_WITH_JOB_COUNT_SQL had no is_active filter) -----------

test("an inactive (soft-deleted) company is excluded from every summary bucket", () => {
  const company = makeVerifiedCompany("Inactive Co");
  recordScanSuccess(company.id);
  updateCompany(company.id, { is_active: 0 });

  const summary = getAtsCoverageSummary();
  const g = summary.supported.find((s) => s.sourceType === "greenhouse");
  const found = g?.companies.some((c) => c.id === company.id) ?? false;
  assert.equal(found, false, "an inactive company must not appear in the coverage summary");
});

// --- Regression guard for the blank-connector-card bug: every group the summary can return must
// have a real display label (see src/app/ats-coverage/page.tsx's PROVIDER_LABELS usage) -----------

test("every supported group's sourceType has a real (non-empty) entry in PROVIDER_LABELS", async () => {
  const { PROVIDER_LABELS } = await import("@/lib/ats/providerLabels");
  makeVerifiedCompany("Label Coverage Co", "workday");
  const summary = getAtsCoverageSummary();
  for (const group of summary.supported) {
    const label = PROVIDER_LABELS[group.sourceType];
    assert.ok(label && label.length > 0, `sourceType "${group.sourceType}" is missing a display label`);
  }
});
