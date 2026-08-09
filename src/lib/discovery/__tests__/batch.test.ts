import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

let tmpDir: string;
let runDiscoveryBatch: typeof import("../batch").runDiscoveryBatch;
let addDomainOverride: typeof import("../../../db/queries/h1bEmployerDomainOverrides").addDomainOverride;
let listEmployerIdentityResolutions: typeof import("../../../db/queries/employerIdentityResolutions").listEmployerIdentityResolutions;
let listDiscoveryRuns: typeof import("../../../db/queries/discoveryRuns").listDiscoveryRuns;
let normalizeEmployerName: typeof import("../../h1b/normalizeEmployerName").normalizeEmployerName;
let getDb: typeof import("../../../db/index").getDb;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-batch-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ runDiscoveryBatch } = await import("../batch"));
  ({ addDomainOverride } = await import("../../../db/queries/h1bEmployerDomainOverrides"));
  ({ listEmployerIdentityResolutions } = await import("../../../db/queries/employerIdentityResolutions"));
  ({ listDiscoveryRuns } = await import("../../../db/queries/discoveryRuns"));
  ({ normalizeEmployerName } = await import("../../h1b/normalizeEmployerName"));
  ({ getDb } = await import("../../../db/index"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM employer_identity_resolutions; DELETE FROM h1b_sponsors; DELETE FROM companies; DELETE FROM discovery_runs; DELETE FROM h1b_employer_domain_overrides;");
});

function insertSponsor(name: string, normalized: string, lca = 10, fiscalYear = 2025): number {
  const row = getDb()
    .prepare(
      `INSERT INTO h1b_sponsors (employer_name_raw, employer_name_normalized, total_lca_certified, most_recent_fiscal_year)
       VALUES (?, ?, ?, ?) RETURNING id`
    )
    .get(name, normalized, lca, fiscalYear) as { id: number };
  return row.id;
}

// Curated overrides resolve at LAYER 0 — no live network call at all — so these tests exercise
// real batch orchestration (priority selection, persistence, run recording) without depending on
// the live internet. The subsequent careers/ATS discovery step against these fake domains WILL
// fail (no real server behind them) — that's fine and expected; discoverCompanySource/
// discoverCompanySourceBrowser's own correctness is already proven in discovery.test.ts and
// discoveryBrowser.test.ts. This suite's job is batch.ts's OWN orchestration behavior only.

test("runDiscoveryBatch: attempts every eligible employer up to batchSize, persists a resolution per employer", async () => {
  const names = ["Alpha Curated Co", "Beta Curated Co", "Gamma Curated Co"];
  for (const name of names) {
    insertSponsor(name, normalizeEmployerName(name));
    addDomainOverride({ employerNameNormalized: normalizeEmployerName(name), domain: `${normalizeEmployerName(name).toLowerCase().replace(/\s+/g, "")}.test-fixture.invalid` });
  }

  const summary = await runDiscoveryBatch({ batchSize: 10, useBrowserFallback: false });
  assert.equal(summary.employersAttempted, 3);
  assert.equal(summary.domainsVerified, 3, "every employer had a curated override — all resolve VERIFIED at Layer 0");
  assert.equal(listEmployerIdentityResolutions().length, 3);
});

test("runDiscoveryBatch: batchSize independently bounds how many employers are attempted", async () => {
  // Curated overrides (Layer 0) resolve with zero network calls — this test is purely about the
  // batchSize bound, not resolution outcomes, so it stays fast and network-free like the rest of
  // this project's test suite.
  for (let i = 0; i < 5; i++) {
    const name = `Bounded Test Employer ${i}`;
    const normalized = normalizeEmployerName(name);
    insertSponsor(name, normalized);
    addDomainOverride({ employerNameNormalized: normalized, domain: `bounded-test-${i}.test-fixture.invalid` });
  }
  const summary = await runDiscoveryBatch({ batchSize: 2, useBrowserFallback: false });
  assert.equal(summary.employersAttempted, 2, "batchSize=2 must attempt exactly 2, regardless of concurrency settings");
});

test("runDiscoveryBatch: already-VERIFIED employers (from a prior run) are skipped on the next run", async () => {
  const name = "Idempotent Co";
  insertSponsor(name, normalizeEmployerName(name));
  addDomainOverride({ employerNameNormalized: normalizeEmployerName(name), domain: "idempotentco.test-fixture.invalid" });

  const first = await runDiscoveryBatch({ batchSize: 10, useBrowserFallback: false });
  assert.equal(first.employersAttempted, 1);
  assert.equal(first.domainsVerified, 1);

  const second = await runDiscoveryBatch({ batchSize: 10, useBrowserFallback: false });
  assert.equal(second.employersAttempted, 0, "already VERIFIED — the priority query must exclude it from a second run");
  assert.equal(listEmployerIdentityResolutions().length, 1, "no duplicate resolution row was created");

  const companies = getDb().prepare("SELECT COUNT(*) n FROM companies").get() as { n: number };
  assert.equal(companies.n, 1, "no duplicate companies row was created across two runs");
});

test("runDiscoveryBatch: records exactly one discovery_runs row per invocation, with accurate counters", async () => {
  const name = "Solo Co";
  insertSponsor(name, normalizeEmployerName(name));
  addDomainOverride({ employerNameNormalized: normalizeEmployerName(name), domain: "soloco.test-fixture.invalid" });

  await runDiscoveryBatch({ batchSize: 10, useBrowserFallback: false });
  const runs = listDiscoveryRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].employers_attempted, 1);
  assert.equal(runs[0].domains_verified, 1);
});

test("runDiscoveryBatch: an employer with no resolvable identity is recorded as UNRESOLVED, never crashes the batch", async () => {
  const resolvable = "Resolvable Co";
  insertSponsor(resolvable, normalizeEmployerName(resolvable));
  addDomainOverride({ employerNameNormalized: normalizeEmployerName(resolvable), domain: "resolvableco.test-fixture.invalid" });

  // A name that normalizes to EMPTY (no alphanumeric content at all) short-circuits
  // resolveDomainIdentity's first guard directly to UNRESOLVED with zero network calls — the real
  // end-to-end UNRESOLVED path, exercised without depending on the live internet (this project's
  // tests never hit real external services; a name a real Wikidata/SEC lookup might resolve
  // unpredictably would risk exactly that).
  const unresolvable = "!!! --- !!!";
  insertSponsor(unresolvable, normalizeEmployerName(unresolvable));

  const summary = await runDiscoveryBatch({ batchSize: 10, useBrowserFallback: false });
  assert.equal(summary.employersAttempted, 2, "one employer failing to resolve identity must not abort the batch");
  assert.equal(summary.domainsVerified, 1);
});
