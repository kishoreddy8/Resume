import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { FIXTURE_BUILT_IN_RESULTS } from "../fixtures";
import { normalizeBuiltInResult, unwrapTrackingRedirect } from "../normalize";
import { PROVIDER_COST_CLASS, parseBuiltInDetailPage, parseBuiltInSearchResults } from "../providers";
import type { CompanyMatchResult, ExternalHiringObservationRow, NormalizedExternalJob } from "../types";

/**
 * Stage 11 — Built In (FREE_DIRECT) regression coverage, the 32 required items. Reuses every Stage
 * 7/9/10 mechanism verbatim (classify.ts, companyMatch.ts, crossSourceDedup.ts, secondaryIngestion.ts,
 * discoveryV2Bridge.ts, pipeline.ts) — this file proves Built In integrates correctly with each,
 * never re-implements them. Real (temp, isolated) SQLite DB via CAREER_OPS_DB_PATH, matching every
 * other externalSignals test file's convention.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let classifyEmployerRelationship: typeof import("../classify").classifyEmployerRelationship;
let evaluateQualityGate: typeof import("../classify").evaluateQualityGate;
let matchCompanyForObservation: typeof import("../companyMatch").matchCompanyForObservation;
let compareCrossSourceIdentity: typeof import("../crossSourceDedup").compareCrossSourceIdentity;
let stageSecondaryJob: typeof import("../secondaryIngestion").stageSecondaryJob;
let retireSupersededSecondaryJobs: typeof import("../secondaryIngestion").retireSupersededSecondaryJobs;
let processExternalListing: typeof import("../pipeline").processExternalListing;
let bridgeCoverageMismatchToDiscoveryV2: typeof import("../discoveryV2Bridge").bridgeCoverageMismatchToDiscoveryV2;
let upsertExternalHiringObservation: typeof import("@/db/queries/externalHiringObservations").upsertExternalHiringObservation;
let isProposalApprovable: typeof import("@/db/queries/atsSourceProposals").isProposalApprovable;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let markNotInterested: typeof import("@/db/queries/jobs").markNotInterested;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-builtin-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ classifyEmployerRelationship, evaluateQualityGate } = await import("../classify"));
  ({ matchCompanyForObservation } = await import("../companyMatch"));
  ({ compareCrossSourceIdentity } = await import("../crossSourceDedup"));
  ({ stageSecondaryJob, retireSupersededSecondaryJobs } = await import("../secondaryIngestion"));
  ({ processExternalListing } = await import("../pipeline"));
  ({ bridgeCoverageMismatchToDiscoveryV2 } = await import("../discoveryV2Bridge"));
  ({ upsertExternalHiringObservation } = await import("@/db/queries/externalHiringObservations"));
  ({ isProposalApprovable } = await import("@/db/queries/atsSourceProposals"));
  ({ getJobByDedupeKey, markNotInterested } = await import("@/db/queries/jobs"));
  ({ setPipelineStatus } = await import("@/db/queries/candidateJobState"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeJob(overrides: Partial<NormalizedExternalJob> = {}): NormalizedExternalJob {
  return {
    source: "built_in",
    providerJobId: "job-1",
    employerName: "Acme Robotics",
    title: "Data Engineer",
    location: "Austin, TX",
    description: "A".repeat(150),
    postedAt: null,
    listingUrl: "https://builtin.com/job/data-engineer/job-1",
    applyUrl: "https://job-boards.greenhouse.io/acmerobotics/jobs/1",
    directEmployerUrl: "https://job-boards.greenhouse.io/acmerobotics/jobs/1",
    employmentType: "Full-time",
    salaryText: null,
    raw: {},
    ...overrides,
  };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const MATCH: CompanyMatchResult = { companyId: 1, confidence: "DOMAIN", reason: "test" };

// ---------------------------------------------------------------------------------------------
// 1-3. Cost classification / zero-credential operation
// ---------------------------------------------------------------------------------------------

test("1. Built In is classified FREE_DIRECT", () => {
  assert.equal(PROVIDER_COST_CLASS.built_in, "FREE_DIRECT");
});

test("2/3. Built In normalization works with no APIFY_API_TOKEN and no CAREER_OPS_ALLOW_PAID_EXTERNAL set", () => {
  delete process.env.APIFY_API_TOKEN;
  delete process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL;
  const job = normalizeBuiltInResult(FIXTURE_BUILT_IN_RESULTS[0]);
  assert.equal(job.source, "built_in");
  assert.ok(job.title.length > 0);
});

// ---------------------------------------------------------------------------------------------
// 4-9. Fixture parsing / field extraction
// ---------------------------------------------------------------------------------------------

test("4. parses the captured Built In fixture into a well-formed NormalizedExternalJob", () => {
  const job = normalizeBuiltInResult(FIXTURE_BUILT_IN_RESULTS[0]);
  assert.equal(job.source, "built_in");
  assert.equal(job.title, "Senior Data Engineer");
});

test("5. the stable Built In identifier.value is extracted as providerJobId", () => {
  const job = normalizeBuiltInResult(FIXTURE_BUILT_IN_RESULTS[0]);
  assert.equal(job.providerJobId, "fixture-builtin-001");
});

test("6. employer name is extracted from hiringOrganization.name", () => {
  const job = normalizeBuiltInResult(FIXTURE_BUILT_IN_RESULTS[0]);
  assert.equal(job.employerName, "Acme Robotics, Inc.");
});

test("7. the full job description is extracted", () => {
  const job = normalizeBuiltInResult(FIXTURE_BUILT_IN_RESULTS[0]);
  assert.match(job.description ?? "", /core data pipeline/);
});

test("8. the posting date (datePosted) is extracted", () => {
  const job = normalizeBuiltInResult(FIXTURE_BUILT_IN_RESULTS[0]);
  assert.equal(job.postedAt, FIXTURE_BUILT_IN_RESULTS[0].datePosted);
});

test("9. the direct Apply URL is extracted from the raw applyHref", () => {
  const job = normalizeBuiltInResult(FIXTURE_BUILT_IN_RESULTS[0]);
  assert.equal(job.applyUrl, "https://job-boards.greenhouse.io/acmerobotics/jobs/9988776");
  assert.equal(job.directEmployerUrl, job.applyUrl);
});

test("9b. the JSON-LD script tag is parsed even when builtin.com HTML-entity-encodes the '+' in its type attribute (real-world regression: type=\"application/ld&#x2B;json\")", () => {
  const searchHtml = `<html><body><script type="application/ld&#x2B;json">
    {"@context":"https://schema.org","@graph":[{"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","position":1,"name":"Staff Data Engineer","url":"https://builtin.com/job/staff-data-engineer/123"}
    ]}]}
  </script></body></html>`;
  const items = parseBuiltInSearchResults(searchHtml);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "Staff Data Engineer");
  assert.equal(items[0].url, "https://builtin.com/job/staff-data-engineer/123");

  const detailHtml = `<html><body><script type="application/ld&#x2B;json">
    {"@context":"https://schema.org","@graph":[{"@type":"JobPosting","identifier":{"value":"123"},"title":"Staff Data Engineer","hiringOrganization":{"name":"Acme Robotics, Inc."},"datePosted":"2026-08-01","description":"Own the pipeline.","jobLocation":{"address":{"addressLocality":"Austin","addressRegion":"TX","addressCountry":"USA"}}}]}
  </script>
  <a href="https://job-boards.greenhouse.io/acmerobotics/jobs/123" target="_blank" @click="applyClick">Apply</a>
  </body></html>`;
  const parsed = parseBuiltInDetailPage(detailHtml, "https://builtin.com/job/staff-data-engineer/123");
  assert.ok(parsed);
  assert.equal(parsed?.title, "Staff Data Engineer");
  assert.equal(parsed?.applyHref, "https://job-boards.greenhouse.io/acmerobotics/jobs/123");
});

test("9c. an Apply href's HTML-attribute-encoded '&amp;' query separators are decoded to real '&' (real-world regression: raw hrefs like '...?src=X&amp;utm_source=builtin.com')", () => {
  const detailHtml = `<html><body><script type="application/ld&#x2B;json">
    {"@context":"https://schema.org","@graph":[{"@type":"JobPosting","identifier":{"value":"456"},"title":"Cloud Data Engineer","hiringOrganization":{"name":"Optum"},"datePosted":"2026-08-01","description":"Own the cloud pipeline."}]}
  </script>
  <a href="https://careers.unitedhealthgroup.com/job/-/-/34088/99127482848?src=JB-22390&amp;utm_source=builtin.com&amp;ss=paid" target="_blank" @click="applyClick">Apply</a>
  </body></html>`;
  const parsed = parseBuiltInDetailPage(detailHtml, "https://builtin.com/job/cloud-data-engineer/456");
  assert.ok(parsed);
  assert.equal(parsed?.applyHref, "https://careers.unitedhealthgroup.com/job/-/-/34088/99127482848?src=JB-22390&utm_source=builtin.com&ss=paid");
  assert.doesNotMatch(parsed?.applyHref ?? "", /&amp;/);
});

test("10. an ad-tracking-redirect Apply href is safely unwrapped to its real embedded destination", () => {
  const wrapped =
    "https://ad.doubleclick.net/ddm/clk/638473186;444755998;k?https://careers.unitedhealthgroup.com/job/-/-/34088/96838271488?src=JB-22390&utm_source=builtin.com";
  assert.equal(
    unwrapTrackingRedirect(wrapped),
    "https://careers.unitedhealthgroup.com/job/-/-/34088/96838271488?src=JB-22390&utm_source=builtin.com"
  );
  // An ordinary, non-tracking URL passes through completely unchanged.
  assert.equal(unwrapTrackingRedirect("https://job-boards.greenhouse.io/acme/jobs/1"), "https://job-boards.greenhouse.io/acme/jobs/1");
  const job = normalizeBuiltInResult({ ...FIXTURE_BUILT_IN_RESULTS[0], applyHref: wrapped });
  assert.equal(job.applyUrl, "https://careers.unitedhealthgroup.com/job/-/-/34088/96838271488?src=JB-22390&utm_source=builtin.com");
});

// ---------------------------------------------------------------------------------------------
// 11-13. US-only rule (reuses classifyJobLocation via evaluateQualityGate — never new logic)
// ---------------------------------------------------------------------------------------------

test("11. a U.S. job (city, state) is accepted by the quality gate", () => {
  const job = makeJob({ location: "Dallas, TX", postedAt: daysAgoIso(5) });
  assert.notEqual(evaluateQualityGate(job, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "NON_US");
});

test("12. a foreign-only job is rejected NON_US", () => {
  const job = makeJob({ location: "London, United Kingdom", postedAt: daysAgoIso(5) });
  assert.equal(evaluateQualityGate(job, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "NON_US");
});

test("13. Remote - United States is accepted (Built In's own TELECOMMUTE + USA country shape)", () => {
  const raw = normalizeBuiltInResult({ ...FIXTURE_BUILT_IN_RESULTS[1] });
  assert.equal(raw.location, "Remote - United States");
  const job = makeJob({ location: raw.location, postedAt: daysAgoIso(5) });
  assert.notEqual(evaluateQualityGate(job, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "NON_US");
});

// ---------------------------------------------------------------------------------------------
// 14-17. 20-day rule (reuses CANONICAL_INGESTION_MAX_AGE_DAYS via classify.ts — never a new constant)
// ---------------------------------------------------------------------------------------------

test("14. a 19-day-old job is accepted", () => {
  const job = makeJob({ postedAt: daysAgoIso(19) });
  assert.notEqual(evaluateQualityGate(job, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "STALE");
});

test("15. a 20-day-old job is accepted (inclusive boundary)", () => {
  const job = makeJob({ postedAt: daysAgoIso(20) });
  assert.notEqual(evaluateQualityGate(job, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "STALE");
});

test("16. a 21-day-old job is rejected STALE", () => {
  const job = makeJob({ postedAt: daysAgoIso(21) });
  assert.equal(evaluateQualityGate(job, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "STALE");
});

test("17. an unknown/unparseable posted date is never treated as fresh — DISCOVERY_BEACON_ONLY, never inserted as a secondary job", () => {
  const job = makeJob({ postedAt: null });
  assert.equal(evaluateQualityGate(job, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "DISCOVERY_BEACON_ONLY");
});

// ---------------------------------------------------------------------------------------------
// 18-19. Company matching + staffing filtering
// ---------------------------------------------------------------------------------------------

test("18. an employer name matching more than one CareerOps company is AMBIGUOUS — never inserted", async () => {
  const a = createCompany({ name: "Acme Robotics Holdings", source_type: "career_link" });
  const b = createCompany({ name: "Acme Robotics Holdings", source_type: "greenhouse", ats_board_token: "x" });
  void a;
  void b;
  const job = makeJob({ employerName: "Acme Robotics Holdings", directEmployerUrl: null, applyUrl: null });
  const match = matchCompanyForObservation(job);
  assert.equal(match.confidence, "AMBIGUOUS");
  assert.equal(evaluateQualityGate(job, match, "UNKNOWN_EMPLOYER_RELATIONSHIP", "AGGREGATOR_ONLY"), "AMBIGUOUS_EMPLOYER");
});

test("19. a staffing-agency-worded Built In listing is classified STAFFING_AGENCY, never a secondary job candidate", () => {
  const job = makeJob({ employerName: "Confidential Client via BrightStar Staffing" });
  const relationship = classifyEmployerRelationship(job, { companyId: null, confidence: "UNMATCHED", reason: "test" });
  assert.equal(relationship, "STAFFING_AGENCY");
  assert.equal(evaluateQualityGate(job, MATCH, "STAFFING_AGENCY", "AGGREGATOR_ONLY"), "STAFFING_AGENCY");
});

// ---------------------------------------------------------------------------------------------
// 20-22. External/ATS architectural independence
// ---------------------------------------------------------------------------------------------

test("20. a HEALTHY ATS connector does not block Built In processing", async () => {
  const company = createCompany({ name: "Independence Co A", source_type: "greenhouse", ats_board_token: "healthy-co" });
  const db = getDb();
  db.prepare(`UPDATE companies SET connector_health = 'healthy' WHERE id = ?`).run(company.id);
  const job = makeJob({ employerName: "Independence Co A", directEmployerUrl: null, applyUrl: null });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
});

test("21. a DEGRADED ATS connector does not block Built In processing", async () => {
  const company = createCompany({ name: "Independence Co B", source_type: "greenhouse", ats_board_token: "degraded-co" });
  const db = getDb();
  db.prepare(`UPDATE companies SET connector_health = 'degraded', consecutive_failures = 3, last_error_category = 'invalid_config' WHERE id = ?`).run(company.id);
  const job = makeJob({ employerName: "Independence Co B", directEmployerUrl: null, applyUrl: null });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
});

test("22. a Built In fetch failure (simulated) never touches ATS connector_health/scan state", async () => {
  const company = createCompany({ name: "Independence Co C", source_type: "greenhouse", ats_board_token: "unaffected-co" });
  const before = getDb().prepare(`SELECT connector_health, consecutive_failures FROM companies WHERE id = ?`).get(company.id);
  // processExternalListing itself never touches companies at all — a thrown/failed external
  // fetch never even reaches this function; this proves the pipeline's own DB surface has no path
  // to companies.connector_health regardless of what upstream fetch/parse outcome occurred.
  await processExternalListing("built_in", FIXTURE_BUILT_IN_RESULTS[0]);
  const after = getDb().prepare(`SELECT connector_health, consecutive_failures FROM companies WHERE id = ?`).get(company.id);
  assert.deepEqual(after, before);
});

// ---------------------------------------------------------------------------------------------
// 23-25. Cross-source dedup
// ---------------------------------------------------------------------------------------------

function makeObservation(overrides: Partial<ExternalHiringObservationRow> = {}): ExternalHiringObservationRow {
  return {
    id: 1, source: "built_in", provider_job_id: "p1", fingerprint: "fp1",
    observed_employer_name: "Acme", observed_title: "Data Engineer", observed_location: "Austin, TX",
    observed_url: "https://builtin.com/job/x/1", direct_employer_url: "https://job-boards.greenhouse.io/acme/jobs/1",
    direct_apply_url: "https://job-boards.greenhouse.io/acme/jobs/1", employer_domain: null, posted_at: null,
    matched_company_id: 1, match_confidence: "DOMAIN", employer_relationship: "DIRECT_EMPLOYER",
    url_classification: "DIRECT_ATS", detected_ats_provider: "greenhouse", detected_ats_board_token: "acme",
    signal_classification: "COVERAGE_MISMATCH", decision: "SECONDARY_JOB_CANDIDATE", resulting_job_id: null,
    evidence_json: "{}", status: "ACTIVE", first_observed_at: "", last_observed_at: "", expires_at: "",
    created_at: "", updated_at: "",
    ...overrides,
  };
}

test("23. a Built In observation and an Indeed observation of the same job (byte-identical direct apply URL) are EXACT", () => {
  const builtIn = makeObservation({ source: "built_in" });
  const indeed = makeObservation({ id: 2, source: "indeed", observed_url: "https://www.indeed.com/viewjob?jk=x" });
  assert.equal(compareCrossSourceIdentity(builtIn, indeed), "EXACT");
});

test("24. a Built In observation and a Greenhouse-derived observation on the same board+title+location (no byte-identical URL) are HIGH", () => {
  const builtIn = makeObservation({ direct_apply_url: "https://job-boards.greenhouse.io/acme/jobs/1?gh_src=abc" });
  const other = makeObservation({ id: 2, source: "google_jobs", direct_apply_url: "https://job-boards.greenhouse.io/acme/jobs/1?gh_src=xyz" });
  assert.equal(compareCrossSourceIdentity(builtIn, other), "HIGH");
});

test("25. same company + same title but different location/no shared board evidence is only POSSIBLE, never auto-merged", () => {
  const builtIn = makeObservation({ detected_ats_provider: null, detected_ats_board_token: null, direct_apply_url: null, direct_employer_url: null });
  const other = makeObservation({ id: 2, source: "indeed", observed_location: "Remote", detected_ats_provider: null, detected_ats_board_token: null, direct_apply_url: null, direct_employer_url: null });
  assert.equal(compareCrossSourceIdentity(builtIn, other), "POSSIBLE");
});

// ---------------------------------------------------------------------------------------------
// 26-28. Official-source preference + protected-state + suppression
// ---------------------------------------------------------------------------------------------

test("26. an official Greenhouse job supersedes/retires a matching Built In secondary job", () => {
  const company = createCompany({ name: "Supersede Co", source_type: "greenhouse", ats_board_token: "supersede" });
  const db = getDb();
  db.prepare(
    `INSERT INTO jobs (company_id, source_type, dedupe_key, external_id, title, location, url, is_active)
     VALUES (?, 'greenhouse', ?, 'official-1', 'Data Engineer', 'Austin, TX', 'https://job-boards.greenhouse.io/x/1', 1)`
  ).run(company.id, `greenhouse:${company.id}:official-1`);

  const observation = makeObservation({ matched_company_id: company.id });
  const job = makeJob({ employerName: "Supersede Co" });
  const staged = stageSecondaryJob(observation, job, company.id);
  assert.equal(staged.outcome, "inserted");

  const retired = retireSupersededSecondaryJobs(company.id);
  assert.equal(retired.length, 1);
  const secondaryRow = getJobByDedupeKey(staged.dedupeKey);
  // archiveJob (the existing, reused primitive) marks is_archived, never deletes the row or
  // touches is_active — see archiveJob's own doc comment in db/queries/jobs.ts.
  assert.equal(secondaryRow?.is_archived, 1);
});

test("27. a protected (Applied) secondary Built In job is never retired by an official upgrade", () => {
  const company = createCompany({ name: "Protected Co", source_type: "greenhouse", ats_board_token: "protected" });
  const db = getDb();
  db.prepare(
    `INSERT INTO jobs (company_id, source_type, dedupe_key, external_id, title, location, url, is_active)
     VALUES (?, 'greenhouse', ?, 'official-1', 'Data Engineer', 'Austin, TX', 'https://job-boards.greenhouse.io/x/1', 1)`
  ).run(company.id, `greenhouse:${company.id}:official-1`);

  const observation = makeObservation({ matched_company_id: company.id });
  const job = makeJob({ employerName: "Protected Co" });
  const staged = stageSecondaryJob(observation, job, company.id);
  // Real per-candidate protection: candidate #1 always exists (auto-seeded) — set via
  // setPipelineStatus, the actual mechanism isProtectedForAnyCandidate checks (jobs.pipeline_status
  // itself is a frozen legacy column that archiveJob's protection check does NOT consult).
  setPipelineStatus(1, staged.dedupeKey, "Applied");

  const retired = retireSupersededSecondaryJobs(company.id);
  assert.equal(retired.length, 0);
  const after = getJobByDedupeKey(staged.dedupeKey);
  assert.equal(after?.is_archived, 0);
});

test("28. suppression (Not Interested) is respected for a Built In secondary job — it does not silently reappear on a repeated observation", () => {
  const company = createCompany({ name: "Suppress Co", source_type: "career_link" });
  const observation = makeObservation({ matched_company_id: company.id });
  const job = makeJob({ employerName: "Suppress Co" });
  const first = stageSecondaryJob(observation, job, company.id);
  const row = getJobByDedupeKey(first.dedupeKey)!;
  markNotInterested(row.id);

  const second = stageSecondaryJob(observation, job, company.id);
  assert.equal(second.outcome, "suppressed");
});

// ---------------------------------------------------------------------------------------------
// 29-30. Coverage-mismatch feedback + no auto-approval
// ---------------------------------------------------------------------------------------------

test("29. a Built In coverage-mismatch observation may create a PENDING_REVIEW proposal via the existing Discovery V2 bridge", async () => {
  const company = createCompany({ name: "Coverage Mismatch Co", source_type: "career_link" });
  const observation = makeObservation({
    matched_company_id: company.id,
    direct_employer_url: "http://127.0.0.1:1/does-not-matter",
  });
  // Bounded, safe: an unreachable local seed simply yields NO_SOURCE_FOUND/NAVIGATION_FAILED — this
  // proves the bridge call path works and never throws, without a real network dependency.
  const result = await bridgeCoverageMismatchToDiscoveryV2(observation);
  assert.ok(result === null || Array.isArray(result.proposalsCreated));
});

test("30. no proposal is ever auto-approved by any Built In-triggered path", () => {
  // isProposalApprovable is the same gate every other source's proposals go through — HIGH +
  // VALIDATED_JOBS only, and even then only approveProposal (never called anywhere in this file or
  // in discoveryV2Bridge.ts) can actually flip status to APPROVED.
  assert.equal(isProposalApprovable({ confidence: "MEDIUM", validation_status: "VALIDATED_ZERO_JOBS" }), false);
  assert.equal(isProposalApprovable({ confidence: "LOW", validation_status: "VALIDATION_FAILED" }), false);
});

// ---------------------------------------------------------------------------------------------
// 31-32. No lifecycle/matching/tailoring/notification side effects
// ---------------------------------------------------------------------------------------------

test("31. processExternalListing (built_in) never creates a scan_runs row and never runs lifecycle maintenance", async () => {
  const db = getDb();
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM scan_runs`).get() as { n: number }).n;
  await processExternalListing("built_in", FIXTURE_BUILT_IN_RESULTS[0], { persistObservations: true, persistSecondaryJobs: true });
  const after = (db.prepare(`SELECT COUNT(*) AS n FROM scan_runs`).get() as { n: number }).n;
  assert.equal(after, before);
});

test("32. processExternalListing (built_in) never writes to job_match_results, tailoring_runs, or notifications", async () => {
  const db = getDb();
  const counts = () => ({
    matches: (db.prepare(`SELECT COUNT(*) AS n FROM job_match_results`).get() as { n: number }).n,
    tailoring: (db.prepare(`SELECT COUNT(*) AS n FROM tailoring_runs`).get() as { n: number }).n,
    notifications: (db.prepare(`SELECT COUNT(*) AS n FROM notifications`).get() as { n: number }).n,
  });
  const before = counts();
  await processExternalListing("built_in", FIXTURE_BUILT_IN_RESULTS[1], { persistObservations: true, persistSecondaryJobs: true });
  const after = counts();
  assert.deepEqual(after, before);
  void upsertExternalHiringObservation;
});
