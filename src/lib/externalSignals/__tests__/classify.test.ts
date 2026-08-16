import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CompanyMatchResult, NormalizedExternalJob } from "../types";

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let updateCompanyDomainIdentity: typeof import("@/db/queries/companies").updateCompanyDomainIdentity;
let classifyEmployerRelationship: typeof import("../classify").classifyEmployerRelationship;
let classifyUrlEvidence: typeof import("../classify").classifyUrlEvidence;
let classifySignal: typeof import("../classify").classifySignal;
let evaluateQualityGate: typeof import("../classify").evaluateQualityGate;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-external-signals-classify-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ createCompany, updateCompanyDomainIdentity } = await import("@/db/queries/companies"));
  ({ classifyEmployerRelationship, classifyUrlEvidence, classifySignal, evaluateQualityGate } = await import("../classify"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeJob(overrides: Partial<NormalizedExternalJob> = {}): NormalizedExternalJob {
  return {
    source: "indeed",
    providerJobId: "job-1",
    employerName: "Acme Robotics",
    title: "Data Engineer",
    location: "Austin, TX",
    description: "A".repeat(150),
    postedAt: null,
    listingUrl: "https://www.indeed.com/viewjob?jk=job-1",
    applyUrl: "https://acmerobotics.com/careers/data-engineer",
    directEmployerUrl: "https://acmerobotics.com/careers/data-engineer",
    employmentType: "Full-time",
    salaryText: null,
    raw: {},
    ...overrides,
  };
}

const UNMATCHED: CompanyMatchResult = { companyId: null, confidence: "UNMATCHED", reason: "test" };

// 7. Staffing agency rejection
test("7. an employer name with staffing-agency language is classified STAFFING_AGENCY regardless of match", () => {
  const job = makeJob({ employerName: "Confidential Client via BrightStar Staffing" });
  const relationship = classifyEmployerRelationship(job, UNMATCHED);
  assert.equal(relationship, "STAFFING_AGENCY");
});

test("a confidently-matched company whose apply destination resolves to an unrelated third-party domain is STAFFING_AGENCY even with clean employer-name language", () => {
  const company = createCompany({ name: "Real Employer Co", source_type: "career_link", career_page_url: "https://realemployer.com" });
  updateCompanyDomainIdentity(company.id, { verifiedDomain: "realemployer.com", domainIdentityStatus: "VERIFIED" });
  const match: CompanyMatchResult = { companyId: company.id, confidence: "ALIAS", reason: "test" };
  const job = makeJob({ employerName: "Real Employer Co", directEmployerUrl: "https://totallydifferentagency.com/apply/123", applyUrl: "https://totallydifferentagency.com/apply/123" });
  assert.equal(classifyEmployerRelationship(job, match), "STAFFING_AGENCY");
});

test("a DOMAIN-confidence match with no agency language and a matching destination domain is DIRECT_EMPLOYER", () => {
  const company = createCompany({ name: "Acme Robotics", source_type: "career_link", career_page_url: "https://acmerobotics.com" });
  updateCompanyDomainIdentity(company.id, { verifiedDomain: "acmerobotics.com", domainIdentityStatus: "VERIFIED" });
  const match: CompanyMatchResult = { companyId: company.id, confidence: "DOMAIN", reason: "test" };
  const job = makeJob();
  assert.equal(classifyEmployerRelationship(job, match), "DIRECT_EMPLOYER");
});

// 12. Direct Workday URL detection (via detectAtsFromUrlString reuse)
test("12. a direct employer URL resolving to a real Workday board is classified DIRECT_ATS", () => {
  const job = makeJob({ directEmployerUrl: "https://acmerobotics.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Data-Engineer_R12345", applyUrl: "https://acmerobotics.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Data-Engineer_R12345" });
  const result = classifyUrlEvidence(job, UNMATCHED);
  assert.equal(result.classification, "DIRECT_ATS");
  assert.equal(result.provider, "workday");
});

// 13. Direct Greenhouse URL detection
test("13. a direct employer URL resolving to a real Greenhouse board is classified DIRECT_ATS", () => {
  const job = makeJob({ directEmployerUrl: "https://boards.greenhouse.io/acmerobotics/jobs/9988776", applyUrl: "https://boards.greenhouse.io/acmerobotics/jobs/9988776" });
  const result = classifyUrlEvidence(job, UNMATCHED);
  assert.equal(result.classification, "DIRECT_ATS");
  assert.equal(result.provider, "greenhouse");
});

// 11. Aggregator-only URL classified correctly
test("11. a listing with no direct/apply URL at all is classified AGGREGATOR_ONLY", () => {
  const job = makeJob({ directEmployerUrl: null, applyUrl: null });
  const result = classifyUrlEvidence(job, UNMATCHED);
  assert.equal(result.classification, "AGGREGATOR_ONLY");
});

// 9. US filtering
test("9. a non-US location is rejected NON_US by the quality gate", () => {
  const match: CompanyMatchResult = { companyId: 1, confidence: "DOMAIN", reason: "test" };
  const job = makeJob({ location: "London, United Kingdom" });
  assert.equal(evaluateQualityGate(job, match, "DIRECT_EMPLOYER", "DIRECT_ATS"), "NON_US");
});

// 10. Stale listing rejection
test("10. a posting older than the freshness window is rejected STALE", () => {
  const match: CompanyMatchResult = { companyId: 1, confidence: "DOMAIN", reason: "test" };
  const staleDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  const job = makeJob({ postedAt: staleDate });
  assert.equal(evaluateQualityGate(job, match, "DIRECT_EMPLOYER", "DIRECT_ATS"), "STALE");
});

test("a non-ISO relative posted date (Google Jobs' own format) is not treated as evidence of staleness", () => {
  const match: CompanyMatchResult = { companyId: 1, confidence: "DOMAIN", reason: "test" };
  const job = makeJob({ postedAt: "2 days ago" });
  assert.notEqual(evaluateQualityGate(job, match, "DIRECT_EMPLOYER", "DIRECT_ATS"), "STALE");
});

// 14 (Phase 8 "official-equivalent detection" mapped onto ALREADY_COVERED signal classification)
test("14. a company already adequately covered (active jobs + VERIFIED source) classifies as ALREADY_COVERED", () => {
  const match: CompanyMatchResult = { companyId: 1, confidence: "DOMAIN", reason: "test" };
  const signal = classifySignal(match, "DIRECT_EMPLOYER", { activeJobCount: 5, resolutionStatus: "VERIFIED" });
  assert.equal(signal, "ALREADY_COVERED");
});

// 15/16/17. Coverage mismatch detection + zero-job unresolved company prioritized
test("15/17. a zero-active-job UNRESOLVED company with a direct-employer match classifies as COVERAGE_MISMATCH", () => {
  const match: CompanyMatchResult = { companyId: 1, confidence: "DOMAIN", reason: "test" };
  const signal = classifySignal(match, "DIRECT_EMPLOYER", { activeJobCount: 0, resolutionStatus: "UNRESOLVED" });
  assert.equal(signal, "COVERAGE_MISMATCH");
});

test("16. inadequate coverage with only an UNKNOWN employer relationship is a weaker EXTERNAL_HIRING_SIGNAL, not COVERAGE_MISMATCH", () => {
  const match: CompanyMatchResult = { companyId: 1, confidence: "ALIAS", reason: "test" };
  const signal = classifySignal(match, "UNKNOWN_EMPLOYER_RELATIONSHIP", { activeJobCount: 0, resolutionStatus: "UNRESOLVED" });
  assert.equal(signal, "EXTERNAL_HIRING_SIGNAL");
});

test("an agency-classified relationship is always AGENCY_FILTERED regardless of coverage state", () => {
  const match: CompanyMatchResult = { companyId: 1, confidence: "DOMAIN", reason: "test" };
  const signal = classifySignal(match, "STAFFING_AGENCY", { activeJobCount: 0, resolutionStatus: "UNRESOLVED" });
  assert.equal(signal, "AGENCY_FILTERED");
});

test("an unmatched observation has NO_SIGNAL; an ambiguous one has AMBIGUOUS", () => {
  assert.equal(classifySignal({ companyId: null, confidence: "UNMATCHED", reason: "x" }, "UNKNOWN_EMPLOYER_RELATIONSHIP", null), "NO_SIGNAL");
  assert.equal(classifySignal({ companyId: null, confidence: "AMBIGUOUS", reason: "x" }, "UNKNOWN_EMPLOYER_RELATIONSHIP", null), "AMBIGUOUS");
});

// 11 (Phase 21 numbering: missing-description handling)
test("11b. a listing with no meaningful description fails the quality gate as LOW_QUALITY", () => {
  const match: CompanyMatchResult = { companyId: 1, confidence: "DOMAIN", reason: "test" };
  const job = makeJob({ description: "short" });
  assert.equal(evaluateQualityGate(job, match, "DIRECT_EMPLOYER", "DIRECT_ATS"), "LOW_QUALITY");
});

test("a fully-qualifying DIRECT_EMPLOYER + DIRECT_ATS listing with a known-fresh posted date passes the quality gate (returns null)", () => {
  const match: CompanyMatchResult = { companyId: 1, confidence: "DOMAIN", reason: "test" };
  const job = makeJob({ postedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() });
  assert.equal(evaluateQualityGate(job, match, "DIRECT_EMPLOYER", "DIRECT_ATS"), null);
});

test("an UNKNOWN employer relationship never passes the quality gate, even with otherwise-perfect evidence (including a known-fresh date)", () => {
  const match: CompanyMatchResult = { companyId: 1, confidence: "ALIAS", reason: "test" };
  const job = makeJob({ postedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() });
  assert.equal(evaluateQualityGate(job, match, "UNKNOWN_EMPLOYER_RELATIONSHIP", "DIRECT_ATS"), "DISCOVERY_BEACON_ONLY");
});
