import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedExternalJob } from "../types";

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let getOrganizationForCompany: typeof import("@/db/queries/organizationRegistry").getOrganizationForCompany;
let addOrganizationDomain: typeof import("@/db/queries/organizationRegistry").addOrganizationDomain;
let addOrganizationAlias: typeof import("@/db/queries/organizationRegistry").addOrganizationAlias;
let matchCompanyForObservation: typeof import("../companyMatch").matchCompanyForObservation;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-external-signals-company-match-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ getOrganizationForCompany, addOrganizationDomain, addOrganizationAlias } = await import("@/db/queries/organizationRegistry"));
  ({ matchCompanyForObservation } = await import("../companyMatch"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeJob(overrides: Partial<NormalizedExternalJob> = {}): NormalizedExternalJob {
  return {
    source: "indeed",
    providerJobId: "job-1",
    employerName: "",
    title: "Data Engineer",
    location: "Austin, TX",
    description: "A real job description with enough content to be meaningful for testing purposes here.",
    postedAt: null,
    listingUrl: "https://www.indeed.com/viewjob?jk=job-1",
    applyUrl: null,
    directEmployerUrl: null,
    employmentType: "Full-time",
    salaryText: null,
    raw: {},
    ...overrides,
  };
}

let counter = 0;
function makeVerifiedCompany(name: string, domain: string) {
  counter++;
  const company = createCompany({ name, source_type: "greenhouse", ats_board_token: `token-${counter}` });
  const org = getOrganizationForCompany(company.id)!;
  addOrganizationDomain({ organizationId: org.id, domain, identityStatus: "VERIFIED" });
  return company;
}

// 4. Company-domain matching
test("4. a direct employer URL whose domain matches a company's VERIFIED organization domain resolves with DOMAIN confidence", () => {
  const company = makeVerifiedCompany("Acme Robotics, Inc.", "acmerobotics.com");
  const job = makeJob({ employerName: "Acme Robotics", directEmployerUrl: "https://acmerobotics.com/careers/data-engineer" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, company.id);
  assert.equal(result.confidence, "DOMAIN");
});

// 5. Alias matching — "Microsoft" / "Microsoft Corporation" / "Microsoft Corp." style equivalence
test("5. an employer name matching an organization alias (not the primary name) resolves with ALIAS confidence", () => {
  const company = createCompany({ name: "Microsoft Corporation", source_type: "greenhouse", ats_board_token: "ms-token" });
  const org = getOrganizationForCompany(company.id)!;
  addOrganizationAlias({ organizationId: org.id, alias: "Microsoft Corp.", aliasType: "dba", provenanceSource: "test_fixture", evidence: "Test alias" });

  const job = makeJob({ employerName: "Microsoft Corp." });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, company.id);
  assert.equal(result.confidence, "ALIAS");
});

test("5b. the company's own primary name (auto-aliased at creation) also resolves with ALIAS confidence", () => {
  const company = createCompany({ name: "Uniquely Named Test Corp", source_type: "greenhouse", ats_board_token: "unique-token" });
  const job = makeJob({ employerName: "Uniquely Named Test Corp" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, company.id);
  assert.equal(result.confidence, "ALIAS");
});

// 6. Ambiguous company name rejected
test("6. an employer name matching more than one CareerOps company is AMBIGUOUS, never auto-resolved", () => {
  const orgA = createCompany({ name: "Shared Name Holdings", source_type: "greenhouse", ats_board_token: "shared-a" });
  const orgAReg = getOrganizationForCompany(orgA.id)!;
  addOrganizationAlias({ organizationId: orgAReg.id, alias: "Ambiguous Co", aliasType: "dba", provenanceSource: "test_fixture_a", evidence: "x" });

  const orgB = createCompany({ name: "Other Holdings", source_type: "greenhouse", ats_board_token: "shared-b" });
  const orgBReg = getOrganizationForCompany(orgB.id)!;
  addOrganizationAlias({ organizationId: orgBReg.id, alias: "Ambiguous Co", aliasType: "dba", provenanceSource: "test_fixture_b", evidence: "x" });

  const job = makeJob({ employerName: "Ambiguous Co" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, null);
  assert.equal(result.confidence, "AMBIGUOUS");
});

// 8. Unknown company remains unmatched
test("8. an employer name with no CareerOps equivalent remains UNMATCHED", () => {
  const job = makeJob({ employerName: "Totally Unrelated Nonexistent Company XYZ" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, null);
  assert.equal(result.confidence, "UNMATCHED");
});

test("Parent/subsidiary ambiguity: a subsidiary alias is not silently guessed onto the parent without an explicit alias row", () => {
  createCompany({ name: "Parent Holdings Group", source_type: "greenhouse", ats_board_token: "parent-token" });
  const job = makeJob({ employerName: "Parent Holdings Group Subsidiary Two" });
  const result = matchCompanyForObservation(job);
  assert.equal(result.companyId, null, "a similar-but-not-identical name must not fuzzy-match a parent company");
});
