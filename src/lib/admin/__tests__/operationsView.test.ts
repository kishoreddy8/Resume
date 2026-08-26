import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/* ================================================================================================
 * ADMIN-OPS-5 — the final Admin operations contract.
 *
 * The thing under test is whether a UI could render an operator screen from this model WITHOUT
 * making any judgement of its own. Temp database throughout; no ATS, no network.
 * ============================================================================================== */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let view: typeof import("../operationsView");

const HEALTH_STATUSES = ["HEALTHY", "WARNING", "ERROR", "DISABLED", "NO_DATA"] as const;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-opsview-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  view = await import("../operationsView");
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

// --- Vocabulary ------------------------------------------------------------------------------------

test("OPS5-MODEL-01: every subsystem reports the one shared health vocabulary", () => {
  const model = view.buildAdminOperationsView("7d");
  assert.ok(model.subsystems.length >= 5, "the real operational concerns are represented");

  for (const s of model.subsystems) {
    assert.ok(HEALTH_STATUSES.includes(s.status as never), `${s.id} reports ${s.status}, which is not a HealthStatus`);
    /* The writer has a richer native state; it must be MAPPED here, not passed through. */
    assert.doesNotMatch(s.status, /PROCESSING|IDLE|WAITING|UNAVAILABLE|REQUIRED|BLOCKED|LIMIT/);
  }
  const ids = model.subsystems.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "subsystem ids are unique");
});

test("OPS5-MODEL-02: there is no composite score, percentage or grade", () => {
  const model = view.buildAdminOperationsView("7d");
  const serialized = JSON.stringify(model);

  /* Matches any KEY CONTAINING the term, not just an exact match — an earlier version of this test
   * looked for "score" and sailed straight past a field called healthScore. */
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        keys.add(k);
        walk(child);
      }
    }
  };
  walk(model);
  for (const forbidden of ["score", "percent", "grade", "rating", "index", "overall"]) {
    const offender = [...keys].find((k) => k.toLowerCase().includes(forbidden));
    assert.equal(offender, undefined, `key "${offender}" reads as a composite ${forbidden}`);
  }
  assert.ok(!/\d+%/.test(serialized), "no percentage appears in any value either");
  /* The summary is a count of verdicts, and every count is a whole number of subsystems. */
  const counted = HEALTH_STATUSES
    .map((s) => model.summary[s.toLowerCase() as Lowercase<typeof s>] ?? 0)
    .reduce((a, b) => a + b, 0);
  assert.equal(counted, model.subsystems.length, "every subsystem is counted exactly once");
});

// --- Evidence --------------------------------------------------------------------------------------

test("OPS5-EVIDENCE-01: any verdict other than NO_DATA cites evidence", () => {
  const model = view.buildAdminOperationsView("7d");
  for (const s of model.subsystems) {
    if (s.status === "NO_DATA") continue;
    assert.ok(s.evidence.length > 0, `${s.id} claims ${s.status} without citing anything`);
    for (const e of s.evidence) {
      assert.ok(e.label.length > 0 && e.value.length > 0, `${s.id} has an empty evidence row`);
    }
  }
});

test("OPS5-EVIDENCE-02: NO_DATA is not dressed up with fabricated evidence", () => {
  const model = view.buildAdminOperationsView("7d");
  const noData = model.subsystems.filter((s) => s.status === "NO_DATA");
  assert.ok(noData.length > 0, "an empty database should produce at least one NO_DATA subsystem");
  for (const s of noData) {
    /* Configuration facts ("Configured host: web") are legitimate context and are not observations.
     * What NO_DATA may never do is cite an OBSERVATION, because that is precisely the claim it is
     * saying it cannot make — so no "Last ..." row, and no observedAt. */
    assert.equal(s.observedAt, null, `${s.id} says NO_DATA but claims an observation time`);
    for (const e of s.evidence) {
      assert.doesNotMatch(e.label, /^Last /, `${s.id} cited the observation "${e.label}" under a NO_DATA verdict`);
    }
    assert.equal(s.stale, false, `${s.id} cannot be stale when nothing was ever observed`);
    assert.notEqual(s.repairability, "AUTO_RECOVERABLE", `${s.id} must not claim it will fix itself with no evidence`);
  }
});

test("OPS5-EVIDENCE-03: buildHealth refuses an unevidenced positive verdict", async () => {
  /* The invariant the whole model leans on, asserted directly. */
  const { buildHealth } = await import("@/lib/operations/subsystemHealth");
  assert.throws(
    () => buildHealth({ status: "HEALTHY", summary: "fine", evidence: [], observedAt: null, staleAfterMs: null, reasonCode: "X", repairability: "UNKNOWN" }),
    /cites no evidence/
  );
  assert.doesNotThrow(() =>
    buildHealth({ status: "NO_DATA", summary: "nothing observed", evidence: [], observedAt: null, staleAfterMs: null, reasonCode: "X", repairability: "UNKNOWN" })
  );
});

// --- Every tile is renderable without UI-side reasoning ---------------------------------------------

test("OPS5-API-01: each subsystem carries everything a screen needs, so the UI infers nothing", () => {
  for (const s of view.buildAdminOperationsView("7d").subsystems) {
    assert.ok(s.id && s.label, "identity");
    assert.ok(s.summary.length > 0, `${s.id} must explain itself in words`);
    assert.ok(s.reasonCode.length > 0, `${s.id} must carry a machine-readable reason`);
    assert.ok(s.repairability, `${s.id} must say who can act`);
    assert.ok(Array.isArray(s.availableActions), `${s.id} must state its actions, even if none`);
    assert.ok("observedAt" in s, `${s.id} must say when, even if null`);
  }
});

test("OPS5-API-01b: the model aggregates the existing authorities rather than re-classifying", async () => {
  /* If this file classified anything itself, its verdict could disagree with the rest of the product.
   * The scanner tile must equal what classifyScanningHealth says for the same inputs. */
  const { classifyScanningHealth } = await import("@/lib/operations/healthRules");
  const { getScanningWindowSummary, WINDOW_DAYS } = await import("@/db/queries/operations");
  const { getAppSettings } = await import("@/db/queries/settings");

  const settings = getAppSettings();
  const scanning = getScanningWindowSummary(WINDOW_DAYS["7d"]);
  const expected = settings.scheduler.enabled && settings.scheduler.scanEnabled
    ? classifyScanningHealth({ window: scanning, schedulerEnabled: true })
    : "DISABLED";

  const scanner = view.buildAdminOperationsView("7d").subsystems.find((s) => s.id === "scanner")!;
  assert.equal(scanner.status, expected, "the tile must not disagree with the health authority");

  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/admin/operationsView.ts"), "utf8");
  assert.doesNotMatch(src, /export (function|const) classify/, "this module must not define a classifier of its own");
});

// --- Discovery and apply stay apart ------------------------------------------------------------------

test("OPS5-API-02: discovery and application automation are separate sections", async () => {
  const { automatedSourceTypes } = await import("@/lib/apply/agent/selectAdapter");
  const model = view.buildAdminOperationsView("7d");

  assert.deepEqual(
    model.applicationAutomation.adapters.map((a) => a.provider).sort(),
    [...automatedSourceTypes()].sort(),
    "adapters come from the runtime registry, never a written-down list"
  );
  /* No adapter may claim health nobody recorded. */
  for (const a of model.applicationAutomation.adapters) {
    assert.equal(a.health, "NO_DATA", `${a.provider} must not claim apply health that is not observable`);
  }
  /* Platforms that can be discovered but not applied to are counted, never called broken. */
  assert.ok(model.applicationAutomation.discoveryOnlyPlatforms > 0);
  assert.ok(model.discovery.connectors > model.applicationAutomation.adapters.length);

  const discoveryTile = model.subsystems.find((s) => s.id === "discovery_connectors")!;
  assert.ok(!("adapters" in discoveryTile), "the discovery tile must not carry apply data");
  assert.ok(!("supported" in discoveryTile), "no composite supported flag");
});

// --- Actions -----------------------------------------------------------------------------------------

test("OPS5-ACTION-01: action kind survives into the model, and the UI never decides it", async () => {
  const { REPAIR_DESCRIPTORS } = await import("@/lib/operations/repairRegistry");
  for (const a of view.adminActionCatalog()) {
    assert.ok(["DIAGNOSTIC", "REPAIR"].includes(a.kind), `${a.id} must declare its kind`);
    assert.equal(a.kind, REPAIR_DESCRIPTORS[a.id as keyof typeof REPAIR_DESCRIPTORS].kind, "kind matches the registry");
    assert.doesNotMatch(a.title, /\bfix\b|\brepair\b|\bresolve\b/i, `${a.id} title must not promise a cure`);
  }
  /* No handler names or internals reach a UI. */
  const serialized = JSON.stringify(view.adminActionCatalog());
  for (const leak of ["checkConnectorHealth", "executeRepair", "getDb", "SELECT", "fetcher"]) {
    assert.doesNotMatch(serialized, new RegExp(leak, "i"), `${leak} must not leak`);
  }
});

test("OPS5-ACTION-02: a configuration problem offers no action at all", async () => {
  const { repairabilityFor } = await import("@/lib/operations/repairRegistry");
  const { getDiscoveryConnectorHealth } = await import("@/lib/operations/discoveryConnectorHealth");

  /* Seed a jobdiva source whose only evidence is a configuration failure. */
  const db = getDb();
  db.prepare("INSERT INTO companies (name, source_type, ats_board_token, is_active) VALUES ('ConfigCo','jobdiva','t',1)").run();
  const companyId = (db.prepare("SELECT id FROM companies WHERE name='ConfigCo'").get() as { id: number }).id;
  db.prepare("INSERT INTO organizations (canonical_name, status) VALUES ('ConfigCo','active')").run();
  const orgId = (db.prepare("SELECT id FROM organizations WHERE canonical_name='ConfigCo'").get() as { id: number }).id;
  db.prepare(
    `INSERT INTO job_sources (organization_id, provider, source_key, resolution_status, review_status, is_active, is_authoritative, legacy_company_id)
     VALUES (?,'jobdiva','k','VERIFIED','APPROVED',1,1,?)`
  ).run(orgId, companyId);
  const jsId = (db.prepare("SELECT id FROM job_sources WHERE legacy_company_id = ?").get(companyId) as { id: number }).id;
  db.prepare(
    `INSERT INTO connector_health_check_runs (job_source_id, organization_id, company_id, provider, checker_version,
       outcome, jobs_seen, latency_ms, error_category, evidence_json, started_at, finished_at)
     VALUES (?,?,?,'jobdiva','t.v1','FAILED_HARD',0,5,'invalid_config','{}',?,?)`
  ).run(jsId, orgId, companyId, new Date().toISOString(), new Date().toISOString());

  const row = getDiscoveryConnectorHealth().find((c) => c.provider === "jobdiva")!;
  const r = repairabilityFor(row);
  assert.equal(r.repairability, "CONFIGURATION_REQUIRED");
  assert.deepEqual(r.availableActions, [], "a missing setting has no in-app action");
  assert.doesNotMatch(JSON.stringify(r), /JOBDIVA_API_PASSWORD=|Basic /, "and no value is echoed");
});

// --- Leakage ------------------------------------------------------------------------------------------

test("OPS5-API-03: the model leaks no secret, absolute path, SQL or raw vendor text", () => {
  const serialized = JSON.stringify(view.buildAdminOperationsView("7d"));

  for (const forbidden of ["password", "credential", "authorization", "Basic ", "apiKey", "token"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "i"), `${forbidden} must not appear`);
  }
  assert.doesNotMatch(serialized, /\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\\\/, "no absolute filesystem path");
  assert.doesNotMatch(serialized, /SELECT .* FROM |INSERT INTO |DROP TABLE/i, "no SQL");
  assert.doesNotMatch(serialized, /\bat [A-Za-z]+ \(.*:\d+:\d+\)/, "no stack frames");
});

// --- Subsystem-health decision -------------------------------------------------------------------------

test("OPS5-SUBSYSTEM-01: subsystemHealth is genuinely consumed, not kept as dead code", () => {
  /* ADMIN-OPS-1 created it and put it behind a deletion gate: consume it for real by OPS-5, or delete
   * it. This is the enforcement of that decision — every export must have a live production user. */
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/operations/subsystemHealth.ts"), "utf8");
  const exported = [...src.matchAll(/^export (?:interface|type|function) (\w+)/gm)].map((m) => m[1]);
  assert.ok(exported.length > 0);

  const production = fs
    .readFileSync(path.join(process.cwd(), "src/lib/admin/operationsView.ts"), "utf8")
    .concat(fs.readFileSync(path.join(process.cwd(), "src/lib/operations/repairRegistry.ts"), "utf8"));

  for (const name of exported) {
    assert.match(production, new RegExp(`\\b${name}\\b`), `${name} has no production consumer — consume it or delete it`);
  }
});

// --- Performance ----------------------------------------------------------------------------------------

test("OPS5-PERF-01: building the whole view uses a bounded number of queries", () => {
  /* The failure this guards is the natural one for an aggregate: a query per provider or per source.
   * There are 37 connectors, so anything proportional to that would show up immediately here. */
  const db = getDb();
  const original = db.prepare.bind(db);
  let prepared = 0;
  (db as unknown as { prepare: typeof original }).prepare = ((sql: string) => {
    prepared += 1;
    return original(sql);
  }) as typeof original;

  try {
    view.buildAdminOperationsView("7d");
  } finally {
    (db as unknown as { prepare: typeof original }).prepare = original;
  }

  assert.ok(prepared > 0, "it really did query");
  assert.ok(prepared < 40, `the view prepared ${prepared} statements — that is per-provider growth, not an aggregate`);
});

/* ================================================================================================
 * ADMIN-OPS-5.1 — the writer mapping, state by state.
 * ============================================================================================== */

test("OPS5.1-WRITER-01: every writer state maps deliberately, and the table is exhaustive", async () => {
  const { WRITER_HEALTH, writerVerdict } = view;
  const writerSrc = fs.readFileSync(path.join(process.cwd(), "src/lib/resumeQuality/writers/writerHealth.ts"), "utf8");

  /* Re-derive the union from source rather than trusting a remembered count. Bounded by the next
   * top-level declaration, not by the first semicolon — the doc comments contain semicolons. */
  const declAt = writerSrc.indexOf("export type ResumeWriterHealthState =");
  const endAt = writerSrc.indexOf("\nexport ", declAt + 1);
  const union = writerSrc.slice(declAt, endAt === -1 ? undefined : endAt);
  const states = [...union.matchAll(/^\s*\|\s*"([A-Z_]+)"/gm)].map((m) => m[1]);
  assert.ok(states.length >= 12, `expected the full union, found ${states.length}`);

  /* Every state must have an entry — a missing one would be a silent undefined at runtime. */
  for (const s of states) {
    assert.ok(s in WRITER_HEALTH, `${s} has no mapping — a new writer state must not default silently`);
    const v = writerVerdict({ state: s as never, lastTickAt: "2026-01-01T00:00:00.000Z" });
    assert.ok(["HEALTHY", "WARNING", "ERROR", "DISABLED", "NO_DATA"].includes(v.status), `${s} -> ${v.status}`);
    assert.ok(v.reasonCode.length > 0, `${s} must carry a reason code`);
  }
  /* And no stale entries for states that no longer exist. */
  for (const key of Object.keys(WRITER_HEALTH)) {
    assert.ok(states.includes(key), `${key} is mapped but is not a real writer state`);
  }
});

test("OPS5.1-WRITER-02: the mapping matches each state's documented meaning", () => {
  const { writerVerdict } = view;
  const live = "2026-01-01T00:00:00.000Z";
  const expected: Record<string, string> = {
    /* Working, or legitimately between work. */
    PROCESSING: "HEALTHY",
    WAITING_FOR_NEXT_ATTEMPT: "HEALTHY",
    IDLE: "HEALTHY",
    /* Inactive because the operator configured it so — not a fault. */
    UNAVAILABLE_SCHEDULER_DISABLED: "DISABLED",
    WAITING_OUTSIDE_WINDOW: "DISABLED",
    /* Genuinely broken: a pass could not produce a resume, or has given up entirely. */
    TECHNICAL_FAILURE: "ERROR",
    BLOCKED_MAX_ATTEMPTS: "ERROR",
    /* Nothing is malfunctioning — a person or an external limit is required. */
    CANDIDATE_CONTACT_REQUIRED: "WARNING",
    SUBSCRIPTION_LIMIT_REACHED: "WARNING",
    AUTH_REQUIRED: "WARNING",
    UNAUTHORIZED_APPROVAL_STALE: "WARNING",
  };
  for (const [state, status] of Object.entries(expected)) {
    assert.equal(writerVerdict({ state: state as never, lastTickAt: live }).status, status, `${state}`);
  }
});

test("OPS5.1-WRITER-03: a dead writer scheduler is never reported as switched off", () => {
  /* The defect this pins. UNAVAILABLE_NOT_RUNNING comes from writerHealth's liveness branch, which
   * is evaluated BEFORE the scheduler-disabled branch — so it means the tick stopped, not that
   * anyone turned anything off. Mapping it to DISABLED told an operator "off" while it was dead. */
  const { writerVerdict } = view;

  const stale = writerVerdict({ state: "UNAVAILABLE_NOT_RUNNING", lastTickAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(stale.status, "ERROR", "a tick that ran and then stopped is a failure");
  assert.notEqual(stale.status, "DISABLED", "and must never read as a configuration choice");
  assert.equal(stale.reasonCode, "WRITER_TICK_STALE");

  const never = writerVerdict({ state: "UNAVAILABLE_NOT_RUNNING", lastTickAt: null });
  assert.equal(never.status, "NO_DATA", "never having run is unknown, not broken");
  assert.equal(never.reasonCode, "WRITER_NEVER_RAN");

  /* And the two must not be conflated with each other either. */
  assert.notEqual(stale.status, never.status);
});

test("OPS5.1-PERF-01: query count does not grow with connectors, sources or history", () => {
  /* OPS5-PERF-01 counts statements on an EMPTY database, which cannot distinguish a bounded
   * aggregate from an N+1 that simply has nothing to iterate. This populates real rows across many
   * providers and asserts the count is unchanged — the only measurement that actually rules out
   * per-provider growth as the platform list expands. */
  const db = getDb();
  const countStatements = (): number => {
    const original = db.prepare.bind(db);
    let n = 0;
    (db as unknown as { prepare: typeof original }).prepare = ((sql: string) => {
      n += 1;
      return original(sql);
    }) as typeof original;
    try {
      view.buildAdminOperationsView("7d");
    } finally {
      (db as unknown as { prepare: typeof original }).prepare = original;
    }
    return n;
  };

  const empty = countStatements();

  /* 12 providers × 5 sources each, with scan and probe history for every one. */
  const providers = ["greenhouse", "lever", "ashby", "workday", "icims", "taleo", "workable", "breezy", "personio", "cats", "comeet", "jobvite"];
  let seq = 0;
  for (const provider of providers) {
    for (let i = 0; i < 5; i++) {
      const name = `${provider}-co-${i}`;
      seq += 1;
      db.prepare("INSERT INTO companies (name, source_type, ats_board_token, is_active) VALUES (?,?,?,1)").run(name, provider, `tok-${seq}`);
      const companyId = (db.prepare("SELECT id FROM companies WHERE name = ?").get(name) as { id: number }).id;
      db.prepare("INSERT INTO organizations (canonical_name, status) VALUES (?, 'active')").run(name);
      const orgId = (db.prepare("SELECT id FROM organizations WHERE canonical_name = ?").get(name) as { id: number }).id;
      db.prepare(
        `INSERT INTO job_sources (organization_id, provider, source_key, resolution_status, review_status, is_active, is_authoritative, legacy_company_id)
         VALUES (?,?,?,'VERIFIED','APPROVED',1,1,?)`
      ).run(orgId, provider, `key-${seq}`, companyId);
      const jsId = (db.prepare("SELECT id FROM job_sources WHERE legacy_company_id = ?").get(companyId) as { id: number }).id;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO scan_runs (company_id, provider, started_at, finished_at, duration_ms, status) VALUES (?,?,?,?,10,'success')`
      ).run(companyId, provider, now, now);
      db.prepare(
        `INSERT INTO connector_health_check_runs (job_source_id, organization_id, company_id, provider, checker_version,
           outcome, jobs_seen, latency_ms, error_category, evidence_json, started_at, finished_at)
         VALUES (?,?,?,?,'t.v1','HEALTHY_JOBS',1,5,NULL,'{}',?,?)`
      ).run(jsId, orgId, companyId, provider, now, now);
    }
  }

  const populated = countStatements();
  assert.equal(
    populated,
    empty,
    `query count moved from ${empty} to ${populated} once 60 sources across 12 providers existed — that is per-row growth`
  );

  /* And the model really did read the data, so the count above is not stable through inaction. */
  const model = view.buildAdminOperationsView("7d");
  assert.equal(model.discovery.configuredSources, 60, "the sources were seen");
  assert.ok(model.discovery.byProductionStatus.HEALTHY >= 12, "and their scans were counted");

  /* The overview must stay a SUMMARY — per-provider rows belong to the detail endpoint. */
  const serialized = JSON.stringify(model);
  assert.ok(serialized.length < 60_000, `overview payload is ${serialized.length} bytes — too large for a summary`);
  assert.ok(!("providers" in model.discovery), "per-provider rows must not be embedded in the overview");
});
