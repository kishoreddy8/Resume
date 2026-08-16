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
let recordScanRun: typeof import("@/db/queries/scanRuns").recordScanRun;
let getAtsCoverageSummary: typeof import("@/db/queries/atsCoverage").getAtsCoverageSummary;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ats-coverage-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db/index");
  ({ createCompany, recordDiscoveryResult, recordScanSuccess, recordScanPartial, recordScanFailure, updateCompany } =
    await import("@/db/queries/companies"));
  ({ upsertJob } = await import("@/db/queries/jobs"));
  ({ recordScanRun } = await import("@/db/queries/scanRuns"));
  ({ getAtsCoverageSummary } = await import("@/db/queries/atsCoverage"));
  getDb();
});

let scanRunSeq = 0;
function seedScanRun(companyId: number, overrides: Partial<Parameters<typeof recordScanRun>[0]> = {}) {
  scanRunSeq++;
  return recordScanRun({
    companyId,
    provider: "greenhouse",
    startedAt: `2026-01-01T00:00:${String(scanRunSeq).padStart(2, "0")}.000Z`,
    finishedAt: `2026-01-01T00:00:${String(scanRunSeq).padStart(2, "0")}.500Z`,
    durationMs: 500,
    status: "success",
    jobsDiscovered: 10,
    jobsAdded: 10,
    jobsUpdated: 0,
    jobsUnchanged: 0,
    duplicatesSkipped: 0,
    jobsClosed: 0,
    jobsArchived: 0,
    descriptionFailures: 0,
    unknownLocationCount: 0,
    isSampleScan: false,
    retryCount: 0,
    errorCategory: null,
    errorMessage: null,
    ...overrides,
  });
}

function makeVerifiedCompany(name: string, sourceType: "greenhouse" | "workday" | "lever" | "ashby" = "greenhouse") {
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

test("ATS Health Semantics V2: a genuine complete description-fetch failure (degraded, zero consecutive failures) gets DESCRIPTION_FETCH_FAILURE with the real message — never a fabricated healthy label", () => {
  const company = makeVerifiedCompany("Partial Data Co");
  recordScanSuccess(company.id); // starts clean, like a company that has scanned fine before
  // Under V2, scan.ts only calls recordScanPartial when every discovered job's description fetch
  // failed — a materially broken detail-fetch mechanism, not an isolated per-job gap.
  recordScanPartial(company.id, {
    errorCategory: null,
    errorMessage: "3 job description(s) failed to fetch after retries",
  });

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "greenhouse")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.connector_health, "degraded", "a degraded source with active jobs must not be reported healthy");
  assert.equal(row.healthReasonCode, "DESCRIPTION_FETCH_FAILURE");
  assert.equal(row.healthReasonLabel, "3 job description(s) failed to fetch after retries");
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

// --- ATS Health Semantics V2: operational health and data-quality warnings are genuinely separate
// concerns, derived independently — a company can be HEALTHY and still carry warnings. Uses "ashby"
// (untouched by every other test in this file) to avoid cross-test pollution in the shared temp DB,
// matching this file's own established convention. -----------------------------------------------

test("V2: a HEALTHY company whose latest scan had unknown-location exclusions still shows the warning, without being marked degraded", () => {
  const company = makeVerifiedCompany("Ashby Location Warning Co", "ashby");
  recordScanSuccess(company.id);
  seedScanRun(company.id, { unknownLocationCount: 4, errorMessage: "4 job location(s) remained UNKNOWN and were not loaded" });

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "ashby")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.connector_health, "healthy", "location exclusions must never make an otherwise-healthy connector look degraded");
  assert.equal(row.healthReasonCode, "HEALTHY");
  assert.equal(row.warnings.length, 1);
  assert.equal(row.warnings[0].code, "LOCATION_UNKNOWN");
  assert.match(row.warnings[0].label, /4 job location/);
});

test("V2: a HEALTHY company whose latest scan had a partial (non-total) description failure shows a warning, not a degraded status", () => {
  const company = makeVerifiedCompany("Ashby Description Warning Co", "ashby");
  recordScanSuccess(company.id);
  seedScanRun(company.id, { jobsDiscovered: 10, descriptionFailures: 2, errorMessage: "2 job description(s) failed to fetch after retries" });

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "ashby")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.connector_health, "healthy");
  assert.equal(row.warnings.length, 1);
  assert.equal(row.warnings[0].code, "DESCRIPTION_PARTIAL");
  assert.match(row.warnings[0].label, /2 of 10/);
});

test("V2: a HEALTHY company whose latest scan was a verification sample shows a sample-verification warning", () => {
  const company = makeVerifiedCompany("Ashby Sample Warning Co", "ashby");
  recordScanSuccess(company.id);
  seedScanRun(company.id, { isSampleScan: true, errorMessage: "Verification sample limited to 3 job(s); lifecycle actions disabled" });

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "ashby")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.connector_health, "healthy");
  assert.equal(row.warnings.length, 1);
  assert.equal(row.warnings[0].code, "SAMPLE_VERIFICATION");
});

test("V2: a fully clean scan produces zero warnings", () => {
  const company = makeVerifiedCompany("Ashby Clean Co", "ashby");
  recordScanSuccess(company.id);
  seedScanRun(company.id); // defaults: no description failures, no unknown locations, not a sample

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "ashby")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.connector_health, "healthy");
  assert.deepEqual(row.warnings, []);
});

test("V2: a company with NO scan_runs at all (never scanned) has zero warnings, not a crash", () => {
  const company = makeVerifiedCompany("Ashby Never Scanned Co", "ashby");
  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "ashby")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.healthReasonCode, "NEVER_SCANNED");
  assert.deepEqual(row.warnings, []);
});

test("V2: a genuinely degraded (complete description failure) company also correctly shows no contradictory warning duplication", () => {
  const company = makeVerifiedCompany("Ashby Degraded Co", "ashby");
  recordScanSuccess(company.id);
  recordScanPartial(company.id, { errorCategory: null, errorMessage: "5 job description(s) failed to fetch after retries" });
  seedScanRun(company.id, { status: "partial", jobsDiscovered: 5, descriptionFailures: 5, errorMessage: "5 job description(s) failed to fetch after retries" });

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "ashby")!;
  const row = g.companies.find((c) => c.id === company.id)!;
  assert.equal(row.connector_health, "degraded");
  assert.equal(row.healthReasonCode, "DESCRIPTION_FETCH_FAILURE");
  // A complete (5-of-5) description failure is the operational-health signal itself — it must not
  // ALSO double-count as a DESCRIPTION_PARTIAL warning (deriveWarnings' own isCompleteDescriptionFailure
  // guard excludes exactly this case).
  assert.deepEqual(row.warnings, []);
});

test("V2: warningBreakdown on the provider group tallies warnings independently of healthyCount/degradedCount", () => {
  // Asserts on the DELTA, not an absolute count — this file's own "ashby" group accumulates
  // companies across every V2 test above (same established convention as the pre-existing
  // reasonBreakdown test's own isolation choice), so only a before/after comparison is order-safe.
  const before = getAtsCoverageSummary().supported.find((s) => s.sourceType === "ashby")?.warningBreakdown.LOCATION_UNKNOWN ?? 0;

  const healthyWithWarning = makeVerifiedCompany("Ashby Breakdown Warning Co", "ashby");
  recordScanSuccess(healthyWithWarning.id);
  seedScanRun(healthyWithWarning.id, { unknownLocationCount: 1, errorMessage: "1 job location(s) remained UNKNOWN and were not loaded" });

  const cleanHealthy = makeVerifiedCompany("Ashby Breakdown Clean Co", "ashby");
  recordScanSuccess(cleanHealthy.id);
  seedScanRun(cleanHealthy.id);

  const g = getAtsCoverageSummary().supported.find((s) => s.sourceType === "ashby")!;
  assert.equal(g.warningBreakdown.LOCATION_UNKNOWN, before + 1, "exactly the one new company with a location warning increments the tally");
  assert.ok(g.healthyCount >= 2, "both companies remain counted as healthy regardless of the warning");
});
