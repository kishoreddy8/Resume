import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let getDb: typeof import("../../index").getDb;
let createCompany: typeof import("../companies").createCompany;
let recordDiscoveryResult: typeof import("../companies").recordDiscoveryResult;
let updateCompanyDomainIdentity: typeof import("../companies").updateCompanyDomainIdentity;
let getOrganizationForCompany: typeof import("../organizationRegistry").getOrganizationForCompany;
let listOrganizationAliases: typeof import("../organizationRegistry").listOrganizationAliases;
let addOrganizationAlias: typeof import("../organizationRegistry").addOrganizationAlias;
let listOrganizationDomains: typeof import("../organizationRegistry").listOrganizationDomains;
let listJobSources: typeof import("../organizationRegistry").listJobSources;
let addJobSource: typeof import("../organizationRegistry").addJobSource;
let listScanReadyCompanies: typeof import("../organizationRegistry").listScanReadyCompanies;
let reviewJobSource: typeof import("../organizationRegistry").reviewJobSource;
let runOrganizationRegistryBackfill: typeof import("../../organizationRegistryCore").runOrganizationRegistryBackfill;
let syncLegacyCompanyToOrganizationRegistry: typeof import("../../organizationRegistryCore").syncLegacyCompanyToOrganizationRegistry;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-org-registry-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
  ({ createCompany, recordDiscoveryResult, updateCompanyDomainIdentity } = await import("../companies"));
  ({
    getOrganizationForCompany,
    listOrganizationAliases,
    addOrganizationAlias,
    listOrganizationDomains,
    listJobSources,
    addJobSource,
    listScanReadyCompanies,
    reviewJobSource,
  } = await import("../organizationRegistry"));
  ({ runOrganizationRegistryBackfill, syncLegacyCompanyToOrganizationRegistry } = await import("../../organizationRegistryCore"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("createCompany transactionally dual-writes one organization, alias, compatibility link, and source", () => {
  const company = createCompany({
    name: "Acme Holdings, Inc.",
    source_type: "greenhouse",
    ats_board_token: "acme-holdings",
  });
  const organization = getOrganizationForCompany(company.id);
  assert.ok(organization);
  assert.equal(organization.canonical_name, company.name);

  const aliases = listOrganizationAliases(organization.id);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].alias, company.name);
  assert.equal(aliases[0].alias_normalized, "ACME HOLDINGS, INC.");
  assert.equal(aliases[0].provenance_key, String(company.id));

  const sources = listJobSources(organization.id);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].provider, "greenhouse");
  assert.equal(sources[0].source_key, "acme-holdings");
  assert.equal(sources[0].legacy_company_id, company.id);
  assert.equal(sources[0].is_authoritative, 1);
});

test("one organization can hold multiple aliases and multiple ATS/job sources", () => {
  const company = createCompany({
    name: "Multi Source Corp",
    source_type: "career_link",
    career_page_url: "https://multisource.example/careers",
  });
  const organization = getOrganizationForCompany(company.id)!;

  addOrganizationAlias({
    organizationId: organization.id,
    alias: "Multi Source Technologies LLC",
    aliasType: "legal",
    provenanceSource: "dol_perm",
    provenanceKey: "perm:multi-source-technologies",
    evidence: "PERM employer name",
  });
  addJobSource({
    organizationId: organization.id,
    provider: "workday",
    sourceKey: "multisource|wd5|External",
    sourceUrl: "https://multisource.wd5.myworkdayjobs.com/External",
    resolutionStatus: "VERIFIED",
    isAuthoritative: true,
  });

  assert.equal(listOrganizationAliases(organization.id).length, 2);
  assert.equal(listJobSources(organization.id).length, 2);
});

test("ATS provider/source identity is globally unique and never silently attached to two organizations", () => {
  const first = createCompany({ name: "Unique Board A", source_type: "career_link" });
  const second = createCompany({ name: "Unique Board B", source_type: "career_link" });
  const firstOrg = getOrganizationForCompany(first.id)!;
  const secondOrg = getOrganizationForCompany(second.id)!;
  addJobSource({ organizationId: firstOrg.id, provider: "lever", sourceKey: "shared-board" });
  assert.throws(
    () => addJobSource({ organizationId: secondOrg.id, provider: "lever", sourceKey: "shared-board" }),
    /UNIQUE constraint failed/,
    "a duplicate board must surface for review instead of silently merging organizations"
  );
});

test("a reviewed multi-company merge cannot have its canonical name overwritten by an arbitrary legacy sync", () => {
  const parent = createCompany({ name: "Chosen Parent Name", source_type: "career_link" });
  const subsidiary = createCompany({ name: "Subsidiary Legal LLC", source_type: "career_link" });
  const parentOrg = getOrganizationForCompany(parent.id)!;
  const subsidiaryOrg = getOrganizationForCompany(subsidiary.id)!;
  const db = getDb();

  db.transaction(() => {
    db.prepare("DELETE FROM organization_company_links WHERE company_id = ?").run(subsidiary.id);
    db.prepare("UPDATE job_sources SET organization_id = ? WHERE legacy_company_id = ?")
      .run(parentOrg.id, subsidiary.id);
    db.prepare("INSERT INTO organization_company_links (company_id, organization_id) VALUES (?, ?)")
      .run(subsidiary.id, parentOrg.id);
    db.prepare("DELETE FROM organizations WHERE id = ?").run(subsidiaryOrg.id);
    syncLegacyCompanyToOrganizationRegistry(db, subsidiary.id);
  })();

  assert.equal(getOrganizationForCompany(parent.id)!.canonical_name, "Chosen Parent Name");
  assert.equal(getOrganizationForCompany(subsidiary.id)!.id, parentOrg.id);
});

test("recordDiscoveryResult promotes the existing compatibility source in place instead of duplicating it", () => {
  const company = createCompany({
    name: "Promoted Source Co",
    source_type: "career_link",
    career_page_url: "https://promoted.example/careers",
  });
  const organization = getOrganizationForCompany(company.id)!;
  const originalSourceId = listJobSources(organization.id)[0].id;

  recordDiscoveryResult(company.id, {
    status: "VERIFIED",
    sourceType: "ashby",
    atsBoardToken: "promoted-source",
    discoveredJobsUrl: "https://jobs.ashbyhq.com/promoted-source",
    reason: "Direct ATS URL match (ashby)",
    suspectedAts: null,
  });

  const sources = listJobSources(organization.id);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, originalSourceId);
  assert.equal(sources[0].provider, "ashby");
  assert.equal(sources[0].source_key, "promoted-source");
  assert.equal(sources[0].resolution_status, "VERIFIED");
  assert.equal(sources[0].is_authoritative, 1);
  assert.equal(sources[0].review_status, "PENDING");
  assert.ok(
    !listScanReadyCompanies().some((candidate) => candidate.id === company.id),
    "an automated structured result must remain blocked until reviewed"
  );
  reviewJobSource(sources[0].id, "APPROVED", "Validated company-specific public board");
  assert.ok(
    listScanReadyCompanies().some((candidate) => candidate.id === company.id),
    "a verified structured source must be available to the safe ATS-only loader"
  );

  recordDiscoveryResult(company.id, {
    status: "VERIFIED",
    sourceType: "lever",
    atsBoardToken: "promoted-source-v2",
    discoveredJobsUrl: "https://jobs.lever.co/promoted-source-v2",
    reason: "Newly rediscovered source identity",
    suspectedAts: null,
  });
  const changedSource = listJobSources(organization.id)[0];
  assert.equal(changedSource.review_status, "PENDING");
  assert.equal(changedSource.reviewed_at, null);
  assert.equal(changedSource.review_evidence, null);
  assert.ok(
    !listScanReadyCompanies().some((candidate) => candidate.id === company.id),
    "changing provider/source identity must invalidate the previous approval"
  );
});

test("verified domain updates dual-write normalized domain evidence without changing source identity", () => {
  const company = createCompany({ name: "Domain Co", source_type: "career_link" });
  const organization = getOrganizationForCompany(company.id)!;
  const sourceId = listJobSources(organization.id)[0].id;

  updateCompanyDomainIdentity(company.id, {
    verifiedDomain: "https://www.Domain-Co.Example/about/company?source=identity",
    domainIdentityStatus: "VERIFIED",
  });

  const domains = listOrganizationDomains(organization.id);
  assert.equal(domains.length, 1);
  assert.equal(domains[0].domain, "domain-co.example");
  assert.equal(domains[0].identity_status, "VERIFIED");
  assert.ok(domains[0].verified_at);
  assert.equal(listJobSources(organization.id)[0].id, sourceId);
});

test("legacy compatibility sync preserves reviewed domain evidence", () => {
  const company = createCompany({ name: "Reviewed Domain Co", source_type: "career_link" });
  const organization = getOrganizationForCompany(company.id)!;
  updateCompanyDomainIdentity(company.id, {
    verifiedDomain: "reviewed.example",
    domainIdentityStatus: "VERIFIED",
  });

  const db = getDb();
  db.prepare(
    `UPDATE organization_domains
     SET resolution_method = 'curated', resolution_confidence = 'high', evidence = 'Manual first-party review'
     WHERE organization_id = ? AND domain = 'reviewed.example'`
  ).run(organization.id);

  syncLegacyCompanyToOrganizationRegistry(db, company.id);

  const [domain] = listOrganizationDomains(organization.id);
  assert.equal(domain.resolution_method, "curated");
  assert.equal(domain.resolution_confidence, "high");
  assert.equal(domain.evidence, "Manual first-party review");
});

test("existing-database backfill is idempotent and preserves all legacy company rows", () => {
  const db = getDb();
  const direct = db.prepare(
    `INSERT INTO companies (name, source_type, career_page_url)
     VALUES ('Legacy Direct Insert', 'career_link', 'https://legacy-direct.example/jobs')
     RETURNING id`
  ).get() as { id: number };
  const companiesBefore = (db.prepare("SELECT COUNT(*) n FROM companies").get() as { n: number }).n;

  runOrganizationRegistryBackfill(db);
  const firstOrganization = getOrganizationForCompany(direct.id);
  assert.ok(firstOrganization, "a pre-registry legacy company must be projected on migration");
  const countsAfterFirst = {
    organizations: (db.prepare("SELECT COUNT(*) n FROM organizations").get() as { n: number }).n,
    links: (db.prepare("SELECT COUNT(*) n FROM organization_company_links").get() as { n: number }).n,
    aliases: (db.prepare("SELECT COUNT(*) n FROM organization_aliases").get() as { n: number }).n,
    sources: (db.prepare("SELECT COUNT(*) n FROM job_sources").get() as { n: number }).n,
  };

  runOrganizationRegistryBackfill(db);
  const countsAfterSecond = {
    organizations: (db.prepare("SELECT COUNT(*) n FROM organizations").get() as { n: number }).n,
    links: (db.prepare("SELECT COUNT(*) n FROM organization_company_links").get() as { n: number }).n,
    aliases: (db.prepare("SELECT COUNT(*) n FROM organization_aliases").get() as { n: number }).n,
    sources: (db.prepare("SELECT COUNT(*) n FROM job_sources").get() as { n: number }).n,
  };

  assert.deepEqual(countsAfterSecond, countsAfterFirst, "rerunning the backfill must create no duplicates");
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM companies").get() as { n: number }).n,
    companiesBefore,
    "the additive backfill must never delete or duplicate legacy companies"
  );
  assert.equal(
    (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length,
    0,
    "the compatibility registry must leave every foreign key valid"
  );
});
