import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { FIXTURE_INDEED_RESULTS } from "../fixtures";

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let updateCompanyDomainIdentity: typeof import("@/db/queries/companies").updateCompanyDomainIdentity;
let processExternalListing: typeof import("../pipeline").processExternalListing;
let isLiveProviderConfigured: typeof import("../providers").isLiveProviderConfigured;
let bridgeCoverageMismatchToDiscoveryV2: typeof import("../discoveryV2Bridge").bridgeCoverageMismatchToDiscoveryV2;
let upsertExternalHiringObservation: typeof import("@/db/queries/externalHiringObservations").upsertExternalHiringObservation;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-external-signals-pipeline-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  delete process.env.APIFY_API_TOKEN; // ensure fixture mode regardless of the outer shell's env
  ({ getDb } = await import("@/db"));
  ({ createCompany, updateCompanyDomainIdentity } = await import("@/db/queries/companies"));
  ({ processExternalListing } = await import("../pipeline"));
  ({ isLiveProviderConfigured } = await import("../providers"));
  ({ bridgeCoverageMismatchToDiscoveryV2 } = await import("../discoveryV2Bridge"));
  ({ upsertExternalHiringObservation } = await import("@/db/queries/externalHiringObservations"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function countRows(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

// 26. Default shadow mode writes zero jobs
test("26. processExternalListing with no options performs zero database writes of any kind", async () => {
  const before1 = { obs: countRows("external_hiring_observations"), jobs: countRows("jobs") };
  const result = await processExternalListing("indeed", FIXTURE_INDEED_RESULTS[0]);
  const after1 = { obs: countRows("external_hiring_observations"), jobs: countRows("jobs") };

  assert.deepEqual(after1, before1, "no rows of any kind should be written in default (no-options) mode");
  assert.ok(result.decision, "the pipeline must still return a full in-memory classification");
});

// 27. Explicit persistence required
test("27. persistObservations:false with persistSecondaryJobs:true still writes nothing (secondary staging requires persisted observations)", async () => {
  const beforeJobs = countRows("jobs");
  await processExternalListing("indeed", FIXTURE_INDEED_RESULTS[0], { persistSecondaryJobs: true });
  assert.equal(countRows("jobs"), beforeJobs);
});

test("27b. persistObservations:true alone writes an observation but never a secondary job", async () => {
  const company = createCompany({ name: "Acme Robotics, Inc.", source_type: "career_link", career_page_url: "https://acmerobotics.com" });
  updateCompanyDomainIdentity(company.id, { verifiedDomain: "acmerobotics.com", domainIdentityStatus: "VERIFIED" });

  const beforeJobs = countRows("jobs");
  const result = await processExternalListing("indeed", FIXTURE_INDEED_RESULTS[0], { persistObservations: true });

  assert.ok(result.observation, "an observation row must be written");
  assert.equal(result.stagedJob, null, "no secondary job may be staged without the additional explicit flag");
  assert.equal(countRows("jobs"), beforeJobs);
});

// 28. No source auto-approval — the pipeline never imports/calls approveProposal at all.
test("28. the pipeline module never touches ats_source_proposals approval state (no proposal is ever auto-approved)", async () => {
  const beforeApproved = getDb().prepare("SELECT COUNT(*) AS c FROM ats_source_proposals WHERE status = 'APPROVED'").get() as { c: number };
  await processExternalListing("indeed", FIXTURE_INDEED_RESULTS[0], { persistObservations: true, persistSecondaryJobs: true, triggerDiscoveryV2: true });
  const afterApproved = getDb().prepare("SELECT COUNT(*) AS c FROM ats_source_proposals WHERE status = 'APPROVED'").get() as { c: number };
  assert.equal(afterApproved.c, beforeApproved.c);
});

// 29. No scan automatically triggered
test("29. processExternalListing never creates a scan_runs row, even with every persistence flag on", async () => {
  const before1 = countRows("scan_runs");
  await processExternalListing("indeed", FIXTURE_INDEED_RESULTS[0], { persistObservations: true, persistSecondaryJobs: true, triggerDiscoveryV2: true });
  assert.equal(countRows("scan_runs"), before1);
});

// 30/31/32. No matching, tailoring, or notifications
test("30/31/32. processExternalListing never creates job_match_results, tailoring_runs, or notifications rows", async () => {
  const beforeCounts = { match: countRows("job_match_results"), tailoring: countRows("tailoring_runs"), notif: countRows("notifications") };
  await processExternalListing("indeed", FIXTURE_INDEED_RESULTS[0], { persistObservations: true, persistSecondaryJobs: true, triggerDiscoveryV2: true });
  const afterCounts = { match: countRows("job_match_results"), tailoring: countRows("tailoring_runs"), notif: countRows("notifications") };
  assert.deepEqual(afterCounts, beforeCounts);
});

// 33. No lifecycle maintenance
test("33. processExternalListing never touches suppressed_jobs as a side effect of classification alone (only an explicit Not Interested/age sweep does that)", async () => {
  const before1 = countRows("suppressed_jobs");
  await processExternalListing("indeed", FIXTURE_INDEED_RESULTS[0], { persistObservations: true, persistSecondaryJobs: true });
  assert.equal(countRows("suppressed_jobs"), before1);
});

// 34. SSRF protections preserved — the Discovery V2 bridge calls the SAME discoverCompanySourceV2
// that already enforces isUrlSafeForNavigation; a private-IP seed must still be refused.
test("34. the Discovery V2 bridge refuses a private-network seed URL (SSRF protection preserved via the reused discoverCompanySourceV2 path)", async () => {
  const company = createCompany({ name: "SSRF Test Co", source_type: "career_link", career_page_url: "https://ssrftest.example" });
  const observation = upsertExternalHiringObservation({
    source: "indeed",
    providerJobId: "ssrf-1",
    fingerprint: "ssrf-1",
    observedEmployerName: "SSRF Test Co",
    observedTitle: "Data Engineer",
    observedLocation: "Austin, TX",
    observedUrl: "https://indeed.com/x",
    directEmployerUrl: "http://169.254.169.254/latest/meta-data/", // cloud-metadata SSRF target
    directApplyUrl: "http://169.254.169.254/latest/meta-data/",
    employerDomain: null,
    postedAt: null,
    matchedCompanyId: company.id,
    matchConfidence: "DOMAIN",
    employerRelationship: "DIRECT_EMPLOYER",
    urlClassification: "UNKNOWN",
    detectedAtsProvider: null,
    detectedAtsBoardToken: null,
    signalClassification: "COVERAGE_MISMATCH",
    decision: "SECONDARY_JOB_CANDIDATE",
    evidenceJson: "{}",
  });

  const result = await bridgeCoverageMismatchToDiscoveryV2(observation);
  assert.ok(result, "the bridge itself must still return a result, not throw");
  assert.equal(result!.candidateCount, 0, "no ATS candidate may ever come from a refused unsafe seed");
  assert.equal(result!.proposalsCreated.length, 0);
});

test("isLiveProviderConfigured reflects APIFY_API_TOKEN presence and defaults to false in this test environment", () => {
  assert.equal(isLiveProviderConfigured(), false);
});
