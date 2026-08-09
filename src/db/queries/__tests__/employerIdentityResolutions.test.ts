import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { DomainIdentityResult } from "../../../types";

let tmpDir: string;
let getEmployerIdentityResolution: typeof import("../employerIdentityResolutions").getEmployerIdentityResolution;
let recordEmployerIdentityResolution: typeof import("../employerIdentityResolutions").recordEmployerIdentityResolution;
let recordCareersEvidence: typeof import("../employerIdentityResolutions").recordCareersEvidence;
let listEmployerIdentityResolutions: typeof import("../employerIdentityResolutions").listEmployerIdentityResolutions;
let getDb: typeof import("../../index").getDb;
let sponsorId: number;
let companyId: number;

const VERIFIED_RESULT: DomainIdentityResult = {
  status: "VERIFIED",
  domain: "acme.com",
  method: "generated_verified_multisignal",
  confidence: "medium",
  evidence: ["jsonld_legalname_match", "footer_copyright_match"],
  channelsChecked: { jsonLd: "match", footer: "match", aboutPage: "not_checked", termsPrivacyPage: "not_checked" },
  careersEvidence: null,
};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-eir-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getEmployerIdentityResolution, recordEmployerIdentityResolution, recordCareersEvidence, listEmployerIdentityResolutions } =
    await import("../employerIdentityResolutions"));
  ({ getDb } = await import("../../index"));
  const db = getDb();
  const sponsor = db
    .prepare(
      `INSERT INTO h1b_sponsors (employer_name_raw, employer_name_normalized, total_lca_certified)
       VALUES ('Acme Technologies Inc', 'ACME TECHNOLOGIES', 42) RETURNING id`
    )
    .get() as { id: number };
  sponsorId = sponsor.id;
  const company = db
    .prepare(`INSERT INTO companies (name, source_type) VALUES ('Acme', 'career_link') RETURNING id`)
    .get() as { id: number };
  companyId = company.id;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("recordEmployerIdentityResolution persists a VERIFIED result and round-trips it", () => {
  const row = recordEmployerIdentityResolution(sponsorId, VERIFIED_RESULT, companyId);
  assert.equal(row.h1b_sponsor_id, sponsorId);
  assert.equal(row.resolved_company_id, companyId);
  assert.equal(row.domain_identity_status, "VERIFIED");
  assert.equal(row.domain, "acme.com");
  assert.equal(row.resolution_method, "generated_verified_multisignal");
  assert.ok(row.resolved_at, "VERIFIED is a terminal outcome — resolved_at must be set");
  assert.deepEqual(JSON.parse(row.evidence!), VERIFIED_RESULT.evidence);
  assert.deepEqual(JSON.parse(row.channels_checked!), VERIFIED_RESULT.channelsChecked);
});

test("FAILED_TEMPORARY leaves resolved_at null (retry-eligible, not terminal)", () => {
  const failedSponsor = getDb()
    .prepare(
      `INSERT INTO h1b_sponsors (employer_name_raw, employer_name_normalized, total_lca_certified)
       VALUES ('Transient Co', 'TRANSIENT', 5) RETURNING id`
    )
    .get() as { id: number };
  const result: DomainIdentityResult = {
    status: "FAILED_TEMPORARY",
    domain: null,
    method: "unresolved",
    confidence: null,
    evidence: [],
    channelsChecked: { jsonLd: "not_checked", footer: "not_checked", aboutPage: "not_checked", termsPrivacyPage: "not_checked" },
    careersEvidence: null,
  };
  const row = recordEmployerIdentityResolution(failedSponsor.id, result, null);
  assert.equal(row.domain_identity_status, "FAILED_TEMPORARY");
  assert.equal(row.resolved_at, null);
});

test("re-recording upserts on h1b_sponsor_id rather than duplicating rows", () => {
  const before1 = listEmployerIdentityResolutions().length;
  recordEmployerIdentityResolution(sponsorId, { ...VERIFIED_RESULT, domain: "acme.io" }, companyId);
  const after1 = listEmployerIdentityResolutions().length;
  assert.equal(after1, before1, "same h1b_sponsor_id must update in place, not insert a second row");
  assert.equal(getEmployerIdentityResolution(sponsorId)!.domain, "acme.io");
});

test("recordCareersEvidence attaches the additive snapshot without touching domain_identity_status", () => {
  const beforeRow = getEmployerIdentityResolution(sponsorId)!;
  recordCareersEvidence(sponsorId, {
    checkedAt: "2026-08-09T00:00:00.000Z",
    sourceResolutionStatus: "FAILED_TEMPORARY",
    discoveredJobsUrl: null,
  });
  const afterRow = getEmployerIdentityResolution(sponsorId)!;
  assert.equal(afterRow.domain_identity_status, beforeRow.domain_identity_status, "careers evidence is additive only");
  assert.equal(afterRow.careers_source_resolution_status, "FAILED_TEMPORARY");
});

test("BOUNDARY: recording an employer identity resolution never touches H1B sponsorship scoring or Phase 2 tables", () => {
  const db = getDb();
  const companyBefore = db.prepare("SELECT h1b_confidence, h1b_match_tier FROM companies WHERE id = ?").get(companyId);
  const matchResultsCountBefore = (db.prepare("SELECT COUNT(*) n FROM job_match_results").get() as { n: number }).n;

  recordEmployerIdentityResolution(sponsorId, VERIFIED_RESULT, companyId);

  const companyAfter = db.prepare("SELECT h1b_confidence, h1b_match_tier FROM companies WHERE id = ?").get(companyId);
  const matchResultsCountAfter = (db.prepare("SELECT COUNT(*) n FROM job_match_results").get() as { n: number }).n;

  assert.deepEqual(companyAfter, companyBefore, "employer identity resolution must never write companies.h1b_* columns");
  assert.equal(matchResultsCountAfter, matchResultsCountBefore, "employer identity resolution must never touch job_match_results");
});
