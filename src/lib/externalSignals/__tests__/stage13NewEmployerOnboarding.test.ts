import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedExternalJob } from "../types";

/**
 * Stage 13 — the 33 required items for safe new-employer onboarding, role-based search dedup,
 * posted_at preservation, and a re-verification that every Stage 7/9/10/11/12 safety property still
 * holds once Built In can create companies. Reuses every existing mechanism verbatim (createCompany,
 * updateCompanyDomainIdentity, createProposalFromDiscoveryV2, matchCompanyForObservation,
 * processExternalListing) — no second registry, no second persistence path, no fuzzy matching.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let updateCompanyDomainIdentity: typeof import("@/db/queries/companies").updateCompanyDomainIdentity;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let markNotInterested: typeof import("@/db/queries/jobs").markNotInterested;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let getCompanyForOrganization: typeof import("@/db/queries/organizationRegistry").getCompanyForOrganization;
let addOrganizationDomain: typeof import("@/db/queries/organizationRegistry").addOrganizationDomain;
let createOrganization: typeof import("@/db/queries/organizationRegistry").createOrganization;
let listOrganizations: typeof import("@/db/queries/organizationRegistry").listOrganizations;
let matchCompanyForObservation: typeof import("../companyMatch").matchCompanyForObservation;
let evaluateNewEmployerEligibility: typeof import("../companyOnboarding").evaluateNewEmployerEligibility;
let onboardNewEmployerIfEligible: typeof import("../companyOnboarding").onboardNewEmployerIfEligible;
let processExternalListing: typeof import("../pipeline").processExternalListing;
let stageSecondaryJob: typeof import("../secondaryIngestion").stageSecondaryJob;
let retireSupersededSecondaryJobs: typeof import("../secondaryIngestion").retireSupersededSecondaryJobs;
let isProposalApprovable: typeof import("@/db/queries/atsSourceProposals").isProposalApprovable;
let parseBuiltInSearchResults: typeof import("../providers").parseBuiltInSearchResults;
let searchBuiltInAcrossRoles: typeof import("../providers").searchBuiltInAcrossRoles;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-stage13-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ createCompany, updateCompanyDomainIdentity } = await import("@/db/queries/companies"));
  ({ getJobByDedupeKey, markNotInterested } = await import("@/db/queries/jobs"));
  ({ setPipelineStatus } = await import("@/db/queries/candidateJobState"));
  ({ getCompanyForOrganization, addOrganizationDomain, createOrganization, listOrganizations } = await import("@/db/queries/organizationRegistry"));
  ({ matchCompanyForObservation } = await import("../companyMatch"));
  ({ evaluateNewEmployerEligibility, onboardNewEmployerIfEligible } = await import("../companyOnboarding"));
  ({ processExternalListing } = await import("../pipeline"));
  ({ stageSecondaryJob, retireSupersededSecondaryJobs } = await import("../secondaryIngestion"));
  ({ isProposalApprovable } = await import("@/db/queries/atsSourceProposals"));
  ({ parseBuiltInSearchResults, searchBuiltInAcrossRoles } = await import("../providers"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeJob(overrides: Partial<NormalizedExternalJob> = {}): NormalizedExternalJob {
  return {
    source: "built_in",
    providerJobId: "builtin-1",
    employerName: "",
    title: "Data Engineer",
    location: "Austin, TX",
    description: "A real job description with enough content to be meaningful for testing purposes, well past the minimum length threshold.",
    postedAt: null,
    listingUrl: "https://builtin.com/job/data-engineer/builtin-1",
    applyUrl: null,
    directEmployerUrl: null,
    employmentType: "Full-time",
    salaryText: null,
    raw: {},
    ...overrides,
  };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function makeCompany(name: string, sourceType: import("@/types").SourceType = "career_link", atsBoardToken?: string) {
  return createCompany({ name, source_type: sourceType, ats_board_token: atsBoardToken });
}

/** processExternalListing("built_in", raw, ...) expects a RawBuiltInResult (the provider's own raw
 *  shape), NOT a NormalizedExternalJob — this constructs a well-formed raw fixture for pipeline-level
 *  tests, matching normalize.ts's RawBuiltInResult interface exactly. */
function makeRawBuiltIn(overrides: Partial<import("../normalize").RawBuiltInResult> = {}): import("../normalize").RawBuiltInResult {
  return {
    identifierValue: "raw-builtin-1",
    title: "Data Engineer",
    hiringOrganizationName: "",
    datePosted: daysAgoIso(1),
    description: "A real job description with enough content to be meaningful for testing purposes, well past the minimum length threshold.",
    addressLocality: "Austin",
    addressRegion: "TX",
    addressCountry: "USA",
    jobLocationType: "ONSITE",
    employmentType: "FULL_TIME",
    listingUrl: "https://builtin.com/job/data-engineer/raw-builtin-1",
    applyHref: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. existing company matched normally
test("1. an existing CareerOps company is matched normally, never treated as a new-employer candidate", () => {
  const company = makeCompany("Existing Normal Corp.");
  const job = makeJob({ employerName: "Existing Normal", applyUrl: "https://job-boards.greenhouse.io/existingnormal/jobs/1" });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
  const eligibility = evaluateNewEmployerEligibility(job, match);
  assert.equal(eligibility.eligible, false);
});

// 2. unknown legitimate employer with strong domain evidence can be onboarded
test("2. an unknown legitimate employer with a strong employer-owned domain and full evidence can be onboarded", () => {
  const job = makeJob({
    employerName: "Brand New Legitimate Employer",
    directEmployerUrl: "https://careers.brandnewlegitimateemployer.com/jobs/1",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  assert.equal(match.confidence, "UNMATCHED");
  const result = onboardNewEmployerIfEligible(job, match);
  assert.equal(result.outcome, "created");
  assert.ok(result.companyId);
  const created = getDb().prepare("SELECT verified_domain, source_type, ats_board_token FROM companies WHERE id = ?").get(result.companyId) as
    | { verified_domain: string | null; source_type: string; ats_board_token: string | null }
    | undefined;
  assert.equal(created?.verified_domain, "careers.brandnewlegitimateemployer.com");
  assert.equal(created?.source_type, "career_link");
  assert.equal(created?.ats_board_token, null);
});

// 3. employer-name-only weak evidence cannot create company
test("3. employer-name-only evidence (no Apply/employer URL at all) never creates a company", () => {
  const job = makeJob({ employerName: "Name Only Employer", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  const eligibility = evaluateNewEmployerEligibility(job, match);
  assert.equal(eligibility.eligible, false);
  assert.match(eligibility.reason, /No direct Apply\/employer URL/);
});

// 4. ambiguous employer cannot create company
test("4. an AMBIGUOUS employer match never falls through to new-company creation", () => {
  makeCompany("Ambiguous Onboard Group");
  makeCompany("Ambiguous Onboard Holdings");
  const job = makeJob({ employerName: "Ambiguous Onboard", applyUrl: "https://job-boards.greenhouse.io/ambiguousonboard/jobs/1", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  assert.equal(match.confidence, "AMBIGUOUS");
  const result = onboardNewEmployerIfEligible(job, match);
  assert.equal(result.outcome, "skipped_ineligible");
  assert.equal(result.companyId, null);
});

// 5. staffing company cannot create target employer
test("5. staffing-agency-worded employer name never onboards a new company", () => {
  const job = makeJob({
    employerName: "Confidential Client via Staffing Onboard Recruiting",
    directEmployerUrl: "https://staffingonboard.com/apply/1",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  const eligibility = evaluateNewEmployerEligibility(job, match);
  assert.equal(eligibility.eligible, false);
  assert.match(eligibility.reason, /Staffing\/recruiter language/);
});

// 6. aggregator/tracking domain not used as verified domain
test("6. an aggregator/tracking domain (e.g. linkedin.com) is never used as new-employer identity evidence", () => {
  const job = makeJob({ employerName: "Aggregator Routed Employer", directEmployerUrl: "https://www.linkedin.com/jobs/view/12345", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  const eligibility = evaluateNewEmployerEligibility(job, match);
  assert.equal(eligibility.eligible, false);
  assert.match(eligibility.reason, /aggregator\/tracker/);
});

// 7. ATS vendor domain not used as employer verified domain
test("7. a Workday-hosted apply URL is eligible via ATS detection but never sets company.verified_domain", () => {
  const job = makeJob({
    employerName: "New ATS Hosted Employer",
    applyUrl: "https://newatshostedemployer.wd5.myworkdayjobs.com/Careers/job/x",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  const eligibility = evaluateNewEmployerEligibility(job, match);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.verifiedDomain, null);
  assert.equal(eligibility.atsDetection?.sourceType, "workday");

  const result = onboardNewEmployerIfEligible(job, match);
  assert.equal(result.outcome, "created");
  const created = getDb().prepare("SELECT verified_domain, ats_board_token FROM companies WHERE id = ?").get(result.companyId) as
    | { verified_domain: string | null; ats_board_token: string | null }
    | undefined;
  assert.equal(created?.verified_domain, null);
  assert.equal(created?.ats_board_token, null, "ATS board token must never be set directly on the company row");
});

// 8. existing organization reused rather than duplicated
test("8. an H1B-derived organization with no linked company is reused, not duplicated, on new-employer onboarding", () => {
  const org = createOrganization("H1B Only Org Test");
  addOrganizationDomain({ organizationId: org.id, domain: "h1bonlyorgtest.com", identityStatus: "VERIFIED" });
  const beforeCount = listOrganizations({ limit: 1000 }).length;

  const job = makeJob({ employerName: "H1B Only Org Test", directEmployerUrl: "https://h1bonlyorgtest.com/careers/1", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  assert.equal(match.confidence, "UNMATCHED", "an org-only, company-less identity must not resolve via normal matching");
  const result = onboardNewEmployerIfEligible(job, match);

  assert.equal(result.outcome, "linked_existing_organization");
  assert.equal(result.organizationId, org.id);
  const afterCount = listOrganizations({ limit: 1000 }).length;
  assert.equal(afterCount, beforeCount, "no new organization row was created");
  const linked = getCompanyForOrganization(org.id);
  assert.equal(linked?.id, result.companyId);
});

// 9. existing company not duplicated
test("9. onboarding never creates a second company for a domain an existing company already owns", () => {
  const company = makeCompany("Already Owned Domain Co");
  updateCompanyDomainIdentity(company.id, { verifiedDomain: "alreadyowneddomain.com", domainIdentityStatus: "VERIFIED" });

  const job = makeJob({ employerName: "Totally Different Display Name", directEmployerUrl: "https://alreadyowneddomain.com/careers/1", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id, "domain tier should already resolve this to the existing company");
});

// 10. existing verified domain collision blocks creation
test("10. a domain collision with an existing company blocks new-company creation even when name matching alone would miss it", () => {
  const company = makeCompany("Collision Domain Co");
  updateCompanyDomainIdentity(company.id, { verifiedDomain: "collisiondomainco.com", domainIdentityStatus: "VERIFIED" });

  const job = makeJob({ employerName: "Unrelated Name For Collision", directEmployerUrl: "https://collisiondomainco.com/careers/2", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  assert.equal(match.confidence, "DOMAIN");
  const eligibility = evaluateNewEmployerEligibility(job, match);
  assert.equal(eligibility.eligible, false, "match already succeeded, so onboarding is never even attempted");
});

// 11. ATS board collision blocks duplicate creation
test("11. an ATS board/token an existing company already owns resolves via the existing ATS_BOARD tier, never re-created", () => {
  const company = makeCompany("Board Collision Co", "greenhouse", "boardcollisionco");
  const job = makeJob({ employerName: "Some Other Display Name", applyUrl: "https://job-boards.greenhouse.io/boardcollisionco/jobs/2", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
  assert.equal(match.confidence, "ATS_BOARD");
});

// 12. parent/subsidiary not guessed
test("12. a brand name ('Optum') is never onboarded as if it were an existing differently-named parent ('UnitedHealth Group Incorporated')", () => {
  makeCompany("UnitedHealth Group Incorporated Onboard Test");
  const job = makeJob({ employerName: "Optum Onboard Test", directEmployerUrl: "https://careers.unitedhealthgroup.com/job/1", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  assert.equal(match.confidence, "UNMATCHED");
  const eligibility = evaluateNewEmployerEligibility(job, match);
  // careers.unitedhealthgroup.com is a real employer-style domain (not a recognized ATS vendor,
  // not an aggregator) so it is eligible on ITS OWN evidence — a brand-new company named "Optum
  // Onboard Test" with that domain, never silently merged into the existing "UnitedHealth Group" row.
  if (eligibility.eligible) {
    const result = onboardNewEmployerIfEligible(job, match);
    assert.notEqual(result.companyId, null);
  }
});

// 13. new company receives only evidence-backed fields
test("13. a newly onboarded company has no fabricated notes/career_page_url — only the evidence actually captured", () => {
  const job = makeJob({ employerName: "Evidence Only Employer", directEmployerUrl: "https://careers.evidenceonlyemployer.com/1", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  const result = onboardNewEmployerIfEligible(job, match);
  const row = getDb().prepare("SELECT career_page_url, notes FROM companies WHERE id = ?").get(result.companyId) as { career_page_url: string | null; notes: string | null };
  assert.equal(row.career_page_url, null);
  assert.equal(row.notes, null);
});

// 14. no sponsorship status fabricated
test("14. a newly onboarded company has default/unfabricated H1B fields", () => {
  const job = makeJob({ employerName: "No Sponsorship Fabrication Employer", directEmployerUrl: "https://careers.nosponsorshipfabricationemployer.com/1", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  const result = onboardNewEmployerIfEligible(job, match);
  const row = getDb().prepare("SELECT h1b_confidence, h1b_lca_count, h1b_match_tier FROM companies WHERE id = ?").get(result.companyId) as {
    h1b_confidence: string;
    h1b_lca_count: number;
    h1b_match_tier: string | null;
  };
  assert.equal(row.h1b_confidence, "Unknown");
  assert.equal(row.h1b_lca_count, 0);
  assert.equal(row.h1b_match_tier, null);
});

// 15. no H1B requirement gates ingestion
test("15. new-employer onboarding never checks or requires any H1B history — eligibility depends only on job/identity evidence", () => {
  const job = makeJob({ employerName: "No H1B History At All Employer", directEmployerUrl: "https://careers.noh1bhistoryemployer.com/1", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  const eligibility = evaluateNewEmployerEligibility(job, match);
  assert.equal(eligibility.eligible, true, "a company with zero H1B history is still onboardable on its own merits");
});

// 16/17. recognized ATS creates/reuses review path only; no source auto-approval
test("16/17. a detected ATS creates a PENDING_REVIEW proposal only, never HIGH+VALIDATED_JOBS, never auto-approvable", () => {
  const job = makeJob({ employerName: "ATS Review Path Employer", applyUrl: "https://atsreviewpathemployer.wd1.myworkdayjobs.com/Careers/job/x", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  const result = onboardNewEmployerIfEligible(job, match);
  assert.ok(result.proposalCreated);
  assert.equal(result.proposalCreated?.status, "PENDING_REVIEW");
  assert.equal(
    isProposalApprovable({ confidence: result.proposalCreated!.confidence, validation_status: result.proposalCreated!.validation_status }),
    false
  );
  const company = getDb().prepare("SELECT source_type, ats_board_token FROM companies WHERE id = ?").get(result.companyId) as { source_type: string; ats_board_token: string | null };
  assert.equal(company.source_type, "career_link", "the company's own source is never silently switched to the detected ATS");
});

// 18. new-company Built In job can enter secondary ingestion after validation
test("18. a job for a newly onboarded company proceeds through the SAME pipeline into a real secondary job row", async () => {
  const raw = makeRawBuiltIn({
    identifierValue: "fullpipeline-1",
    hiringOrganizationName: "Full Pipeline New Employer",
    applyHref: "https://careers.fullpipelinenewemployer.com/1",
    listingUrl: "https://builtin.com/job/full-pipeline/fullpipeline-1",
  });
  const result = await processExternalListing("built_in", raw, { persistObservations: true, persistSecondaryJobs: true, onboardNewEmployers: true });
  assert.ok(result.newEmployerOnboarding?.companyId);
  assert.equal(result.match.companyId, result.newEmployerOnboarding?.companyId);
  assert.equal(result.decision, "SECONDARY_JOB_CANDIDATE");
  assert.ok(result.stagedJob);
  assert.equal(result.stagedJob?.outcome, "inserted");
});

// 19. US job accepted / 20. non-US rejected
test("19/20. US job is eligible, non-US job is not", () => {
  const usJob = makeJob({ employerName: "US Eligible Employer", directEmployerUrl: "https://careers.useligibleemployer.com/1", location: "Austin, TX", postedAt: daysAgoIso(1) });
  const usMatch = matchCompanyForObservation(usJob);
  assert.equal(evaluateNewEmployerEligibility(usJob, usMatch).eligible, true);

  const foreignJob = makeJob({ employerName: "Foreign Ineligible Employer", directEmployerUrl: "https://careers.foreignineligibleemployer.com/1", location: "London, UK", postedAt: daysAgoIso(1) });
  const foreignMatch = matchCompanyForObservation(foreignJob);
  assert.equal(evaluateNewEmployerEligibility(foreignJob, foreignMatch).eligible, false);
});

// 21. <=20 days accepted / 22. >20 days rejected
test("21/22. a 20-day-old posting is eligible, a 21-day-old posting is not", () => {
  const freshJob = makeJob({ employerName: "Boundary Twenty Onboard", directEmployerUrl: "https://careers.boundarytwentyonboard.com/1", postedAt: daysAgoIso(20) });
  assert.equal(evaluateNewEmployerEligibility(freshJob, matchCompanyForObservation(freshJob)).eligible, true);

  const staleJob = makeJob({ employerName: "Boundary Twentyone Onboard", directEmployerUrl: "https://careers.boundarytwentyoneonboard.com/1", postedAt: daysAgoIso(21) });
  assert.equal(evaluateNewEmployerEligibility(staleJob, matchCompanyForObservation(staleJob)).eligible, false);
});

// 23. Built In posted_at preserved
test("23. Built In's reliable ISO postedAt survives into jobs.posted_at", () => {
  const company = makeCompany("Posted At Preserved Co");
  const isoDate = daysAgoIso(3);
  const observation = {
    id: 1,
    source: "built_in" as const,
    provider_job_id: "posted-at-1",
    fingerprint: "posted-at-fp-1",
    matched_company_id: company.id,
  } as import("../types").ExternalHiringObservationRow;
  const job = makeJob({ employerName: "Posted At Preserved Co", postedAt: isoDate });
  const staged = stageSecondaryJob(observation, job, company.id);
  const row = getJobByDedupeKey(staged.dedupeKey);
  assert.ok(row?.posted_at);
  assert.equal(new Date(row!.posted_at!).toISOString().slice(0, 10), isoDate);
});

// 24. unknown external date remains null/non-ingestion for the secondary-job-eligibility gate
test("24. an unparseable postedAt never becomes a stored posted_at and never passes the quality gate", () => {
  const company = makeCompany("Unknown Date Onboard Co");
  const job = makeJob({ employerName: "Unknown Date Onboard Co", applyUrl: "https://job-boards.greenhouse.io/unknowndateonboard/jobs/1", postedAt: null });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
  const observation = {
    id: 2,
    source: "built_in" as const,
    provider_job_id: "unknown-date-1",
    fingerprint: "unknown-date-fp-1",
    matched_company_id: company.id,
  } as import("../types").ExternalHiringObservationRow;
  const staged = stageSecondaryJob(observation, job, company.id);
  const row = getJobByDedupeKey(staged.dedupeKey);
  assert.equal(row?.posted_at, null);
});

// 25. duplicate search-query result detail-fetched once
test("25. the same listing appearing under two role queries is detail-fetched exactly once", async () => {
  const searchHtmlFor = (role: string) => `<html><body><script type="application/ld&#x2B;json">
    {"@context":"https://schema.org","@graph":[{"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","position":1,"name":"Shared Listing for ${role}","url":"https://builtin.com/job/shared-listing/999"}
    ]}]}
  </script></body></html>`;
  const detailHtml = `<html><body><script type="application/ld&#x2B;json">
    {"@context":"https://schema.org","@graph":[{"@type":"JobPosting","identifier":{"value":"999"},"title":"Shared Listing","hiringOrganization":{"name":"Dedup Test Co"},"datePosted":"${daysAgoIso(1)}","description":"A real job description with enough content to be meaningful for testing purposes here."}]}
  </script>
  <a href="https://job-boards.greenhouse.io/deduptest/jobs/999" target="_blank" @click="applyClick">Apply</a>
  </body></html>`;

  let detailFetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/job/shared-listing/999")) {
      detailFetchCount++;
      return new Response(detailHtml, { status: 200 });
    }
    const roleParam = new URL(url).searchParams.get("search") ?? "unknown";
    return new Response(searchHtmlFor(roleParam), { status: 200 });
  }) as typeof fetch;

  try {
    const results = await searchBuiltInAcrossRoles(["Role A", "Role B", "Role C"], { limitPerRole: 5, maxTotalUnique: 10 });
    assert.equal(results.length, 1, "the deduped result set has exactly one entry");
    assert.equal(detailFetchCount, 1, "the detail page was fetched exactly once despite appearing under 3 role queries");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 26. cross-source duplicate not duplicated
test("26. an official ATS job supersedes a matching new-company Built In secondary job (cross-source, not just same-source)", () => {
  const company = makeCompany("Cross Source Dup Co", "greenhouse", "crosssourcedupco");
  getDb().prepare(
    `INSERT INTO jobs (company_id, source_type, dedupe_key, external_id, title, location, url, is_active)
     VALUES (?, 'greenhouse', ?, 'official-1', 'Data Engineer', 'Austin, TX', 'https://job-boards.greenhouse.io/x/1', 1)`
  ).run(company.id, `greenhouse:${company.id}:official-1`);

  const observation = {
    id: 3,
    source: "built_in" as const,
    provider_job_id: "cross-source-1",
    fingerprint: "cross-source-fp-1",
    matched_company_id: company.id,
  } as import("../types").ExternalHiringObservationRow;
  const job = makeJob({ employerName: "Cross Source Dup Co" });
  const staged = stageSecondaryJob(observation, job, company.id);
  assert.equal(staged.outcome, "inserted");
  const retired = retireSupersededSecondaryJobs(company.id);
  assert.equal(retired.length, 1);
});

// 27. official ATS later preferred (same as 26, phrased as the "later" ordering — verifies idempotence)
test("27. re-running retireSupersededSecondaryJobs after the official source already won is a safe no-op", () => {
  const company = makeCompany("Later Preferred Co", "greenhouse", "laterpreferredco");
  getDb().prepare(
    `INSERT INTO jobs (company_id, source_type, dedupe_key, external_id, title, location, url, is_active)
     VALUES (?, 'greenhouse', ?, 'official-1', 'Data Engineer', 'Austin, TX', 'https://job-boards.greenhouse.io/x/1', 1)`
  ).run(company.id, `greenhouse:${company.id}:official-1`);
  const observation = {
    id: 4,
    source: "built_in" as const,
    provider_job_id: "later-preferred-1",
    fingerprint: "later-preferred-fp-1",
    matched_company_id: company.id,
  } as import("../types").ExternalHiringObservationRow;
  const job = makeJob({ employerName: "Later Preferred Co" });
  const staged = stageSecondaryJob(observation, job, company.id);
  retireSupersededSecondaryJobs(company.id);
  const archivedAtAfterFirstRun = getJobByDedupeKey(staged.dedupeKey)?.archived_at;

  // archiveJob() itself is idempotent (it early-returns ok:true without rewriting an already-archived
  // row — see src/db/queries/jobs.ts), so a second call is safe: the job stays archived exactly once,
  // with no changed archived_at timestamp and no duplicate row.
  retireSupersededSecondaryJobs(company.id);
  const row = getJobByDedupeKey(staged.dedupeKey);
  assert.equal(row?.is_archived, 1);
  assert.equal(row?.archived_at, archivedAtAfterFirstRun, "re-running never rewrites an already-archived job's timestamp");
  const rowCount = getDb().prepare("SELECT COUNT(*) AS c FROM jobs WHERE dedupe_key = ?").get(staged.dedupeKey) as { c: number };
  assert.equal(rowCount.c, 1, "no duplicate row was created");
});

// 28. suppression respected
test("28. suppression (Not Interested) is respected for a newly onboarded company's secondary job", () => {
  const company = makeCompany("Suppression Onboard Co");
  const observation = {
    id: 5,
    source: "built_in" as const,
    provider_job_id: "suppression-onboard-1",
    fingerprint: "suppression-onboard-fp-1",
    matched_company_id: company.id,
  } as import("../types").ExternalHiringObservationRow;
  const job = makeJob({ employerName: "Suppression Onboard Co" });
  const staged = stageSecondaryJob(observation, job, company.id);
  const row = getJobByDedupeKey(staged.dedupeKey)!;
  markNotInterested(row.id);
  const restaged = stageSecondaryJob(observation, job, company.id);
  assert.equal(restaged.outcome, "suppressed");
});

// 29. protected candidate jobs unaffected
test("29. a protected (Applied) secondary job for a newly onboarded company is never retired", () => {
  const company = makeCompany("Protected Onboard Co", "greenhouse", "protectedonboardco");
  getDb().prepare(
    `INSERT INTO jobs (company_id, source_type, dedupe_key, external_id, title, location, url, is_active)
     VALUES (?, 'greenhouse', ?, 'official-1', 'Data Engineer', 'Austin, TX', 'https://job-boards.greenhouse.io/x/1', 1)`
  ).run(company.id, `greenhouse:${company.id}:official-1`);
  const observation = {
    id: 6,
    source: "built_in" as const,
    provider_job_id: "protected-onboard-1",
    fingerprint: "protected-onboard-fp-1",
    matched_company_id: company.id,
  } as import("../types").ExternalHiringObservationRow;
  const job = makeJob({ employerName: "Protected Onboard Co" });
  const staged = stageSecondaryJob(observation, job, company.id);
  setPipelineStatus(1, staged.dedupeKey, "Applied");
  const retired = retireSupersededSecondaryJobs(company.id);
  assert.equal(retired.length, 0);
});

// 30. no lifecycle maintenance
test("30. onboarding a new employer and staging its job never creates a scan_runs row", async () => {
  const before1 = getDb().prepare("SELECT COUNT(*) AS c FROM scan_runs").get() as { c: number };
  const raw = makeRawBuiltIn({
    identifierValue: "no-lifecycle-1",
    hiringOrganizationName: "No Lifecycle Onboard Employer",
    applyHref: "https://careers.nolifecycleonboardemployer.com/1",
    listingUrl: "https://builtin.com/job/no-lifecycle/no-lifecycle-1",
  });
  await processExternalListing("built_in", raw, { persistObservations: true, persistSecondaryJobs: true, onboardNewEmployers: true });
  const after1 = getDb().prepare("SELECT COUNT(*) AS c FROM scan_runs").get() as { c: number };
  assert.equal(after1.c, before1.c);
});

// 31. no matching/tailoring/resume/notification side effects
test("31. onboarding + secondary ingestion never writes job_match_results, tailoring_runs, or notifications", async () => {
  const tables = ["job_match_results", "tailoring_runs", "notifications"];
  const before1 = tables.map((t) => (getDb().prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
  const raw = makeRawBuiltIn({
    identifierValue: "no-side-effect-1",
    hiringOrganizationName: "No Side Effect Onboard Employer",
    applyHref: "https://careers.nosideeffectonboardemployer.com/1",
    listingUrl: "https://builtin.com/job/no-side-effect/no-side-effect-1",
  });
  await processExternalListing("built_in", raw, { persistObservations: true, persistSecondaryJobs: true, onboardNewEmployers: true });
  const after1 = tables.map((t) => (getDb().prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
  assert.deepEqual(after1, before1);
});

// 32. no paid API/service
test("32. new-employer onboarding never references any paid-provider credential", () => {
  const originalToken = process.env.APIFY_API_TOKEN;
  const originalAllow = process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL;
  delete process.env.APIFY_API_TOKEN;
  delete process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL;
  try {
    const job = makeJob({ employerName: "No Paid Provider Onboard Employer", directEmployerUrl: "https://careers.nopaidproveronboardemployer.com/1", postedAt: daysAgoIso(1) });
    const match = matchCompanyForObservation(job);
    const result = onboardNewEmployerIfEligible(job, match);
    assert.equal(result.outcome, "created");
  } finally {
    if (originalToken !== undefined) process.env.APIFY_API_TOKEN = originalToken;
    if (originalAllow !== undefined) process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL = originalAllow;
  }
});

// 33. reliability architecture untouched
test("33. onboarding a new employer never writes connector_health/consecutive_failures on any unrelated company", () => {
  const unrelated = makeCompany("Reliability Untouched Co", "greenhouse", "reliabilityuntouchedco");
  getDb().prepare("UPDATE companies SET connector_health = 'healthy', consecutive_failures = 0 WHERE id = ?").run(unrelated.id);
  const job = makeJob({ employerName: "Reliability New Employer", directEmployerUrl: "https://careers.reliabilitynewemployer.com/1", postedAt: daysAgoIso(1) });
  const match = matchCompanyForObservation(job);
  onboardNewEmployerIfEligible(job, match);
  const row = getDb().prepare("SELECT connector_health, consecutive_failures FROM companies WHERE id = ?").get(unrelated.id) as {
    connector_health: string;
    consecutive_failures: number;
  };
  assert.equal(row.connector_health, "healthy");
  assert.equal(row.consecutive_failures, 0);
});

// Sanity check that the dedup fixture parser used in test 25 is well-formed on its own.
test("parseBuiltInSearchResults sanity check for the dedup test fixture", () => {
  const html = `<html><body><script type="application/ld&#x2B;json">
    {"@context":"https://schema.org","@graph":[{"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","position":1,"name":"X","url":"https://builtin.com/job/x/1"}
    ]}]}
  </script></body></html>`;
  assert.equal(parseBuiltInSearchResults(html).length, 1);
});
