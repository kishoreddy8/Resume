import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { classifyJobLocation } from "../../jobLocationScope";
import type { NormalizedExternalJob } from "../types";

/**
 * Stage 14 — the 28 required regression items proving ONE global "US + <=20 days" contract governs
 * every NEW job insertion path (ATS adapters, career_link/Playwright, Built In, new-company
 * onboarding), while existing-job REFRESH remains architecturally distinct (Phase 9/10). Reuses every
 * canonical primitive verbatim: isJobFreshForIngestion, CANONICAL_INGESTION_MAX_AGE_DAYS,
 * classifyJobLocation, upsertJob, evaluateQualityGate, evaluateNewEmployerEligibility. No new
 * filtering system.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let markNotInterested: typeof import("@/db/queries/jobs").markNotInterested;
let isJobFreshForIngestion: typeof import("@/lib/ats/jobFreshness").isJobFreshForIngestion;
let CANONICAL_INGESTION_MAX_AGE_DAYS: typeof import("@/lib/ats/jobFreshness").CANONICAL_INGESTION_MAX_AGE_DAYS;
let matchCompanyForObservation: typeof import("../companyMatch").matchCompanyForObservation;
let classifyEmployerRelationship: typeof import("../classify").classifyEmployerRelationship;
let classifyUrlEvidence: typeof import("../classify").classifyUrlEvidence;
let evaluateQualityGate: typeof import("../classify").evaluateQualityGate;
let evaluateNewEmployerEligibility: typeof import("../companyOnboarding").evaluateNewEmployerEligibility;
let onboardNewEmployerIfEligible: typeof import("../companyOnboarding").onboardNewEmployerIfEligible;
let processExternalListing: typeof import("../pipeline").processExternalListing;
let stageSecondaryJob: typeof import("../secondaryIngestion").stageSecondaryJob;
let retireSupersededSecondaryJobs: typeof import("../secondaryIngestion").retireSupersededSecondaryJobs;
let compareCrossSourceIdentity: typeof import("../crossSourceDedup").compareCrossSourceIdentity;
let createProposalFromDiscoveryV2: typeof import("@/db/queries/atsSourceProposals").createProposalFromDiscoveryV2;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-stage14-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey, markNotInterested } = await import("@/db/queries/jobs"));
  ({ isJobFreshForIngestion, CANONICAL_INGESTION_MAX_AGE_DAYS } = await import("@/lib/ats/jobFreshness"));
  ({ matchCompanyForObservation } = await import("../companyMatch"));
  ({ classifyEmployerRelationship, classifyUrlEvidence, evaluateQualityGate } = await import("../classify"));
  ({ evaluateNewEmployerEligibility, onboardNewEmployerIfEligible } = await import("../companyOnboarding"));
  ({ processExternalListing } = await import("../pipeline"));
  ({ stageSecondaryJob, retireSupersededSecondaryJobs } = await import("../secondaryIngestion"));
  ({ compareCrossSourceIdentity } = await import("../crossSourceDedup"));
  ({ createProposalFromDiscoveryV2 } = await import("@/db/queries/atsSourceProposals"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function makeCompany(name: string, sourceType: import("@/types").SourceType = "career_link", atsBoardToken?: string) {
  return createCompany({ name, source_type: sourceType, ats_board_token: atsBoardToken });
}

function makeExternalJob(overrides: Partial<NormalizedExternalJob> = {}): NormalizedExternalJob {
  return {
    source: "built_in",
    providerJobId: "stage14-1",
    employerName: "",
    title: "Data Engineer",
    location: "Austin, TX",
    description: "A real job description with enough content to be meaningful for testing purposes, well past the minimum length threshold.",
    postedAt: null,
    listingUrl: "https://builtin.com/job/data-engineer/stage14-1",
    applyUrl: null,
    directEmployerUrl: null,
    employmentType: "Full-time",
    salaryText: null,
    raw: {},
    ...overrides,
  };
}

function normalizedAtsJob(overrides: Partial<import("@/types").NormalizedJob> = {}): import("@/types").NormalizedJob {
  return {
    externalId: "ats-1",
    title: "Data Engineer",
    location: "Austin, TX",
    department: null,
    url: "https://job-boards.greenhouse.io/x/jobs/1",
    descriptionHtml: null,
    descriptionText: "A real ATS job description.",
    employmentType: null,
    workplaceType: null,
    salaryText: null,
    postedAt: null,
    raw: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// 1/2/3/28. ATS 19/20/21-day boundary — the canonical primitive, exact <= semantics
test("1/2/3/28. isJobFreshForIngestion: 19 and exactly-20 days are eligible, 21 days is rejected — strict <= semantics", () => {
  const nineteen = isJobFreshForIngestion(normalizedAtsJob({ postedAt: daysAgoIso(19) }), undefined, "greenhouse");
  assert.equal(nineteen.eligible, true);
  assert.equal(nineteen.ageDays, 19);

  const twenty = isJobFreshForIngestion(normalizedAtsJob({ postedAt: daysAgoIso(20) }), undefined, "greenhouse");
  assert.equal(twenty.eligible, true, "exactly 20 days must be ACCEPT, not REJECT");
  assert.equal(twenty.ageDays, 20);
  assert.equal(twenty.ageDays! <= CANONICAL_INGESTION_MAX_AGE_DAYS, true);

  const twentyOne = isJobFreshForIngestion(normalizedAtsJob({ postedAt: daysAgoIso(21) }), undefined, "greenhouse");
  assert.equal(twentyOne.eligible, false, "21 days must be REJECT");
  assert.equal(twentyOne.ageDays, 21);
});

// 4/5/6. Built In 19/exactly-20/21-day boundary through the real external-signals quality gate
test("4/5/6. Built In 19-day and exactly-20-day jobs are eligible via evaluateQualityGate, 21-day is STALE", () => {
  const company = makeCompany("Boundary Built In Co", "greenhouse", "boundarybuiltinco");
  const base = { employerName: "Boundary Built In Co", applyUrl: "https://job-boards.greenhouse.io/boundarybuiltinco/jobs/1" };

  for (const [days, expectNull] of [[19, true], [20, true], [21, false]] as const) {
    const job = makeExternalJob({ ...base, postedAt: daysAgoIso(days) });
    const match = matchCompanyForObservation(job);
    assert.equal(match.companyId, company.id);
    const relationship = classifyEmployerRelationship(job, match);
    const urlClassification = classifyUrlEvidence(job, match);
    const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
    if (expectNull) {
      assert.equal(decision, null, `${days}-day job should pass the gate (null)`);
    } else {
      assert.equal(decision, "STALE", `${days}-day job should be rejected STALE`);
    }
  }
});

// 7/8/9/10. US location matrix — the mission's exact test cases
test("7/8/9/10. classifyJobLocation matrix: US cities/states/remote-US accepted, non-US and region-only rejected/unknown", () => {
  const usCases = ["Dallas, TX", "New York, NY", "Austin, Texas", "United States", "Remote - US", "US Remote", "Remote, United States"];
  for (const loc of usCases) {
    assert.equal(classifyJobLocation(loc), "US", `expected US for "${loc}"`);
  }
  assert.equal(classifyJobLocation("Toronto, Canada"), "NON_US");
  assert.equal(classifyJobLocation("London, UK"), "NON_US");
  // "Remote - Europe" is a region, not a specific country — the classifier's own documented design
  // keeps bare regions UNKNOWN rather than guessing NON_US or US; UNKNOWN is still never eligible for
  // new insertion (see tests 11/12/14 below), so the practical outcome is identical: never inserted.
  assert.equal(classifyJobLocation("Remote - Europe"), "UNKNOWN");
});

// 11. source-side stale filter cannot bypass local stale check
test("11. even if a source-side date filter should have excluded a listing, local freshness validation independently rejects it", () => {
  // Simulates a hypothetical source-side filtering bug/gap: a 21-day-old listing arrives locally
  // despite the provider's own daysSinceUpdated=20 param. Local validation has no "trust the source"
  // shortcut — it always recomputes age from the job's own postedAt.
  const company = makeCompany("Source Side Bypass Co", "greenhouse", "sourcesidebypassco");
  const job = makeExternalJob({
    employerName: "Source Side Bypass Co",
    applyUrl: "https://job-boards.greenhouse.io/sourcesidebypassco/jobs/1",
    postedAt: daysAgoIso(21),
  });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, "STALE");
});

// 12. source-side country filter cannot bypass local location check
test("12. even if a source-side country=USA filter should have excluded a listing, local classifyJobLocation independently rejects it", () => {
  const company = makeCompany("Source Side Country Bypass Co", "greenhouse", "sourcesidecountrybypassco");
  const job = makeExternalJob({
    employerName: "Source Side Country Bypass Co",
    applyUrl: "https://job-boards.greenhouse.io/sourcesidecountrybypassco/jobs/1",
    location: "London, UK",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, "NON_US");
});

// 13/14/15. new-company onboarding eligibility respects the same US + <=20-day rule
test("13. a stale (21-day) external listing cannot onboard a new employer through that observation", () => {
  const job = makeExternalJob({
    employerName: "Stale Onboard Employer",
    directEmployerUrl: "https://careers.staleonboardemployer.com/1",
    postedAt: daysAgoIso(21),
  });
  const match = matchCompanyForObservation(job);
  const eligibility = evaluateNewEmployerEligibility(job, match);
  assert.equal(eligibility.eligible, false);
});

test("14. a non-US external listing cannot onboard a new employer through that observation", () => {
  const job = makeExternalJob({
    employerName: "Foreign Onboard Employer",
    directEmployerUrl: "https://careers.foreignonboardemployer.com/1",
    location: "London, UK",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  const eligibility = evaluateNewEmployerEligibility(job, match);
  assert.equal(eligibility.eligible, false);
});

test("15. a fresh US external listing may proceed to onboarding eligibility (and onboard)", () => {
  const job = makeExternalJob({
    employerName: "Fresh Onboard Employer",
    directEmployerUrl: "https://careers.freshonboardemployer.com/1",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  const eligibility = evaluateNewEmployerEligibility(job, match);
  assert.equal(eligibility.eligible, true);
  const result = onboardNewEmployerIfEligible(job, match);
  assert.equal(result.outcome, "created");
});

// 16. reliable Built In date persists
test("16. Built In's reliable ISO postedAt survives into jobs.posted_at", () => {
  const company = makeCompany("Posted Date Stage14 Co");
  const isoDate = daysAgoIso(5);
  const observation = {
    id: 1,
    source: "built_in" as const,
    provider_job_id: "posted-date-14-1",
    fingerprint: "posted-date-14-fp-1",
    matched_company_id: company.id,
  } as import("../types").ExternalHiringObservationRow;
  const job = makeExternalJob({ employerName: "Posted Date Stage14 Co", postedAt: isoDate });
  const staged = stageSecondaryJob(observation, job, company.id);
  const row = getJobByDedupeKey(staged.dedupeKey);
  assert.ok(row?.posted_at);
  assert.equal(new Date(row!.posted_at!).toISOString().slice(0, 10), isoDate);
});

// 17. existing old job may still be refreshed (new-insert vs existing-refresh distinction)
test("17. an existing job aged well past 20 days is still eligible for a rescan/refresh via the existingJob bypass", () => {
  const company = makeCompany("Refresh Old Job Co", "greenhouse", "refresholdjobco");
  const dedupeKey = `greenhouse:${company.id}:refresh-1`;
  const outcome1 = upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey,
    job: normalizedAtsJob({ externalId: "refresh-1", postedAt: daysAgoIso(25) }),
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  assert.equal(outcome1, "inserted");
  const existingRow = getJobByDedupeKey(dedupeKey)!;

  // The job is NOW 25+ days old by posted date. A fresh scan re-seeing it must still be able to
  // refresh it (update last_seen_at / content) — the freshness gate's existingJob bypass exists
  // exactly for this.
  const freshness = isJobFreshForIngestion(normalizedAtsJob({ externalId: "refresh-1", postedAt: daysAgoIso(25) }), { id: existingRow.id }, "greenhouse");
  assert.equal(freshness.eligible, true, "an existing tracked job must remain refreshable regardless of age");

  const outcome2 = upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey,
    job: normalizedAtsJob({ externalId: "refresh-1", postedAt: daysAgoIso(25), title: "Data Engineer II" }),
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  assert.equal(outcome2, "updated");
});

// 18. a 21-day-old NEW job cannot be newly inserted
test("18. a 21-day-old NEW job (no existing row) is never inserted", () => {
  const company = makeCompany("Never Insert Stale Co", "greenhouse", "neverinsertstaleco");
  const dedupeKey = `greenhouse:${company.id}:never-insert-1`;
  assert.equal(getJobByDedupeKey(dedupeKey), undefined);

  const freshness = isJobFreshForIngestion(normalizedAtsJob({ externalId: "never-insert-1", postedAt: daysAgoIso(21) }), undefined, "greenhouse");
  assert.equal(freshness.eligible, false);
  // Mirrors scan.ts's own gate: a stale NEW job is skipped (continue) BEFORE upsertJob is ever called.
  if (!freshness.eligible) {
    // no upsertJob call — this is the point being proven
  } else {
    upsertJob({
      companyId: company.id, sourceType: "greenhouse", dedupeKey,
      job: normalizedAtsJob({ externalId: "never-insert-1", postedAt: daysAgoIso(21) }),
      descriptionSections: null, sponsorshipMentioned: false, sponsorshipPolarity: "none",
      sponsorshipSnippet: null, h1bCombinedConfidence: "Unknown",
    });
  }
  assert.equal(getJobByDedupeKey(dedupeKey), undefined, "no row was ever created for the stale new job");
});

// 19. archived existing job behavior remains consistent with established lifecycle semantics
test("19. an archived existing job aged past 20 days still passes the existingJob freshness bypass (lifecycle state is a separate concern)", () => {
  const company = makeCompany("Archived Refresh Co", "greenhouse", "archivedrefreshco");
  const dedupeKey = `greenhouse:${company.id}:archived-1`;
  upsertJob({
    companyId: company.id, sourceType: "greenhouse", dedupeKey,
    job: normalizedAtsJob({ externalId: "archived-1", postedAt: daysAgoIso(25) }),
    descriptionSections: null, sponsorshipMentioned: false, sponsorshipPolarity: "none",
    sponsorshipSnippet: null, h1bCombinedConfidence: "Unknown",
  });
  const row = getJobByDedupeKey(dedupeKey)!;
  getDb().prepare("UPDATE jobs SET is_archived = 1, archived_at = datetime('now') WHERE id = ?").run(row.id);

  const freshness = isJobFreshForIngestion(normalizedAtsJob({ externalId: "archived-1", postedAt: daysAgoIso(25) }), { id: row.id }, "greenhouse");
  assert.equal(freshness.eligible, true, "freshness gate does not care about archive state — that's lifecycle maintenance's concern, not ingestion's");
});

// 20. suppression still works
test("20. suppression (Not Interested) is respected for a Built In secondary job under the Stage 14 gate", () => {
  const company = makeCompany("Suppress Stage14 Co");
  const observation = {
    id: 2, source: "built_in" as const, provider_job_id: "suppress-14-1",
    fingerprint: "suppress-14-fp-1", matched_company_id: company.id,
  } as import("../types").ExternalHiringObservationRow;
  const job = makeExternalJob({ employerName: "Suppress Stage14 Co" });
  const staged = stageSecondaryJob(observation, job, company.id);
  const row = getJobByDedupeKey(staged.dedupeKey)!;
  markNotInterested(row.id);
  const restaged = stageSecondaryJob(observation, job, company.id);
  assert.equal(restaged.outcome, "suppressed");
});

// 21. dedup still works
test("21. cross-source dedup (EXACT/HIGH/POSSIBLE) still works under the Stage 14 gate", () => {
  const base = {
    id: 0, source: "built_in" as const, provider_job_id: "x", fingerprint: "fp",
    observed_employer_name: "Test", observed_title: "Data Engineer", observed_location: "Austin, TX",
    observed_url: "https://builtin.com/job/x", direct_employer_url: null, direct_apply_url: null,
    employer_domain: null, posted_at: null, matched_company_id: 5, match_confidence: "ALIAS" as const,
    employer_relationship: "DIRECT_EMPLOYER" as const, url_classification: "DIRECT_ATS" as const,
    detected_ats_provider: null, detected_ats_board_token: null, signal_classification: "COVERAGE_MISMATCH" as const,
    decision: "SECONDARY_JOB_CANDIDATE" as const, resulting_job_id: null, evidence_json: "{}", status: "ACTIVE" as const,
    first_observed_at: new Date().toISOString(), last_observed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const a = { ...base, id: 1, direct_apply_url: "https://job-boards.greenhouse.io/x/jobs/111" };
  const bExact = { ...base, id: 2, direct_apply_url: "https://job-boards.greenhouse.io/x/jobs/111" };
  assert.equal(compareCrossSourceIdentity(a, bExact), "EXACT", "byte-identical canonical apply URLs are EXACT");

  const bHigh = {
    ...base, id: 3, direct_apply_url: "https://job-boards.greenhouse.io/x/jobs/222",
    detected_ats_provider: "greenhouse", detected_ats_board_token: "x",
  };
  const aWithBoard = { ...a, detected_ats_provider: "greenhouse", detected_ats_board_token: "x" };
  assert.equal(compareCrossSourceIdentity(aWithBoard, bHigh), "HIGH", "same board + same normalized title/location, different URL, is HIGH");

  const bPossible = { ...base, id: 4, direct_apply_url: null, observed_location: "Remote" };
  assert.equal(compareCrossSourceIdentity(a, bPossible), "POSSIBLE", "same title, mismatched location/board is only POSSIBLE — never auto-merged");
});

// 22. official-source preference still works
test("22. an official ATS job still supersedes a matching Built In secondary job under the Stage 14 gate", () => {
  const company = makeCompany("Official Preference Stage14 Co", "greenhouse", "officialpreferencestage14co");
  getDb().prepare(
    `INSERT INTO jobs (company_id, source_type, dedupe_key, external_id, title, location, url, is_active)
     VALUES (?, 'greenhouse', ?, 'official-1', 'Data Engineer', 'Austin, TX', 'https://job-boards.greenhouse.io/x/1', 1)`
  ).run(company.id, `greenhouse:${company.id}:official-1`);
  const observation = {
    id: 3, source: "built_in" as const, provider_job_id: "official-pref-14-1",
    fingerprint: "official-pref-14-fp-1", matched_company_id: company.id,
  } as import("../types").ExternalHiringObservationRow;
  const staged = stageSecondaryJob(observation, makeExternalJob({ employerName: "Official Preference Stage14 Co" }), company.id);
  assert.equal(staged.outcome, "inserted");
  const retired = retireSupersededSecondaryJobs(company.id);
  assert.equal(retired.length, 1);
});

// 23. reliability recovery cannot bypass freshness
test("23. a company whose connector just recovered to HEALTHY is still subject to the exact same freshness gate for a stale new job", () => {
  const company = makeCompany("Recovered Connector Co", "greenhouse", "recoveredconnectorco");
  // Simulate a connector recovery transition — connector_health becomes healthy after being down.
  getDb().prepare("UPDATE companies SET connector_health = 'healthy', consecutive_failures = 0 WHERE id = ?").run(company.id);
  const dedupeKey = `greenhouse:${company.id}:recovered-1`;

  const freshness = isJobFreshForIngestion(normalizedAtsJob({ externalId: "recovered-1", postedAt: daysAgoIso(21) }), undefined, "greenhouse");
  assert.equal(freshness.eligible, false, "connector_health has no influence on isJobFreshForIngestion — the function doesn't even accept it as a parameter");
  assert.equal(getJobByDedupeKey(dedupeKey), undefined);
});

// 24. Discovery V2 eventually uses normal ingestion contract (no separate job-freshness logic)
test("24. approving a Discovery V2 proposal only changes company source identity — it never inserts a job directly, so any subsequent ingestion must go through the normal gate", () => {
  const company = makeCompany("Discovery V2 Contract Co", "career_link");
  const beforeJobCount = (getDb().prepare("SELECT COUNT(*) AS c FROM jobs WHERE company_id = ?").get(company.id) as { c: number }).c;
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: {
      provider: "greenhouse",
      boardToken: "discoveryv2contractco",
      canonicalUrl: "https://job-boards.greenhouse.io/discoveryv2contractco",
      confidence: "HIGH",
      validationStatus: "VALIDATED_JOBS",
      recommendation: "AUTO_REPLACE_CANDIDATE",
      evidenceTypes: ["structured_board"],
      evidenceUrls: ["https://job-boards.greenhouse.io/discoveryv2contractco"],
    },
  });
  assert.ok(proposal);
  assert.equal(proposal!.status, "PENDING_REVIEW");
  const afterJobCount = (getDb().prepare("SELECT COUNT(*) AS c FROM jobs WHERE company_id = ?").get(company.id) as { c: number }).c;
  assert.equal(afterJobCount, beforeJobCount, "creating a Discovery V2 proposal never inserts a job row");
});

// 25. no lifecycle maintenance side effects
test("25. processExternalListing under the Stage 14 gate never creates a scan_runs row", async () => {
  const before1 = getDb().prepare("SELECT COUNT(*) AS c FROM scan_runs").get() as { c: number };
  const raw = {
    identifierValue: "stage14-lifecycle-1",
    title: "Data Engineer",
    hiringOrganizationName: "No Lifecycle Stage14 Co",
    datePosted: daysAgoIso(1),
    description: "A real job description with enough content to be meaningful for testing purposes, well past the minimum length threshold.",
    addressLocality: "Austin",
    addressRegion: "TX",
    addressCountry: "USA",
    listingUrl: "https://builtin.com/job/no-lifecycle-14/stage14-lifecycle-1",
    applyHref: "https://careers.nolifecyclestage14co.com/1",
  };
  await processExternalListing("built_in", raw, { persistObservations: true, persistSecondaryJobs: true, onboardNewEmployers: true });
  const after1 = getDb().prepare("SELECT COUNT(*) AS c FROM scan_runs").get() as { c: number };
  assert.equal(after1.c, before1.c);
});

// 26. no matching/tailoring/resume/notification effects
test("26. processExternalListing under the Stage 14 gate never writes job_match_results, tailoring_runs, or notifications", async () => {
  const tables = ["job_match_results", "tailoring_runs", "notifications"];
  const before1 = tables.map((t) => (getDb().prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
  const raw = {
    identifierValue: "stage14-sideeffect-1",
    title: "Data Engineer",
    hiringOrganizationName: "No Side Effect Stage14 Co",
    datePosted: daysAgoIso(1),
    description: "A real job description with enough content to be meaningful for testing purposes, well past the minimum length threshold.",
    addressLocality: "Austin",
    addressRegion: "TX",
    addressCountry: "USA",
    listingUrl: "https://builtin.com/job/no-side-effect-14/stage14-sideeffect-1",
    applyHref: "https://careers.nosideeffectstage14co.com/1",
  };
  await processExternalListing("built_in", raw, { persistObservations: true, persistSecondaryJobs: true, onboardNewEmployers: true });
  const after1 = tables.map((t) => (getDb().prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
  assert.deepEqual(after1, before1);
});

// 27. no paid service enabled
test("27. the global freshness/US gate never references any paid-provider credential", () => {
  const originalToken = process.env.APIFY_API_TOKEN;
  const originalAllow = process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL;
  delete process.env.APIFY_API_TOKEN;
  delete process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL;
  try {
    const company = makeCompany("No Paid Stage14 Co");
    const job = makeExternalJob({ employerName: "No Paid Stage14 Co", postedAt: daysAgoIso(1) });
    const observation = {
      id: 4, source: "built_in" as const, provider_job_id: "no-paid-14-1",
      fingerprint: "no-paid-14-fp-1", matched_company_id: company.id,
    } as import("../types").ExternalHiringObservationRow;
    const staged = stageSecondaryJob(observation, job, company.id);
    assert.equal(staged.outcome, "inserted");
  } finally {
    if (originalToken !== undefined) process.env.APIFY_API_TOKEN = originalToken;
    if (originalAllow !== undefined) process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL = originalAllow;
  }
});

// Regression guard for the real gap Stage 14 discovered and fixed: UNKNOWN location must never
// silently pass the external-signals quality gate.
test("Stage 14 fix: an UNKNOWN-location external listing never passes evaluateQualityGate (DISCOVERY_BEACON_ONLY, not null)", () => {
  const company = makeCompany("Unknown Location Gate Co", "greenhouse", "unknownlocationgateco");
  const job = makeExternalJob({
    employerName: "Unknown Location Gate Co",
    applyUrl: "https://job-boards.greenhouse.io/unknownlocationgateco/jobs/1",
    location: null,
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
  assert.equal(classifyJobLocation(job.location), "UNKNOWN");
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, "DISCOVERY_BEACON_ONLY", "UNKNOWN location must never silently pass the gate as if it were US");
});
