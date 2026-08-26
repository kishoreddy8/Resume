import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/* ================================================================================================
 * ADMIN-OPS-3.2 — connector health must come from evidence, and probe evidence must never be
 * mistaken for production evidence.
 *
 * Temp database throughout. data/app.db is never opened.
 * ============================================================================================== */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let getDiscoveryConnectorHealth: typeof import("../discoveryConnectorHealth").getDiscoveryConnectorHealth;

const NOW_ISO = () => new Date().toISOString();

function seedSource(provider: string, companyName: string): { companyId: number; jobSourceId: number } {
  const db = getDb();
  db.prepare("INSERT INTO companies (name, source_type, ats_board_token, is_active) VALUES (?, ?, ?, 1)").run(
    companyName,
    provider,
    `${companyName}-token`
  );
  const companyId = (db.prepare("SELECT id FROM companies WHERE name = ?").get(companyName) as { id: number }).id;
  db.prepare("INSERT INTO organizations (canonical_name, status) VALUES (?, 'active')").run(companyName);
  const orgId = (db.prepare("SELECT id FROM organizations WHERE canonical_name = ?").get(companyName) as { id: number })
    .id;
  db.prepare(
    `INSERT INTO job_sources (organization_id, provider, source_key, resolution_status, review_status, is_active, legacy_company_id)
     VALUES (?, ?, ?, 'VERIFIED', 'APPROVED', 1, ?)`
  ).run(orgId, provider, `${companyName}-key`, companyId);
  const jobSourceId = (db.prepare("SELECT id FROM job_sources WHERE legacy_company_id = ?").get(companyId) as {
    id: number;
  }).id;
  return { companyId, jobSourceId };
}

function seedProbe(provider: string, ids: { companyId: number; jobSourceId: number }, outcome: string, category?: string): void {
  const db = getDb();
  const orgId = (db.prepare("SELECT organization_id FROM job_sources WHERE id = ?").get(ids.jobSourceId) as {
    organization_id: number;
  }).organization_id;
  db.prepare(
    `INSERT INTO connector_health_check_runs
       (job_source_id, organization_id, company_id, provider, checker_version, outcome, jobs_seen,
        latency_ms, error_category, evidence_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, 'test.v1', ?, 0, 12, ?, '{}', ?, ?)`
  ).run(ids.jobSourceId, orgId, ids.companyId, provider, outcome, category ?? null, NOW_ISO(), NOW_ISO());
}

function seedScan(companyId: number, provider: string, status: string, category?: string): void {
  getDb()
    .prepare(
      `INSERT INTO scan_runs (company_id, provider, started_at, finished_at, duration_ms, status, error_category)
       VALUES (?, ?, ?, ?, 10, ?, ?)`
    )
    .run(companyId, provider, NOW_ISO(), NOW_ISO(), status, category ?? null);
}

const forProvider = (rows: Awaited<ReturnType<typeof getDiscoveryConnectorHealth>>, p: string) =>
  rows.find((r) => r.provider === p)!;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-connhealth-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ getDiscoveryConnectorHealth } = await import("../discoveryConnectorHealth"));
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM connector_health_check_runs").run();
  db.prepare("DELETE FROM scan_runs").run();
  db.prepare("DELETE FROM job_sources").run();
  db.prepare("DELETE FROM organizations").run();
  db.prepare("DELETE FROM companies").run();
});

// --- OPS3.2-HEALTH-01 / 05: absence is never health ----------------------------------------------

test("OPS3.2-HEALTH-01: a connector with no evidence at all is NO_DATA, never HEALTHY", () => {
  const rows = getDiscoveryConnectorHealth();
  assert.ok(rows.length >= 36, "every platform with a connector is listed");
  for (const row of rows) {
    assert.equal(row.probe.status, "NO_DATA", `${row.provider} probe`);
    assert.equal(row.production.status, "NO_DATA", `${row.provider} production`);
    assert.equal(row.primaryEvidence, "NONE");
  }
});

test("OPS3.2-HEALTH-05: an empty health table does not make anything healthy", () => {
  /* This is the state of this checkout: the launchd job that writes probe rows targets a different
   * repository and exits EX_CONFIG, so the table is permanently empty here. Treating "no failures
   * recorded" as healthy would paint every provider green on a machine that has never checked one. */
  const count = (getDb().prepare("SELECT COUNT(*) AS n FROM connector_health_check_runs").get() as { n: number }).n;
  assert.equal(count, 0, "precondition: nothing has ever been probed");

  const healthy = getDiscoveryConnectorHealth().filter(
    (r) => r.probe.status === "HEALTHY" || r.production.status === "HEALTHY"
  );
  assert.deepEqual(healthy, [], "no provider may be healthy without a single observation");
});

// --- OPS3.2-HEALTH-02/03/04: real evidence -------------------------------------------------------

test("OPS3.2-HEALTH-02: a recent successful production scan produces HEALTHY", () => {
  const ids = seedSource("greenhouse", "Acme");
  seedScan(ids.companyId, "greenhouse", "success");

  const row = forProvider(getDiscoveryConnectorHealth(), "greenhouse");
  assert.equal(row.production.status, "HEALTHY");
  assert.equal(row.primaryEvidence, "PRODUCTION_SCAN", "real scans outrank a probe");
});

test("OPS3.2-HEALTH-03: a configuration failure stays distinguishable from a provider failure", () => {
  const cfg = seedSource("jobdiva", "ConfigCo");
  seedScan(cfg.companyId, "jobdiva", "failed", "invalid_config");
  const down = seedSource("taleo", "DownCo");
  seedScan(down.companyId, "taleo", "failed", "provider_5xx");

  const rows = getDiscoveryConnectorHealth();
  assert.equal(forProvider(rows, "jobdiva").production.lastFailureCategory, "invalid_config");
  assert.equal(forProvider(rows, "taleo").production.lastFailureCategory, "provider_5xx");
  assert.notEqual(
    forProvider(rows, "jobdiva").production.lastFailureCategory,
    forProvider(rows, "taleo").production.lastFailureCategory,
    "a missing setting must not look like an outage — future repair decisions depend on this"
  );
});

test("OPS3.2-HEALTH-04: probe evidence and production evidence stay separate fields", () => {
  const ids = seedSource("ashby", "ProbeOnly");
  seedProbe("ashby", ids, "HEALTHY_JOBS");

  const row = forProvider(getDiscoveryConnectorHealth(), "ashby");
  assert.equal(row.probe.status, "HEALTHY", "the probe observed something");
  assert.equal(row.production.status, "NO_DATA", "but no real scan has run — that must remain visible");
  assert.equal(row.primaryEvidence, "PROBE", "the probe is the fallback, not a production claim");
});

test("OPS3.2-HEALTH-04b: a healthy probe cannot mask a failing production scan", () => {
  const ids = seedSource("icims", "MixedCo");
  seedProbe("icims", ids, "HEALTHY_JOBS");
  seedScan(ids.companyId, "icims", "failed", "timeout");

  const row = forProvider(getDiscoveryConnectorHealth(), "icims");
  assert.equal(row.probe.status, "HEALTHY");
  assert.notEqual(row.production.status, "HEALTHY", "the real scans failed and that is what leads");
  assert.equal(row.primaryEvidence, "PRODUCTION_SCAN");
});

test("OPS3.2-HEALTH-06: a probe failure is recorded with its category, not as silence", () => {
  const ids = seedSource("workable", "FailCo");
  seedProbe("workable", ids, "FAILED_HARD", "invalid_config");

  const row = forProvider(getDiscoveryConnectorHealth(), "workable");
  assert.equal(row.probe.status, "ERROR");
  assert.equal(row.probe.failureCount, 1);
  assert.equal(row.probe.lastFailureCategory, "invalid_config");
  assert.ok(row.probe.observedAt, "a failure is still an observation and carries a timestamp");
});

test("OPS3.2-HEALTH-07: a reachable board with zero openings is healthy, because the connector ran", () => {
  /* HEALTHY_EMPTY is only sound because the connector executed. A connector that throws never
   * reaches that branch — see the JobDiva credential tests. */
  const ids = seedSource("lever", "EmptyBoard");
  seedProbe("lever", ids, "HEALTHY_EMPTY");
  assert.equal(forProvider(getDiscoveryConnectorHealth(), "lever").probe.status, "HEALTHY");
});

// --- OPS3.2-SOURCE-01 ----------------------------------------------------------------------------

test("OPS3.2-SOURCE-01: source counts come from the registry, never hardcoded", () => {
  assert.equal(forProvider(getDiscoveryConnectorHealth(), "greenhouse").configuredSourceCount, 0);

  seedSource("greenhouse", "One");
  seedSource("greenhouse", "Two");
  seedSource("lever", "Three");

  const rows = getDiscoveryConnectorHealth();
  assert.equal(forProvider(rows, "greenhouse").configuredSourceCount, 2);
  assert.equal(forProvider(rows, "lever").configuredSourceCount, 1);
  assert.equal(forProvider(rows, "taleo").configuredSourceCount, 0, "a real query returning zero");
});

// --- OPS3.2-APPLY-01 / capability separation -----------------------------------------------------

test("OPS3.2-APPLY-01: discovery health never implies an application adapter", async () => {
  const { automatedSourceTypes } = await import("@/lib/apply/agent/selectAdapter");
  const automated = new Set(automatedSourceTypes());

  const ids = seedSource("ashby", "HealthyAshby");
  seedScan(ids.companyId, "ashby", "success");

  const row = forProvider(getDiscoveryConnectorHealth(), "ashby");
  assert.equal(row.production.status, "HEALTHY", "Career-Ops fetches Ashby jobs perfectly well");
  assert.equal(automated.has("ashby"), false, "but cannot apply to Ashby");
  assert.ok(!("automation" in row), "the discovery projection must not carry an apply field at all");
  assert.ok(!("supported" in row), "no composite supported flag may exist");
});

test("OPS3.2-APPLY-02: capability is static and independent of health", () => {
  const before = forProvider(getDiscoveryConnectorHealth(), "greenhouse").capability;
  const ids = seedSource("greenhouse", "Acme");
  seedScan(ids.companyId, "greenhouse", "failed", "provider_5xx");
  const after = forProvider(getDiscoveryConnectorHealth(), "greenhouse");

  assert.equal(after.capability, before, "a failing provider still has a connector");
  assert.equal(after.capability, "SCANNABLE");
  assert.equal(forProvider(getDiscoveryConnectorHealth(), "phenom").capability, "CONNECTOR_NOT_SCANNED");
});

// --- OPS3.2-SECRETS-01 ---------------------------------------------------------------------------

test("OPS3.2-SECRETS-01: the projection carries no credential, token or raw diagnostic", () => {
  const ids = seedSource("jobdiva", "SecretCo");
  seedProbe("jobdiva", ids, "FAILED_HARD", "invalid_config");
  seedScan(ids.companyId, "jobdiva", "failed", "invalid_config");

  const serialized = JSON.stringify(getDiscoveryConnectorHealth());
  for (const forbidden of ["password", "authorization", "token", "secret", "apiKey", "source_key", "sourceUrl", "errorMessage", "error_message"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "i"), `${forbidden} must never appear`);
  }
  /* Safe categories are fine and are what an operator needs. */
  assert.match(serialized, /invalid_config/);
});

// --- OPS3.2-API-01 --------------------------------------------------------------------------------

test("OPS3.2-API-01: the operational route is guarded, read-only, and named for discovery only", async () => {
  const fsp = await import("node:fs");
  const pathp = await import("node:path");
  const route = pathp.join(process.cwd(), "src/app/api/admin/discovery-connectors/route.ts");
  const src = fsp.readFileSync(route, "utf8");

  /* An executable guard, not a mention of one. Stripping comments first is the same check the
   * mutation-policy suite uses — a `// requireAdminOwner` must not satisfy this. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /requireAdminOwner\(req\)/, "the guard must actually be called");
  assert.match(code, /if \(!authorization\.ok\) return authorization\.response/, "and its result acted on");

  /* Read-only: an observability endpoint must expose no mutating verb. */
  for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.doesNotMatch(code, new RegExp(`export async function ${verb}\\b`), `${verb} must not exist here`);
  }

  /* Naming: "atsHealth" would be read as covering application automation too. */
  assert.doesNotMatch(code, /atsHealth/i, "ambiguous ATS-wide naming is forbidden");
  assert.match(code, /JOB_DISCOVERY/, "the scope is stated in the payload itself");

  /* No hardcoded platform counts anywhere in the route. */
  assert.doesNotMatch(code, /\b3[0-9]\b/, "counts must be derived, never written down");
});

/* ================================================================================================
 * ADMIN-OPS-3.2.1 — adversarial scenarios the checkpoint required, focused on the cases where a
 * projection is most tempted to invent a verdict: partial evidence, and contradictory evidence.
 * ============================================================================================== */

test("OPS3.2.1-ADV-01: a configured source with no evidence is NO_DATA, not HEALTHY", () => {
  /* The most dangerous shape in the product: something is set up, so it LOOKS operational, but
   * nothing has ever observed it working. */
  seedSource("greenhouse", "ConfiguredButUnobserved");
  const row = forProvider(getDiscoveryConnectorHealth(), "greenhouse");

  assert.equal(row.configuredSourceCount, 1, "the source is really there");
  assert.equal(row.probe.status, "NO_DATA");
  assert.equal(row.production.status, "NO_DATA");
  assert.equal(row.primaryEvidence, "NONE", "configuration is not evidence");
});

test("OPS3.2.1-ADV-02: production failures with no successes are ERROR, not WARNING", () => {
  const ids = seedSource("taleo", "AllFailing");
  seedScan(ids.companyId, "taleo", "failed", "provider_5xx");
  seedScan(ids.companyId, "taleo", "failed", "provider_5xx");

  const row = forProvider(getDiscoveryConnectorHealth(), "taleo");
  assert.equal(row.production.status, "ERROR");
  assert.equal(row.production.failureCount, 2);
  assert.equal(row.production.lastSucceededAt, null, "no success may be invented");
});

test("OPS3.2.1-ADV-03: a probe failure and a production success are BOTH preserved, not reconciled", () => {
  /* The checkpoint's hardest case. Production leads, but if the newer probe failure vanished, an
   * operator would never learn the connector just broke. Contradiction is data, not noise. */
  const ids = seedSource("icims", "Contradictory");
  seedScan(ids.companyId, "icims", "success");
  seedProbe("icims", ids, "FAILED_HARD", "network");

  const row = forProvider(getDiscoveryConnectorHealth(), "icims");
  assert.equal(row.production.status, "HEALTHY", "the real scans did succeed");
  assert.equal(row.probe.status, "ERROR", "and the probe really did fail — both survive");
  assert.equal(row.probe.lastFailureCategory, "network");
  assert.equal(row.primaryEvidence, "PRODUCTION_SCAN", "precedence chooses what leads, it does not delete");
  assert.notEqual(row.probe.status, row.production.status, "the disagreement is visible to the caller");
});

test("OPS3.2.1-ADV-04: mostly-failing sources are never flattened into a green provider", () => {
  const companies: number[] = [];
  for (let i = 0; i < 20; i++) companies.push(seedSource("workable", `Bulk${i}`).companyId);
  seedScan(companies[0], "workable", "success");
  for (let i = 1; i < 20; i++) seedScan(companies[i], "workable", "failed", "timeout");

  const row = forProvider(getDiscoveryConnectorHealth(), "workable");
  assert.notEqual(row.production.status, "HEALTHY", "19 of 20 failing must never read as healthy");
  assert.equal(row.production.failureCount, 19, "the magnitude is preserved, not reduced to a flag");
  assert.equal(row.configuredSourceCount, 20);
});

test("OPS3.2.1-ADV-05: recruitee reports like any other scannable provider", () => {
  const ids = seedSource("recruitee", "RecruiteeCo");
  seedScan(ids.companyId, "recruitee", "success");

  const row = forProvider(getDiscoveryConnectorHealth(), "recruitee");
  assert.equal(row.capability, "SCANNABLE");
  assert.equal(row.production.status, "HEALTHY");
  assert.equal(row.configuredSourceCount, 1);
});

test("OPS3.2.1-PHENOM-02: a phenom source that exists is visible, not silently unscannable", () => {
  /* job_sources.provider has no CHECK constraint, so a phenom row is possible even though nothing
   * can discover one. Before this projection such a row was invisible: approved, never scanned, and
   * absent from every provider query. Here it reports its real count next to a capability that says
   * plainly it will never be scanned. */
  seedSource("phenom", "ManuallyAddedPhenom");
  const row = forProvider(getDiscoveryConnectorHealth(), "phenom");

  assert.equal(row.capability, "CONNECTOR_NOT_SCANNED", "the trap is stated, not hidden");
  assert.equal(row.configuredSourceCount, 1, "and the orphaned source is counted");
  assert.equal(row.production.status, "NO_DATA", "nothing will ever scan it, so there is no evidence");
});

test("OPS3.2.1-ADV-06: an apply-capable provider with no discovery evidence is still NO_DATA", async () => {
  const { automatedSourceTypes } = await import("@/lib/apply/agent/selectAdapter");
  assert.ok(automatedSourceTypes().includes("workday"), "precondition: workday can be applied to");

  const row = forProvider(getDiscoveryConnectorHealth(), "workday");
  assert.equal(row.production.status, "NO_DATA", "an apply adapter proves nothing about discovery");
  assert.equal(row.probe.status, "NO_DATA");
});

test("OPS3.2.1-STAMP-01: production evidence carries real timestamps, not structural nulls", () => {
  /* These three fields were always null on the production side until 3.2.1 — a field that can never
   * be populated claims more than it delivers, and staleness is most of what makes health useful. */
  const ids = seedSource("ashby", "Stamped");
  seedScan(ids.companyId, "ashby", "success");
  seedScan(ids.companyId, "ashby", "failed", "timeout");

  const row = forProvider(getDiscoveryConnectorHealth(), "ashby");
  assert.ok(row.production.observedAt, "the reading must say when it was taken");
  assert.ok(row.production.lastSucceededAt, "and when it last worked");
  assert.ok(row.production.lastFailedAt, "and when it last failed");
  assert.ok(
    Number.isFinite(new Date(row.production.observedAt!).getTime()),
    "and those must be parseable instants"
  );
});
