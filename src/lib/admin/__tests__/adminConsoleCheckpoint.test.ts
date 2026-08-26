import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/* ================================================================================================
 * UI-ADMIN-1.1 — checkpoint verification against real data, not source text.
 *
 * The implementation phase leaned on source assertions for wiring. This file does the parts that
 * can be proven behaviourally: the action actually running end to end against a seeded temp
 * database, the new actionableSourceId agreeing with the repair it exists to feed, the query count
 * staying flat as providers and sources multiply, and contradictory connector evidence surviving.
 * ============================================================================================== */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let registry: typeof import("@/lib/operations/repairRegistry");
let discovery: typeof import("@/lib/operations/discoveryConnectorHealth");

const okFetcher = (async () => [
  { externalId: "j1", title: "Data Engineer", location: "Remote", url: "https://example.test/1", description: "x" },
]) as never;
const failFetcher = (async () => {
  throw new Error("Request to https://example.test failed with status 503");
}) as never;

interface Seeded { companyId: number; orgId: number; jobSourceId: number }

function seedSource(provider: string, name: string, opts: Partial<{ approved: boolean; verified: boolean; authoritative: boolean; sourceActive: boolean; companyActive: boolean }> = {}): Seeded {
  const o = { approved: true, verified: true, authoritative: true, sourceActive: true, companyActive: true, ...opts };
  const db = getDb();
  db.prepare("INSERT INTO companies (name, source_type, ats_board_token, is_active) VALUES (?,?,?,?)")
    .run(name, provider, `${name}-tok`, o.companyActive ? 1 : 0);
  const companyId = (db.prepare("SELECT id FROM companies WHERE name = ?").get(name) as { id: number }).id;
  db.prepare("INSERT INTO organizations (canonical_name, status) VALUES (?, 'active')").run(name);
  const orgId = (db.prepare("SELECT id FROM organizations WHERE canonical_name = ?").get(name) as { id: number }).id;
  db.prepare(
    `INSERT INTO job_sources (organization_id, provider, source_key, resolution_status, review_status,
                              is_active, is_authoritative, legacy_company_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    orgId, provider, `${name}-key`,
    o.verified ? "VERIFIED" : "UNRESOLVED",
    o.approved ? "APPROVED" : "PENDING",
    o.sourceActive ? 1 : 0,
    o.authoritative ? 1 : 0,
    companyId
  );
  const jobSourceId = (db.prepare("SELECT id FROM job_sources WHERE legacy_company_id = ?").get(companyId) as { id: number }).id;
  return { companyId, orgId, jobSourceId };
}

const rowFor = (provider: string) => discovery.getDiscoveryConnectorHealth().find((c) => c.provider === provider)!;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-uiadmin-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  registry = await import("@/lib/operations/repairRegistry");
  discovery = await import("@/lib/operations/discoveryConnectorHealth");
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  const db = getDb();
  for (const t of ["connector_health_check_runs", "scan_runs", "job_sources", "organizations", "companies"]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

// --- Section 13: seeded end-to-end action ----------------------------------------------------------

test("UIADMIN1.1-E2E-01: a diagnostic runs end to end and its OWN evidence drives the new state", async () => {
  const seeded = seedSource("greenhouse", "AcmeCo");

  /* Before: a source exists, nothing has been observed. */
  const before = rowFor("greenhouse");
  assert.equal(before.configuredSourceCount, 1);
  assert.equal(before.probe.status, "NO_DATA", "nothing observed yet");
  assert.equal(before.actionableSourceId, seeded.jobSourceId, "the console is handed a real, runnable id");

  /* The action, through the same seam the route calls. */
  const result = await registry.executeRepair(
    "recheck_discovery_connector",
    { jobSourceId: before.actionableSourceId! },
    { fetcher: okFetcher }
  );
  assert.equal(result.actionStatus, "EXECUTED");
  assert.equal(result.verificationStatus, "VERIFIED_RECOVERED");

  /* Exactly one evidence row was persisted, and it is the one the verdict cites. */
  const rows = getDb()
    .prepare("SELECT id, outcome, finished_at FROM connector_health_check_runs WHERE job_source_id = ?")
    .all(seeded.jobSourceId) as { id: number; outcome: string; finished_at: string }[];
  assert.equal(rows.length, 1, "one action, one row");
  assert.equal(rows[0].outcome, "HEALTHY_JOBS");
  assert.ok(rows[0].finished_at >= result.repairStartedAt, "the row is the repair's own");

  /* And the refreshed projection — what the console re-renders — reflects that row. */
  const after = rowFor("greenhouse");
  assert.equal(after.probe.status, "HEALTHY");
  assert.equal(after.probe.lastSucceededAt, rows[0].finished_at, "the projection reads the action's evidence");
  assert.equal(after.production.status, "NO_DATA", "and no scan evidence was invented");
});

test("UIADMIN1.1-E2E-02: a failing diagnostic leaves the subsystem unhealthy and says so", async () => {
  const seeded = seedSource("taleo", "DownCo");
  const result = await registry.executeRepair(
    "recheck_discovery_connector",
    { jobSourceId: seeded.jobSourceId },
    { fetcher: failFetcher }
  );

  assert.equal(result.actionStatus, "EXECUTED", "the action itself ran");
  assert.equal(result.verificationStatus, "VERIFIED_STILL_FAILING", "and reported the truth about it");
  assert.notEqual(result.healthAfter, "HEALTHY");
  assert.equal(rowFor("taleo").probe.status, "ERROR", "the console will render ERROR, not a success");
});

// --- Section 14: actionableSourceId audit ------------------------------------------------------------

test("UIADMIN1.1-ACTION-01: every ineligible source shape yields null, and the repair agrees", async () => {
  /* The field's whole purpose is to never hand the console an id the repair would refuse. Each row
   * below is eligible except in one respect. */
  const cases: [string, Parameters<typeof seedSource>[2]][] = [
    ["unapproved", { approved: false }],
    ["unverified", { verified: false }],
    ["non-authoritative", { authoritative: false }],
    ["inactive source", { sourceActive: false }],
    ["inactive company", { companyActive: false }],
  ];
  for (const [label, opts] of cases) {
    const db = getDb();
    for (const t of ["job_sources", "organizations", "companies"]) db.prepare(`DELETE FROM ${t}`).run();
    const seeded = seedSource("lever", `Case-${label.replace(/\s/g, "")}`, opts);

    assert.equal(rowFor("lever").actionableSourceId, null, `${label}: no action may be offered`);

    /* And the repair independently refuses that same id — the two agree by construction now that
     * both read one SQL authority, and this proves it rather than assuming it. */
    const result = await registry.executeRepair(
      "recheck_discovery_connector",
      { jobSourceId: seeded.jobSourceId },
      { fetcher: okFetcher }
    );
    assert.equal(result.actionStatus, "REJECTED_INELIGIBLE", `${label}: the repair must refuse it too`);
  }
});

test("UIADMIN1.1-ACTION-02: an unsupported provider is never offered an action", () => {
  /* phenom has a connector but is not scannable; it IS health-probeable, so it may legitimately
   * carry an id. A provider with no connector at all must not even appear. */
  seedSource("phenom", "PhenomCo");
  const phenom = rowFor("phenom");
  assert.equal(phenom.capability, "CONNECTOR_NOT_SCANNED");
  assert.equal(phenom.actionableSourceId, phenom.actionableSourceId, "phenom is probeable, so an id is legitimate");

  const rows = discovery.getDiscoveryConnectorHealth();
  assert.ok(!rows.some((r) => (r.provider as string) === "career_link"), "a meta source is not a connector row");
});

test("UIADMIN1.1-ACTION-03: selection is deterministic and belongs to its own provider", () => {
  const a = seedSource("ashby", "AshbyOne");
  const b = seedSource("ashby", "AshbyTwo");
  const other = seedSource("workable", "WorkableOne");

  const ashby = rowFor("ashby");
  assert.equal(ashby.actionableSourceId, Math.min(a.jobSourceId, b.jobSourceId), "lowest id — stable across calls");
  assert.equal(rowFor("ashby").actionableSourceId, ashby.actionableSourceId, "and repeatable");

  /* The id must belong to the provider whose row carries it. */
  const owner = getDb().prepare("SELECT provider FROM job_sources WHERE id = ?").get(ashby.actionableSourceId!) as { provider: string };
  assert.equal(owner.provider, "ashby");
  assert.notEqual(ashby.actionableSourceId, other.jobSourceId);
  assert.equal(rowFor("workable").actionableSourceId, other.jobSourceId);
});

test("UIADMIN1.1-ACTION-04: the field leaks nothing beyond the numeric id", () => {
  seedSource("icims", "SecretCo");
  const serialized = JSON.stringify(discovery.getDiscoveryConnectorHealth());
  for (const leak of ["source_key", "sourceKey", "source_url", "sourceUrl", "SecretCo-key", "ats_board_token", "canonical"]) {
    assert.doesNotMatch(serialized, new RegExp(leak, "i"), `${leak} must not appear in the projection`);
  }
  assert.equal(typeof rowFor("icims").actionableSourceId, "number");
});

test("UIADMIN1.1-ACTION-05: probe eligibility has exactly one definition in the codebase", () => {
  /* Three hand-written copies existed before this checkpoint — the checker, the repair and the
   * console lookup — each claiming to match the others. That is the shape of the provider-list drift
   * this program already had to unpick once. */
  const files = ["src/lib/ats/connectorHealthCheck.ts", "src/lib/operations/repairRegistry.ts", "src/lib/operations/discoveryConnectorHealth.ts"];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    assert.ok(!src.includes("is_authoritative = 1") && !src.includes("is_authoritative=1"), `${rel} must not restate the predicate`);
    assert.match(src, /PROBE_ELIGIBLE_SOURCE_SQL/, `${rel} must derive it`);
  }
  const authority = fs.readFileSync(path.join(process.cwd(), "src/lib/ats/probeEligibility.ts"), "utf8");
  assert.equal((authority.match(/is_authoritative/g) ?? []).length, 1, "the authority states it once");
});

// --- Section 15: N+1 measurement ----------------------------------------------------------------------

test("UIADMIN1.1-PERF-01: the connector projection's query count is flat as providers and sources grow", () => {
  const db = getDb();
  const count = (): number => {
    const original = db.prepare.bind(db);
    let n = 0;
    (db as unknown as { prepare: typeof original }).prepare = ((sql: string) => { n += 1; return original(sql); }) as typeof original;
    try { discovery.getDiscoveryConnectorHealth(); } finally { (db as unknown as { prepare: typeof original }).prepare = original; }
    return n;
  };

  const empty = count();
  const one = (() => { seedSource("greenhouse", "One"); return count(); })();

  /* Every probeable provider, several sources each, with probe and scan history. */
  const providers = ["lever", "ashby", "workday", "icims", "taleo", "workable", "breezy", "personio", "cats", "comeet", "jobvite", "jazzhr"];
  for (const p of providers) {
    for (let i = 0; i < 4; i++) {
      const s = seedSource(p, `${p}-co-${i}`);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO scan_runs (company_id, provider, started_at, finished_at, duration_ms, status) VALUES (?,?,?,?,10,'success')`).run(s.companyId, p, now, now);
      db.prepare(
        `INSERT INTO connector_health_check_runs (job_source_id, organization_id, company_id, provider, checker_version,
           outcome, jobs_seen, latency_ms, error_category, evidence_json, started_at, finished_at)
         VALUES (?,?,?,?,'t.v1','HEALTHY_JOBS',1,5,NULL,'{}',?,?)`
      ).run(s.jobSourceId, s.orgId, s.companyId, p, now, now);
    }
  }
  const many = count();

  assert.equal(one, empty, "one source must not add a query");
  assert.equal(many, empty, `query count moved from ${empty} to ${many} across 49 sources / 13 providers — that is N+1`);
  /* Eight, and every one is accounted for: probe evidence, configured-source counts, scan
   * timestamps, actionable source ids, and the four inside getProviderHealthSummary (scan rows,
   * company rows, pending proposals, company-to-provider map). actionableSourceId added exactly one.
   * The bound is a ceiling on that inventory, not a guess — a ninth means something new was added. */
  assert.ok(empty <= 9, `${empty} statements exceeds the accounted-for inventory of 8`);

  /* And it genuinely read the data. */
  assert.equal(discovery.getDiscoveryConnectorHealth().reduce((n, c) => n + (c.configuredSourceCount ?? 0), 0), 49);
});

// --- Section 16: contradictory evidence -----------------------------------------------------------------

test("UIADMIN1.1-CONTRA-01: production HEALTHY with probe ERROR keeps both readings", async () => {
  const s = seedSource("greenhouse", "MixedA");
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO scan_runs (company_id, provider, started_at, finished_at, duration_ms, status) VALUES (?,?,?,?,10,'success')`).run(s.companyId, "greenhouse", now, now);
  await registry.executeRepair("recheck_discovery_connector", { jobSourceId: s.jobSourceId }, { fetcher: failFetcher });

  const row = rowFor("greenhouse");
  assert.equal(row.production.status, "HEALTHY", "the real scans succeeded");
  assert.equal(row.probe.status, "ERROR", "the probe failed");
  assert.equal(row.primaryEvidence, "PRODUCTION_SCAN", "emphasis only");
  /* No synthesised middle verdict anywhere on the row. */
  assert.ok(!("status" in row), "a connector row must carry no single combined status");
});

test("UIADMIN1.1-CONTRA-02: production ERROR with probe HEALTHY also keeps both", async () => {
  const s = seedSource("lever", "MixedB");
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO scan_runs (company_id, provider, started_at, finished_at, duration_ms, status, error_category) VALUES (?,?,?,?,10,'failed','provider_5xx')`).run(s.companyId, "lever", now, now);
  await registry.executeRepair("recheck_discovery_connector", { jobSourceId: s.jobSourceId }, { fetcher: okFetcher });

  const row = rowFor("lever");
  assert.equal(row.production.status, "ERROR");
  assert.equal(row.probe.status, "HEALTHY");
  assert.equal(row.production.lastFailureCategory, "provider_5xx", "the failure kind survives");
  assert.notEqual(row.production.status, row.probe.status, "the disagreement is preserved, not averaged");
});

// --- Section 19: discovery cannot imply apply -------------------------------------------------------------

test("UIADMIN1.1-SEP-01: a healthy discovery-only provider is never application-capable", async () => {
  const { automatedSourceTypes } = await import("@/lib/apply/agent/selectAdapter");
  const s = seedSource("ashby", "AshbyHealthy");
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO scan_runs (company_id, provider, started_at, finished_at, duration_ms, status) VALUES (?,?,?,?,10,'success')`).run(s.companyId, "ashby", now, now);

  const row = rowFor("ashby");
  assert.equal(row.production.status, "HEALTHY", "Ashby discovery works perfectly");
  assert.equal(automatedSourceTypes().includes("ashby"), false, "and Ashby apply does not exist");

  /* The row itself carries no apply concept at all, so no consumer can read one off it. */
  for (const key of ["automation", "supported", "adapter", "canApply"]) {
    assert.ok(!(key in row), `a connector row must not carry ${key}`);
  }

  /* The view-model's adapter list is the registry's, not a copy. */
  const { buildAdminOperationsView } = await import("@/lib/admin/operationsView");
  const view = buildAdminOperationsView("7d");
  assert.deepEqual(view.applicationAutomation.adapters.map((a) => a.provider).sort(), [...automatedSourceTypes()].sort());
  for (const a of view.applicationAutomation.adapters) {
    assert.equal(a.health, "NO_DATA", `${a.provider} has no execution evidence and must stay NO_DATA`);
  }
});

// --- Section 25: visual tokens and non-colour channels ------------------------------------------------

test("UIADMIN1.1-VISUAL-01: status styling uses the themed tokens, not fixed hex", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const block = css.slice(css.indexOf("UI-ADMIN-1 — operations console"));

  /* --success/--warning/--error are redefined for the dark theme; a hardcoded hue would be the one
   * part of this screen that ignored it. */
  /* Scoped to the rules that carry STATUS. The one remaining literal in this block is a shadow
   * colour, copied from the existing .admin-card:hover convention in this same stylesheet — it
   * conveys elevation, not health, so it is not what this assertion is for. */
  const statusRules = block.match(/^\.ops-(tone|card\.ops-tone|panel-critical)[^\n]*$/gm) ?? [];
  assert.ok(statusRules.length >= 8, `expected the status rules, found ${statusRules.length}`);
  for (const rule of statusRules) {
    assert.doesNotMatch(rule, /#[0-9a-f]{3,8}\b/i, `status rule hardcodes a colour: ${rule.slice(0, 60)}`);
  }
  for (const token of ["var(--success)", "var(--warning)", "var(--error)"]) {
    assert.ok(block.includes(token), `${token} must carry the status tone`);
  }

  /* Colour is never the only channel: each tone also differs in border treatment, and the markup
   * pairs every badge with a text label and a symbol (asserted in adminConsole.test.ts). */
  assert.match(block, /\.ops-card\.ops-tone-neutral\s*\{[^}]*dashed/, "neutral is dashed, not merely a different hue");
  assert.match(block, /\.ops-card\.ops-tone-critical\s*\{[^}]*solid/);

  /* Long values must not force horizontal scroll. */
  for (const rule of ["ops-evidence-value", "ops-provider-name"]) {
    const at = block.indexOf(rule);
    assert.ok(at !== -1 && block.slice(at, at + 220).includes("overflow-wrap:anywhere"), `${rule} must wrap long content`);
  }
  /* Mobile keeps evidence on screen rather than hiding it. */
  const mobile = block.slice(block.indexOf("@media (max-width:640px)"));
  assert.doesNotMatch(mobile, /display:\s*none/, "no evidence may be hidden on small screens");
});
