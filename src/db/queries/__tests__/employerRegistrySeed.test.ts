import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let getDb: typeof import("../../index").getDb;
let createCompany: typeof import("../companies").createCompany;
let upsertPermEmployerFiling: typeof import("../permEmployers").upsertPermEmployerFiling;
let recomputeAllPermEmployerSummaries: typeof import("../permEmployers").recomputeAllPermEmployerSummaries;
let seedOrganizationRegistryFromEmployerSources: typeof import("../../employerRegistrySeedCore").seedOrganizationRegistryFromEmployerSources;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-employer-seed-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
  ({ createCompany } = await import("../companies"));
  ({ upsertPermEmployerFiling, recomputeAllPermEmployerSummaries } = await import("../permEmployers"));
  ({ seedOrganizationRegistryFromEmployerSources } = await import("../../employerRegistrySeedCore"));
});

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("PERM filing imports replace the same dataset but add separate official form variants", () => {
  upsertPermEmployerFiling({
    employerNameRaw: "Example Employer LLC",
    employerNameNormalized: "EXAMPLE EMPLOYER",
    fiscalYear: 2024,
    datasetVariant: "legacy-form",
    certified: 2,
    denied: 1,
    withdrawn: 0,
    sourceFile: "legacy.csv",
  });
  upsertPermEmployerFiling({
    employerNameRaw: "Example Employer LLC",
    employerNameNormalized: "EXAMPLE EMPLOYER",
    fiscalYear: 2024,
    datasetVariant: "legacy-form",
    certified: 5,
    denied: 0,
    withdrawn: 1,
    sourceFile: "legacy-corrected.csv",
  });
  upsertPermEmployerFiling({
    employerNameRaw: "Example Employer LLC",
    employerNameNormalized: "EXAMPLE EMPLOYER",
    fiscalYear: 2024,
    datasetVariant: "revised-form",
    certified: 3,
    denied: 2,
    withdrawn: 0,
    sourceFile: "revised.csv",
  });
  recomputeAllPermEmployerSummaries();

  const db = getDb();
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM perm_employer_filings").get() as { n: number }).n,
    2
  );
  const rollup = db
    .prepare(
      `SELECT total_certified, total_denied, total_withdrawn
       FROM perm_employers WHERE employer_name_normalized = 'EXAMPLE EMPLOYER'`
    )
    .get() as { total_certified: number; total_denied: number; total_withdrawn: number };
  assert.deepEqual(rollup, { total_certified: 8, total_denied: 2, total_withdrawn: 1 });
});

test("H-1B and PERM records exact-match one existing organization and reseeding is idempotent", () => {
  const db = getDb();
  const company = createCompany({ name: "Acme, Inc.", source_type: "career_link" });
  const companyOrganization = db
    .prepare("SELECT organization_id FROM organization_company_links WHERE company_id = ?")
    .get(company.id) as { organization_id: number };

  db.prepare(
    `INSERT INTO h1b_sponsors (
       employer_name_raw, employer_name_normalized, total_lca_certified
     ) VALUES ('ACME LLC', 'ACME', 12)`
  ).run();
  upsertPermEmployerFiling({
    employerNameRaw: "Acme Corporation",
    employerNameNormalized: "ACME",
    fiscalYear: 2025,
    datasetVariant: "main",
    certified: 4,
    denied: 0,
    withdrawn: 0,
    sourceFile: "perm-2025.csv",
  });
  recomputeAllPermEmployerSummaries();

  const first = seedOrganizationRegistryFromEmployerSources(db);
  const countAfterFirst = (
    db.prepare("SELECT COUNT(*) n FROM organizations").get() as { n: number }
  ).n;
  assert.equal(first.organizationsCreated, 1, "the unrelated PERM fixture from the prior test is seeded");

  const acmeLinks = db
    .prepare(
      `SELECT DISTINCT organization_id FROM organization_employer_records
       WHERE employer_name_normalized = 'ACME'`
    )
    .all() as { organization_id: number }[];
  assert.deepEqual(acmeLinks, [{ organization_id: companyOrganization.organization_id }]);

  const second = seedOrganizationRegistryFromEmployerSources(db);
  const countAfterSecond = (
    db.prepare("SELECT COUNT(*) n FROM organizations").get() as { n: number }
  ).n;
  assert.equal(countAfterSecond, countAfterFirst);
  assert.equal(second.organizationsCreated, 0);
  assert.equal(second.existingLinksRefreshed, 3);
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM organization_employer_records").get() as { n: number }).n,
    3
  );
});

test("an ambiguous exact name is kept separate instead of auto-merging two organizations", () => {
  const db = getDb();
  createCompany({ name: "Shared Name, Inc.", source_type: "career_link" });
  createCompany({ name: "Shared Name LLC", source_type: "career_link" });
  upsertPermEmployerFiling({
    employerNameRaw: "Shared Name Corp",
    employerNameNormalized: "SHARED NAME",
    fiscalYear: 2025,
    datasetVariant: "main",
    certified: 1,
    denied: 0,
    withdrawn: 0,
    sourceFile: "ambiguous.csv",
  });
  recomputeAllPermEmployerSummaries();

  const beforeCount = (db.prepare("SELECT COUNT(*) n FROM organizations").get() as { n: number }).n;
  const stats = seedOrganizationRegistryFromEmployerSources(db);
  const afterCount = (db.prepare("SELECT COUNT(*) n FROM organizations").get() as { n: number }).n;
  assert.equal(stats.ambiguousNamesKeptSeparate, 1);
  assert.equal(afterCount, beforeCount + 1);
});

test("a discovered company attaches to its seeded organization without increasing org count", () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO h1b_sponsors (
       employer_name_raw, employer_name_normalized, total_lca_certified
     ) VALUES ('Discovery Bridge LLC', 'DISCOVERY BRIDGE', 7)`
  ).run();
  seedOrganizationRegistryFromEmployerSources(db);
  const sponsor = db
    .prepare("SELECT id FROM h1b_sponsors WHERE employer_name_normalized = 'DISCOVERY BRIDGE'")
    .get() as { id: number };
  const seeded = db
    .prepare(
      `SELECT organization_id FROM organization_employer_records
       WHERE source_type = 'dol_lca' AND source_record_id = ?`
    )
    .get(sponsor.id) as { organization_id: number };
  const beforeCount = (db.prepare("SELECT COUNT(*) n FROM organizations").get() as { n: number }).n;

  const company = createCompany({
    name: "Discovery Bridge LLC",
    source_type: "career_link",
    career_page_url: "https://discovery-bridge.example/careers",
    organization_id: seeded.organization_id,
  });

  const linked = db
    .prepare("SELECT organization_id FROM organization_company_links WHERE company_id = ?")
    .get(company.id) as { organization_id: number };
  assert.equal(linked.organization_id, seeded.organization_id);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM organizations").get() as { n: number }).n, beforeCount);
});
