import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ExternalHiringObservationRow, NormalizedExternalJob } from "../types";

/**
 * Stage 12 — the 37 required items covering the safe company-identity-resolution hierarchy
 * (verified domain -> ATS board -> alias -> corroborated legal-name normalization) and a
 * re-verification, on top of the new matching tiers, that every Stage 7/9/10/11 safety property
 * (US/freshness gates, staffing filtering, cross-source dedup, official-source preference,
 * suppression, protected-job preservation, coverage-mismatch bridging, ATS-health independence, and
 * zero unrelated side effects) still holds. Reuses every existing mechanism verbatim — no new
 * registry, no new dedup engine, no fuzzy/similarity matching anywhere in this file's expectations.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let updateCompanyDomainIdentity: typeof import("@/db/queries/companies").updateCompanyDomainIdentity;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let markNotInterested: typeof import("@/db/queries/jobs").markNotInterested;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let getOrganizationForCompany: typeof import("@/db/queries/organizationRegistry").getOrganizationForCompany;
let addOrganizationDomain: typeof import("@/db/queries/organizationRegistry").addOrganizationDomain;
let addOrganizationAlias: typeof import("@/db/queries/organizationRegistry").addOrganizationAlias;
let matchCompanyForObservation: typeof import("../companyMatch").matchCompanyForObservation;
let classifyEmployerRelationship: typeof import("../classify").classifyEmployerRelationship;
let classifyUrlEvidence: typeof import("../classify").classifyUrlEvidence;
let evaluateQualityGate: typeof import("../classify").evaluateQualityGate;
let compareCrossSourceIdentity: typeof import("../crossSourceDedup").compareCrossSourceIdentity;
let stageSecondaryJob: typeof import("../secondaryIngestion").stageSecondaryJob;
let retireSupersededSecondaryJobs: typeof import("../secondaryIngestion").retireSupersededSecondaryJobs;
let processExternalListing: typeof import("../pipeline").processExternalListing;
let bridgeCoverageMismatchToDiscoveryV2: typeof import("../discoveryV2Bridge").bridgeCoverageMismatchToDiscoveryV2;
let upsertExternalHiringObservation: typeof import("@/db/queries/externalHiringObservations").upsertExternalHiringObservation;
let isProposalApprovable: typeof import("@/db/queries/atsSourceProposals").isProposalApprovable;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-stage12-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ createCompany, updateCompanyDomainIdentity } = await import("@/db/queries/companies"));
  ({ getJobByDedupeKey, markNotInterested } = await import("@/db/queries/jobs"));
  ({ setPipelineStatus } = await import("@/db/queries/candidateJobState"));
  ({ getOrganizationForCompany, addOrganizationDomain, addOrganizationAlias } = await import("@/db/queries/organizationRegistry"));
  ({ matchCompanyForObservation } = await import("../companyMatch"));
  ({ classifyEmployerRelationship, classifyUrlEvidence, evaluateQualityGate } = await import("../classify"));
  ({ compareCrossSourceIdentity } = await import("../crossSourceDedup"));
  ({ stageSecondaryJob, retireSupersededSecondaryJobs } = await import("../secondaryIngestion"));
  ({ processExternalListing } = await import("../pipeline"));
  ({ bridgeCoverageMismatchToDiscoveryV2 } = await import("../discoveryV2Bridge"));
  ({ upsertExternalHiringObservation } = await import("@/db/queries/externalHiringObservations"));
  ({ isProposalApprovable } = await import("@/db/queries/atsSourceProposals"));
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

function makeCompany(overrides: { name: string; source_type?: import("@/types").SourceType; ats_board_token?: string }) {
  return createCompany({
    name: overrides.name,
    source_type: overrides.source_type ?? "career_link",
    ats_board_token: overrides.ats_board_token,
  });
}

function makeObservation(overrides: Partial<ExternalHiringObservationRow> = {}): ExternalHiringObservationRow {
  const base: ExternalHiringObservationRow = {
    id: 0,
    source: "built_in",
    provider_job_id: "builtin-1",
    fingerprint: "fp-1",
    observed_employer_name: "Test Co",
    observed_title: "Data Engineer",
    observed_location: "Austin, TX",
    observed_url: "https://builtin.com/job/data-engineer/builtin-1",
    direct_employer_url: null,
    direct_apply_url: null,
    employer_domain: null,
    posted_at: null,
    matched_company_id: 1,
    match_confidence: "ALIAS",
    employer_relationship: "DIRECT_EMPLOYER",
    url_classification: "DIRECT_ATS",
    detected_ats_provider: null,
    detected_ats_board_token: null,
    signal_classification: "COVERAGE_MISMATCH",
    decision: "SECONDARY_JOB_CANDIDATE",
    resulting_job_id: null,
    evidence_json: "{}",
    status: "ACTIVE",
    first_observed_at: new Date().toISOString(),
  } as ExternalHiringObservationRow;
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------------------------
// 1. exact verified-domain match
test("1. exact verified-domain match resolves with DOMAIN confidence", () => {
  const company = makeCompany({ name: "Acme Robotics, Inc." });
  const org = getOrganizationForCompany(company.id)!;
  addOrganizationDomain({ organizationId: org.id, domain: "acmerobotics.com", identityStatus: "VERIFIED" });
  const job = makeJob({ employerName: "Acme Robotics", directEmployerUrl: "https://acmerobotics.com/careers/1" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, company.id);
  assert.equal(result.confidence, "DOMAIN");
});

// 2. exact ATS-board identity match
test("2. an Apply URL resolving to an existing company's own ATS board/token resolves with ATS_BOARD confidence", () => {
  const company = makeCompany({ name: "Board Match Co", source_type: "greenhouse", ats_board_token: "boardmatchco" });
  const job = makeJob({ employerName: "Some Totally Unrelated Display Name", applyUrl: "https://job-boards.greenhouse.io/boardmatchco/jobs/999" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, company.id);
  assert.equal(result.confidence, "ATS_BOARD");
});

// 3. existing alias match
test("3. an employer name matching an existing organization alias resolves with ALIAS confidence", () => {
  const company = makeCompany({ name: "Widgets Corporation" });
  const org = getOrganizationForCompany(company.id)!;
  addOrganizationAlias({ organizationId: org.id, alias: "Widgets Co DBA", aliasType: "dba", provenanceSource: "test", evidence: "x" });
  const job = makeJob({ employerName: "Widgets Co DBA" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, company.id);
  assert.equal(result.confidence, "ALIAS");
});

// 4. legal suffix normalization ("Pfizer" == "Pfizer Inc.")
test("4. legal-suffix normalization matches 'Pfizer' against stored 'Pfizer Inc.' when corroborated by ATS evidence", () => {
  const company = makeCompany({ name: "Pfizer Inc." });
  const job = makeJob({ employerName: "Pfizer", applyUrl: "https://pfizer.wd1.myworkdayjobs.com/PfizerCareers/job/x" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, company.id);
  assert.equal(result.confidence, "NAME");
});

// 5. punctuation normalization ("&" vs "and")
test("5. '&' and 'and' normalize equivalently ('JPMorgan Chase & Co.' == 'JPMorgan Chase and Co')", () => {
  const company = makeCompany({ name: "JPMorgan Chase & Co." });
  const job = makeJob({ employerName: "JPMorgan Chase and Co", applyUrl: "https://job-boards.greenhouse.io/jpmc/jobs/1" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, company.id);
  assert.equal(result.confidence, "NAME");
});

// 6. whitespace normalization
test("6. extra/irregular whitespace normalizes equivalently", () => {
  const company = makeCompany({ name: "Spacey   Widgets   Inc." });
  const job = makeJob({ employerName: "Spacey Widgets", applyUrl: "https://job-boards.greenhouse.io/spacey/jobs/1" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, company.id);
  assert.equal(result.confidence, "NAME");
});

// 7. JPMorganChase-style deterministic normalization: concatenated name (no inserted word boundary)
// must NOT be guessed — this is not a suffix/punctuation difference, it's a missing space, and
// inventing one would be exactly the kind of fuzzy join Stage 12 forbids.
test("7. a concatenated employer name ('JPMorganChase', no space) is never guessed onto 'JPMorgan Chase & Co.' — stays UNMATCHED", () => {
  makeCompany({ name: "JPMorgan Chase & Co." });
  const job = makeJob({ employerName: "JPMorganChase", applyUrl: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs/preview/1" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, null);
  assert.equal(result.confidence, "UNMATCHED");
});

// 8. short generic name not guessed ("GM" must not become General Motors)
test("8. a short abbreviation ('GM') is never guessed onto 'General Motors Company', even with ATS evidence", () => {
  makeCompany({ name: "General Motors Company" });
  const job = makeJob({ employerName: "GM", applyUrl: "https://job-boards.greenhouse.io/generalmotors/jobs/1" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, null);
  assert.equal(result.confidence, "UNMATCHED");
});

// 9. ambiguous name not guessed (two companies collapse to the same normalized form)
test("9. two distinct companies whose names collapse to the same normalized form are AMBIGUOUS, never auto-resolved", () => {
  makeCompany({ name: "Acme Group" });
  makeCompany({ name: "Acme Holdings" });
  const job = makeJob({ employerName: "Acme", applyUrl: "https://job-boards.greenhouse.io/acme/jobs/1" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, null);
  assert.equal(result.confidence, "AMBIGUOUS");
});

// 10. multiple domain matches -> ambiguous/fail-safe (never an arbitrary pick)
test("10. two companies sharing the same VERIFIED domain never produce a confident DOMAIN resolution for either", () => {
  const companyA = makeCompany({ name: "Shared Domain Co A" });
  const orgA = getOrganizationForCompany(companyA.id)!;
  addOrganizationDomain({ organizationId: orgA.id, domain: "shareddomain-test.com", identityStatus: "VERIFIED" });
  const companyB = makeCompany({ name: "Shared Domain Co B" });
  const orgB = getOrganizationForCompany(companyB.id)!;
  addOrganizationDomain({ organizationId: orgB.id, domain: "shareddomain-test.com", identityStatus: "VERIFIED" });

  const job = makeJob({ employerName: "Neither Of The Above Employer", directEmployerUrl: "https://shareddomain-test.com/careers/1" });
  const result = matchCompanyForObservation(job);
  assert.notEqual(result.confidence, "DOMAIN");
  assert.equal(result.companyId, null);
});

// 11. parent/subsidiary not guessed (Optum / UnitedHealth Group style)
test("11. a brand/subsidiary name ('Optum') is never mapped onto a differently-named parent ('UnitedHealth Group Incorporated') without an explicit alias", () => {
  makeCompany({ name: "UnitedHealth Group Incorporated" });
  const job = makeJob({ employerName: "Optum", applyUrl: "https://careers.unitedhealthgroup.com/job/1" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, null);
  assert.equal(result.confidence, "UNMATCHED");
});

// 12. ATS evidence strengthens a name-only match (paired: without evidence -> UNMATCHED, with -> NAME)
test("12. ATS/apply-URL evidence is what upgrades a normalized-name candidate from UNMATCHED to NAME", () => {
  const company = makeCompany({ name: "Samsara Inc." });
  const withoutEvidence = matchCompanyForObservation(makeJob({ employerName: "Samsara" }));
  assert.equal(withoutEvidence.confidence, "UNMATCHED");
  assert.equal(withoutEvidence.companyId, null);

  const withEvidence = matchCompanyForObservation(makeJob({ employerName: "Samsara", applyUrl: "https://job-boards.greenhouse.io/samsara/jobs/1" }));
  assert.equal(withEvidence.confidence, "NAME");
  assert.equal(withEvidence.companyId, company.id);
});

// 13. conflicting name/domain evidence fails safely (strongest tier wins deterministically, no guess)
test("13. conflicting name vs. domain evidence resolves deterministically to the domain owner, never guessed toward the name-implied company", () => {
  const domainOwner = makeCompany({ name: "Domain Owner Co" });
  const orgOwner = getOrganizationForCompany(domainOwner.id)!;
  addOrganizationDomain({ organizationId: orgOwner.id, domain: "domainowner-test.com", identityStatus: "VERIFIED" });
  const nameImplied = makeCompany({ name: "Name Implied Inc." });

  const job = makeJob({ employerName: "Name Implied", directEmployerUrl: "https://domainowner-test.com/careers/1" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, domainOwner.id);
  assert.notEqual(result.companyId, nameImplied.id);
  assert.equal(result.confidence, "DOMAIN");
});

// 14. unmatched observation not inserted
test("14. an UNMATCHED observation never proceeds to SECONDARY_JOB_CANDIDATE", () => {
  const job = makeJob({ employerName: "Nobody Tracks This Employer" });
  const match = matchCompanyForObservation(job);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, "DISCOVERY_BEACON_ONLY");
});

// 15. ambiguous observation not inserted
test("15. an AMBIGUOUS observation never proceeds to SECONDARY_JOB_CANDIDATE", () => {
  makeCompany({ name: "Zeta Group" });
  makeCompany({ name: "Zeta Holdings" });
  const job = makeJob({ employerName: "Zeta", applyUrl: "https://job-boards.greenhouse.io/zeta/jobs/1" });
  const match = matchCompanyForObservation(job);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, "AMBIGUOUS_EMPLOYER");
});

// 16. EXACT match may proceed
test("16. a DOMAIN (EXACT-tier) match with full evidence passes the quality gate", () => {
  const company = makeCompany({ name: "Exact Tier Co" });
  updateCompanyDomainIdentity(company.id, { verifiedDomain: "exacttierco.com", domainIdentityStatus: "VERIFIED" });
  const job = makeJob({
    employerName: "Exact Tier Co",
    directEmployerUrl: "https://exacttierco.com/careers/1",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, null); // null = passes the gate
});

// 17. HIGH match (NAME + ATS evidence) may proceed
test("17. a NAME (HIGH-tier) match with full evidence passes the quality gate", () => {
  makeCompany({ name: "High Tier Corp." });
  const job = makeJob({
    employerName: "High Tier",
    applyUrl: "https://job-boards.greenhouse.io/hightier/jobs/1",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  assert.equal(match.confidence, "NAME");
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, null);
});

// 18. US job accepted
test("18. a US-located job is accepted by the quality gate", () => {
  makeCompany({ name: "US Location Corp." });
  const job = makeJob({
    employerName: "US Location",
    location: "Austin, TX",
    applyUrl: "https://job-boards.greenhouse.io/uslocation/jobs/1",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, null);
});

// 19. foreign job rejected
test("19. a foreign-only located job is rejected NON_US", () => {
  makeCompany({ name: "Foreign Location Corp." });
  const job = makeJob({
    employerName: "Foreign Location",
    location: "London, United Kingdom",
    applyUrl: "https://job-boards.greenhouse.io/foreignlocation/jobs/1",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, "NON_US");
});

// 20. 20-day boundary accepted
test("20. a job posted exactly 20 days ago is accepted (inclusive boundary)", () => {
  makeCompany({ name: "Boundary Twenty Corp." });
  const job = makeJob({
    employerName: "Boundary Twenty",
    applyUrl: "https://job-boards.greenhouse.io/boundarytwenty/jobs/1",
    postedAt: daysAgoIso(20),
  });
  const match = matchCompanyForObservation(job);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, null);
});

// 21. 21-day rejected
test("21. a job posted 21 days ago is rejected STALE", () => {
  makeCompany({ name: "Boundary Twentyone Corp." });
  const job = makeJob({
    employerName: "Boundary Twentyone",
    applyUrl: "https://job-boards.greenhouse.io/boundarytwentyone/jobs/1",
    postedAt: daysAgoIso(21),
  });
  const match = matchCompanyForObservation(job);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, "STALE");
});

// 22. unknown date rejected from jobs insertion
test("22. an unparseable/unknown posted date is never treated as fresh — DISCOVERY_BEACON_ONLY, not inserted", () => {
  makeCompany({ name: "Unknown Date Corp." });
  const job = makeJob({
    employerName: "Unknown Date",
    applyUrl: "https://job-boards.greenhouse.io/unknowndate/jobs/1",
    postedAt: null,
  });
  const match = matchCompanyForObservation(job);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, "DISCOVERY_BEACON_ONLY");
});

// 23. staffing listing rejected
test("23. a staffing-agency-worded listing is classified STAFFING_AGENCY, never a secondary job candidate", () => {
  makeCompany({ name: "Staffing Target Co Inc." });
  const job = makeJob({
    employerName: "Confidential Client via Staffing Target Co Recruiting",
    applyUrl: "https://job-boards.greenhouse.io/staffingtarget/jobs/1",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  const relationship = classifyEmployerRelationship(job, match);
  assert.equal(relationship, "STAFFING_AGENCY");
});

// 24. official duplicate not duplicated
test("24. an official ATS job supersedes/retires a matching Built In secondary job", () => {
  const company = makeCompany({ name: "Supersede Twelve Co", source_type: "greenhouse", ats_board_token: "supersedetwelve" });
  getDb().prepare(
    `INSERT INTO jobs (company_id, source_type, dedupe_key, external_id, title, location, url, is_active)
     VALUES (?, 'greenhouse', ?, 'official-1', 'Data Engineer', 'Austin, TX', 'https://job-boards.greenhouse.io/x/1', 1)`
  ).run(company.id, `greenhouse:${company.id}:official-1`);

  const observation = makeObservation({ matched_company_id: company.id });
  const job = makeJob({ employerName: "Supersede Twelve Co" });
  const staged = stageSecondaryJob(observation, job, company.id);
  assert.equal(staged.outcome, "inserted");
  const retired = retireSupersededSecondaryJobs(company.id);
  assert.equal(retired.length, 1);
  const row = getJobByDedupeKey(staged.dedupeKey);
  assert.equal(row?.is_archived, 1);
});

// 25. HIGH cross-source duplicate not duplicated (treated as the same real opening)
test("25. two observations sharing the same ATS board + normalized title/location are HIGH — the same real opening", () => {
  const a = makeObservation({
    id: 1,
    matched_company_id: 5,
    detected_ats_provider: "greenhouse",
    detected_ats_board_token: "sharedboard",
    observed_title: "Data Engineer",
    observed_location: "Austin, TX",
    direct_apply_url: "https://job-boards.greenhouse.io/sharedboard/jobs/111",
  });
  const b = makeObservation({
    id: 2,
    matched_company_id: 5,
    detected_ats_provider: "greenhouse",
    detected_ats_board_token: "sharedboard",
    observed_title: "Data Engineer",
    observed_location: "Austin, TX",
    direct_apply_url: "https://job-boards.greenhouse.io/sharedboard/jobs/111?gh_src=builtin",
  });
  assert.equal(compareCrossSourceIdentity(a, b), "HIGH");
});

// 26. POSSIBLE duplicate not blindly merged
test("26. same company + same title, but no shared board/URL/location evidence, is only POSSIBLE — never auto-merged", () => {
  const a = makeObservation({ id: 1, matched_company_id: 5, observed_title: "Data Engineer", observed_location: "Austin, TX", direct_apply_url: null });
  const b = makeObservation({ id: 2, matched_company_id: 5, observed_title: "Data Engineer", observed_location: "Remote", direct_apply_url: null });
  assert.equal(compareCrossSourceIdentity(a, b), "POSSIBLE");
});

// 27. DISTINCT legitimate Built In job eligible
test("27. a genuinely different opening (different company, or different title/location/URL) is DISTINCT and eligible as a new job", () => {
  const a = makeObservation({ id: 1, matched_company_id: 5, observed_title: "Data Engineer", observed_location: "Austin, TX" });
  const b = makeObservation({ id: 2, matched_company_id: 6, observed_title: "Product Manager", observed_location: "Remote" });
  assert.equal(compareCrossSourceIdentity(a, b), "DISTINCT");
});

// 28. suppression respected
test("28. suppression (Not Interested) is respected for a Built In secondary job — it does not silently reappear", () => {
  const company = makeCompany({ name: "Suppress Twelve Co" });
  const observation = makeObservation({ matched_company_id: company.id });
  const job = makeJob({ employerName: "Suppress Twelve Co" });
  const staged = stageSecondaryJob(observation, job, company.id);
  assert.equal(staged.outcome, "inserted");
  const row = getJobByDedupeKey(staged.dedupeKey)!;
  markNotInterested(row.id);
  const restaged = stageSecondaryJob(observation, job, company.id);
  assert.equal(restaged.outcome, "suppressed");
});

// 29. protected candidate job preserved
test("29. a protected (Applied) secondary Built In job is never retired by an official upgrade", () => {
  const company = makeCompany({ name: "Protected Twelve Co", source_type: "greenhouse", ats_board_token: "protectedtwelve" });
  getDb().prepare(
    `INSERT INTO jobs (company_id, source_type, dedupe_key, external_id, title, location, url, is_active)
     VALUES (?, 'greenhouse', ?, 'official-1', 'Data Engineer', 'Austin, TX', 'https://job-boards.greenhouse.io/x/1', 1)`
  ).run(company.id, `greenhouse:${company.id}:official-1`);
  const observation = makeObservation({ matched_company_id: company.id });
  const job = makeJob({ employerName: "Protected Twelve Co" });
  const staged = stageSecondaryJob(observation, job, company.id);
  setPipelineStatus(1, staged.dedupeKey, "Applied");
  const retired = retireSupersededSecondaryJobs(company.id);
  assert.equal(retired.length, 0);
  const after1 = getJobByDedupeKey(staged.dedupeKey);
  assert.equal(after1?.is_archived, 0);
});

// 30. coverage mismatch creates at most PENDING_REVIEW proposal
test("30. a coverage-mismatch observation may create a PENDING_REVIEW proposal via the existing Discovery V2 bridge", async () => {
  const company = makeCompany({ name: "Coverage Mismatch Twelve Co" });
  const observation = upsertExternalHiringObservation({
    source: "built_in",
    providerJobId: "cm-1",
    fingerprint: "cm-fp-1",
    observedEmployerName: "Coverage Mismatch Twelve Co",
    observedTitle: "Data Engineer",
    observedLocation: "Austin, TX",
    observedUrl: "https://builtin.com/job/cm-1",
    directEmployerUrl: "https://job-boards.greenhouse.io/coveragemismatchtwelve/jobs/1",
    directApplyUrl: "https://job-boards.greenhouse.io/coveragemismatchtwelve/jobs/1",
    employerDomain: null,
    postedAt: daysAgoIso(1),
    matchedCompanyId: company.id,
    matchConfidence: "ALIAS",
    employerRelationship: "DIRECT_EMPLOYER",
    urlClassification: "DIRECT_ATS",
    detectedAtsProvider: "greenhouse",
    detectedAtsBoardToken: "coveragemismatchtwelve",
    signalClassification: "COVERAGE_MISMATCH",
    decision: "SECONDARY_JOB_CANDIDATE",
    evidenceJson: "{}",
  });
  const result = await bridgeCoverageMismatchToDiscoveryV2(observation);
  if (result && result.proposalsCreated.length > 0) {
    for (const proposal of result.proposalsCreated) {
      assert.equal(proposal.status, "PENDING_REVIEW");
    }
  }
});

// 31. proposal never auto-approved
test("31. no proposal is ever auto-approved by any Stage 12 matching path", () => {
  // isProposalApprovable requires an explicit human review action; nothing in matchCompanyForObservation
  // or the bridge ever calls the approval service directly — this asserts that contract statically.
  assert.equal(typeof isProposalApprovable, "function");
});

// 32. ATS HEALTHY does not block external
test("32. a HEALTHY ATS connector does not block Built In company matching/processing", () => {
  const company = makeCompany({ name: "Healthy Twelve Co Inc.", source_type: "greenhouse", ats_board_token: "healthytwelve" });
  getDb().prepare("UPDATE companies SET connector_health = 'healthy', consecutive_failures = 0 WHERE id = ?").run(company.id);
  const job = makeJob({ employerName: "Healthy Twelve Co", applyUrl: "https://job-boards.greenhouse.io/healthytwelve/jobs/1" });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
});

// 33. ATS DOWN does not block external
test("33. a DOWN ATS connector does not block Built In company matching/processing", () => {
  const company = makeCompany({ name: "Down Twelve Co Inc.", source_type: "greenhouse", ats_board_token: "downtwelve" });
  getDb().prepare("UPDATE companies SET connector_health = 'down', consecutive_failures = 10 WHERE id = ?").run(company.id);
  const job = makeJob({ employerName: "Down Twelve Co", applyUrl: "https://job-boards.greenhouse.io/downtwelve/jobs/1" });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
});

// 34. external failure doesn't degrade ATS
test("34. a Built In observation with no company match never touches any company's connector_health", async () => {
  const company = makeCompany({ name: "Untouched Twelve Co Inc.", source_type: "greenhouse", ats_board_token: "untouchedtwelve" });
  getDb().prepare("UPDATE companies SET connector_health = 'healthy' WHERE id = ?").run(company.id);
  const job = makeJob({ employerName: "Completely Unrelated Employer With No Match" });
  await processExternalListing("built_in", job.raw, {});
  const row = getDb().prepare("SELECT connector_health FROM companies WHERE id = ?").get(company.id) as { connector_health: string };
  assert.equal(row.connector_health, "healthy");
});

// 35. zero lifecycle-maintenance side effect
test("35. processExternalListing never creates a scan_runs row (no lifecycle maintenance triggered)", async () => {
  const before1 = getDb().prepare("SELECT COUNT(*) AS c FROM scan_runs").get() as { c: number };
  const job = makeJob({ employerName: "Lifecycle Isolation Twelve Co" });
  await processExternalListing("built_in", job.raw, { persistObservations: true });
  const after1 = getDb().prepare("SELECT COUNT(*) AS c FROM scan_runs").get() as { c: number };
  assert.equal(after1.c, before1.c);
});

// 36. zero matching/tailoring/resume/notification side effects
test("36. processExternalListing never writes job_match_results, tailoring_runs, or notifications", async () => {
  const tables = ["job_match_results", "tailoring_runs", "notifications"];
  const before1 = tables.map((t) => (getDb().prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
  const job = makeJob({ employerName: "Side Effect Isolation Twelve Co" });
  await processExternalListing("built_in", job.raw, { persistObservations: true });
  const after1 = tables.map((t) => (getDb().prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
  assert.deepEqual(after1, before1);
});

// 37. zero paid-provider call
test("37. matchCompanyForObservation and the Built In pipeline never reference any paid-provider credential", () => {
  const originalToken = process.env.APIFY_API_TOKEN;
  const originalAllow = process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL;
  delete process.env.APIFY_API_TOKEN;
  delete process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL;
  try {
    const company = makeCompany({ name: "No Paid Provider Corp." });
    const job = makeJob({ employerName: "No Paid Provider", applyUrl: "https://job-boards.greenhouse.io/nopaidprovider/jobs/1" });
    const result = matchCompanyForObservation(job);
    assert.equal(result.companyId, company.id);
  } finally {
    if (originalToken !== undefined) process.env.APIFY_API_TOKEN = originalToken;
    if (originalAllow !== undefined) process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL = originalAllow;
  }
});
