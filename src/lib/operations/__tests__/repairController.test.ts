import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/* ================================================================================================
 * ADMIN-OPS-4 — the safe repair controller.
 *
 * The contract under test is that executing a repair and being healthy are different facts. Every
 * test here works against a temp database with a MOCKED connector fetcher — no ATS is contacted, and
 * data/app.db is never opened.
 * ============================================================================================== */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let registry: typeof import("../repairRegistry");

const FIXED_PROVIDER = "greenhouse";

/** A fetcher that reports a working board. Shaped like fetchJobsForCompany's return, nothing more. */
const successFetcher = (async () => [
  { externalId: "job-1", title: "Data Engineer", location: "Remote", url: "https://example.test/j/1", description: "x" },
]) as never;

/** A fetcher that fails the way a real provider outage does. */
const failingFetcher = (async () => {
  throw new Error("Request to https://example.test failed with status 503");
}) as never;

/** A fetcher that fails the way a missing credential does — non-retryable configuration. */
const configFetcher = (async () => {
  throw new Error("Missing JobDiva API credentials — set JOBDIVA_API_USERNAME and JOBDIVA_API_PASSWORD in the server environment.");
}) as never;

function seedApprovedSource(provider = FIXED_PROVIDER, name = "Acme"): number {
  const db = getDb();
  db.prepare("INSERT INTO companies (name, source_type, ats_board_token, is_active) VALUES (?, ?, ?, 1)").run(
    name, provider, `${name}-token`
  );
  const companyId = (db.prepare("SELECT id FROM companies WHERE name = ?").get(name) as { id: number }).id;
  db.prepare("INSERT INTO organizations (canonical_name, status) VALUES (?, 'active')").run(name);
  const orgId = (db.prepare("SELECT id FROM organizations WHERE canonical_name = ?").get(name) as { id: number }).id;
  db.prepare(
    `INSERT INTO job_sources (organization_id, provider, source_key, resolution_status, review_status,
                              is_active, is_authoritative, legacy_company_id)
     VALUES (?, ?, ?, 'VERIFIED', 'APPROVED', 1, 1, ?)`
  ).run(orgId, provider, `${name}-key`, companyId);
  return (db.prepare("SELECT id FROM job_sources WHERE legacy_company_id = ?").get(companyId) as { id: number }).id;
}

/** Writes a probe row with an explicit timestamp, for freshness tests. */
function seedProbeAt(jobSourceId: number, outcome: string, finishedAt: string, category: string | null = null): void {
  const db = getDb();
  const src = db.prepare("SELECT organization_id, legacy_company_id, provider FROM job_sources WHERE id = ?").get(jobSourceId) as {
    organization_id: number; legacy_company_id: number; provider: string;
  };
  db.prepare(
    `INSERT INTO connector_health_check_runs
       (job_source_id, organization_id, company_id, provider, checker_version, outcome, jobs_seen,
        latency_ms, error_category, evidence_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, 'test.v1', ?, 0, 5, ?, '{}', ?, ?)`
  ).run(jobSourceId, src.organization_id, src.legacy_company_id, src.provider, outcome, category, finishedAt, finishedAt);
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-repair-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  registry = await import("../repairRegistry");
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM connector_health_check_runs").run();
  db.prepare("DELETE FROM scan_runs").run();
  db.prepare("DELETE FROM job_sources").run();
  db.prepare("DELETE FROM organizations").run();
  db.prepare("DELETE FROM companies").run();
});

// --- Registry is closed ---------------------------------------------------------------------------

test("OPS4-REGISTRY-01: an unknown repairId is not a repair", () => {
  for (const bogus of ["", "nope", "recheck_discovery_connector ", "__proto__", "constructor", "toString"]) {
    assert.equal(registry.isRepairId(bogus), false, `${JSON.stringify(bogus)} must not be a repair id`);
  }
  assert.equal(registry.isRepairId("recheck_discovery_connector"), true);
});

test("OPS4-REGISTRY-02: no input may name a handler, command, path or query", async () => {
  const schema = registry.REPAIR_INPUT_SCHEMAS.recheck_discovery_connector;
  const jobSourceId = seedApprovedSource();

  /* Strict schema: an extra key is rejected outright rather than carried into a handler. */
  for (const hostile of [
    { jobSourceId, command: "rm -rf /" },
    { jobSourceId, fn: "executeRepair" },
    { jobSourceId, module: "../../etc/passwd" },
    { jobSourceId, sql: "DROP TABLE job_sources" },
    { jobSourceId, url: "https://evil.test" },
    { jobSourceId, fetcher: "anything" },
  ]) {
    assert.equal(schema.safeParse(hostile).success, false, `${Object.keys(hostile)[1]} must be rejected`);
  }
  assert.equal(schema.safeParse({ jobSourceId }).success, true, "the narrow shape is accepted");
  assert.equal(schema.safeParse({ jobSourceId: "3" }).success, false, "and it is typed");

  /* The one field that exists cannot select something outside the approved population. */
  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId: 999_999 }, { fetcher: successFetcher });
  assert.equal(result.actionStatus, "REJECTED_INELIGIBLE");
});

test("OPS4-REGISTRY-03: the registry exposes exactly the repairs that exist, and no internals", () => {
  const ids = Object.keys(registry.REPAIR_DESCRIPTORS);
  assert.deepEqual(ids, ["recheck_discovery_connector"], "one repair, deliberately");
  const serialized = JSON.stringify(Object.values(registry.REPAIR_DESCRIPTORS));
  for (const leak of ["checkConnectorHealth", "fetcher", "getDb", "SELECT", "process.env"]) {
    assert.doesNotMatch(serialized, new RegExp(leak, "i"), `${leak} must not appear in a descriptor`);
  }
  /* A descriptor must never promise a fix. */
  assert.doesNotMatch(serialized, /\bfix(es|ed|ing)?\b/i, "descriptors describe actions, not cures");
});

// --- Eligibility ------------------------------------------------------------------------------------

test("OPS4-ELIGIBILITY-01: a repair cannot run against a source the scheduled checker would refuse", async () => {
  const jobSourceId = seedApprovedSource();

  /* Un-approve it — exactly the state the probe's own candidate query excludes. */
  getDb().prepare("UPDATE job_sources SET review_status = 'PENDING' WHERE id = ?").run(jobSourceId);

  const verdict = registry.checkEligibility("recheck_discovery_connector", { jobSourceId });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reasonCode, "SOURCE_NOT_PROBEABLE");

  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: successFetcher });
  assert.equal(result.actionStatus, "REJECTED_INELIGIBLE");
  assert.equal(result.verificationStatus, "NOT_ATTEMPTED");

  const probes = (getDb().prepare("SELECT COUNT(*) AS n FROM connector_health_check_runs").get() as { n: number }).n;
  assert.equal(probes, 0, "an ineligible repair must not touch the provider at all");
});

test("OPS4-ELIGIBILITY-02: an inactive company makes its source ineligible", async () => {
  const jobSourceId = seedApprovedSource();
  getDb().prepare("UPDATE companies SET is_active = 0").run();

  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: successFetcher });
  assert.equal(result.actionStatus, "REJECTED_INELIGIBLE");
});

// --- Configuration problems get no fake fix ---------------------------------------------------------

test("OPS4-CONFIG-01: a configuration failure offers no repair and claims no automatic fix", async () => {
  const { getDiscoveryConnectorHealth } = await import("../discoveryConnectorHealth");
  const jobSourceId = seedApprovedSource("jobdiva", "ConfigCo");

  await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: configFetcher });

  const row = getDiscoveryConnectorHealth().find((c) => c.provider === "jobdiva")!;
  assert.equal(row.probe.lastFailureCategory, "invalid_config", "precondition: the failure was configuration");

  const repairability = registry.repairabilityFor(row);
  assert.equal(repairability.repairability, "CONFIGURATION_REQUIRED");
  assert.deepEqual(repairability.availableActions, [], "no action may be offered for a missing setting");
  assert.doesNotMatch(repairability.reason, /JOBDIVA_API_PASSWORD=|Basic /, "and the reason names no value");
});

test("OPS4-CONFIG-02: a provider outage is classified differently from a configuration problem", async () => {
  const { getDiscoveryConnectorHealth } = await import("../discoveryConnectorHealth");
  const jobSourceId = seedApprovedSource("taleo", "DownCo");
  await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: failingFetcher });

  const row = getDiscoveryConnectorHealth().find((c) => c.provider === "taleo")!;
  const repairability = registry.repairabilityFor(row);

  assert.equal(repairability.repairability, "EXTERNAL_FAILURE");
  assert.deepEqual(
    repairability.availableActions.map((r) => r.repairId),
    ["recheck_discovery_connector"],
    "re-observing an external failure is legitimate; repairing it from here is not"
  );
});

// --- The central invariant --------------------------------------------------------------------------

test("OPS4-ACTION-01: executing a repair never itself makes anything HEALTHY", async () => {
  const jobSourceId = seedApprovedSource();

  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: failingFetcher });

  assert.equal(result.actionStatus, "EXECUTED", "the action itself succeeded — it ran and recorded evidence");
  assert.notEqual(result.healthAfter, "HEALTHY", "but a successful action must not produce health");
  assert.equal(result.verificationStatus, "VERIFIED_STILL_FAILING");
  assert.ok(!("fixed" in result), "there must be no `fixed` field to misread");
});

test("OPS4-ACTION-02: the result separates what ran from what it proved", async () => {
  const jobSourceId = seedApprovedSource();
  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: failingFetcher });

  /* The pairing that matters: action EXECUTED alongside verification STILL_FAILING. A model that
   * collapsed these into one status could not express "I did the thing and it did not help." */
  assert.equal(result.actionStatus, "EXECUTED");
  assert.equal(result.verificationStatus, "VERIFIED_STILL_FAILING");
  assert.ok(result.repairStartedAt, "and the reading is anchored to a start instant");
});

// --- Verification requires FRESH evidence ------------------------------------------------------------

test("OPS4-VERIFY-01: pre-existing healthy evidence cannot verify a later repair", async () => {
  const jobSourceId = seedApprovedSource();
  /* A healthy probe from before the repair. If freshness were not enforced, this row would be found
   * and read as proof of recovery. */
  seedProbeAt(jobSourceId, "HEALTHY_JOBS", iso(-60 * 60_000));

  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: failingFetcher });

  assert.equal(result.verificationStatus, "VERIFIED_STILL_FAILING", "the old success proves nothing");
  assert.notEqual(result.verificationStatus, "VERIFIED_RECOVERED");
});

test("OPS4-VERIFY-01b: a future-dated row cannot be mistaken for this repair's evidence", async () => {
  const jobSourceId = seedApprovedSource();
  /* Clock skew, or a row written with a bad timestamp, would sort NEWEST and is healthy. Under a
   * "latest by timestamp" rule it would be picked up and read as proof the repair worked. Selecting
   * by identity instead — the row that did not exist before the repair ran — defeats that entirely. */
  seedProbeAt(jobSourceId, "HEALTHY_JOBS", iso(60 * 60_000));

  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: failingFetcher });

  assert.notEqual(result.verificationStatus, "VERIFIED_RECOVERED", "the planted future success must not verify");
  assert.equal(result.verificationStatus, "VERIFIED_STILL_FAILING", "the repair's OWN evidence is what counts");
  assert.notEqual(result.healthAfter, "HEALTHY");
});

test("OPS4-VERIFY-04: the timestamp guard fails closed on unusable instants", () => {
  /* The second half of the freshness rule, unit-tested directly because the identity check above
   * makes it hard to reach through executeRepair. Each of these must be refused. */
  const start = "2026-08-26T12:00:00.000Z";
  const now = new Date("2026-08-26T12:05:00.000Z");

  assert.equal(registry.isUsableEvidenceTimestamp(null, start, now), false, "absent");
  assert.equal(registry.isUsableEvidenceTimestamp("not-a-date", start, now), false, "unparseable");
  assert.equal(registry.isUsableEvidenceTimestamp("2026-08-26T12:06:00.000Z", start, now), false, "in the future");
  assert.equal(registry.isUsableEvidenceTimestamp("2026-08-26T11:59:59.999Z", start, now), false, "before the repair");

  /* Same-instant is accepted: a fast repair legitimately finishes inside the millisecond it started,
   * and identity has already proven the row is new. */
  assert.equal(registry.isUsableEvidenceTimestamp(start, start, now), true, "same instant");
  assert.equal(registry.isUsableEvidenceTimestamp("2026-08-26T12:01:00.000Z", start, now), true, "after");
});

test("OPS4-VERIFY-02: fresh successful evidence does verify recovery", async () => {
  const jobSourceId = seedApprovedSource();
  seedProbeAt(jobSourceId, "FAILED_HARD", iso(-60 * 60_000), "network");

  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: successFetcher });

  assert.equal(result.actionStatus, "EXECUTED");
  assert.equal(result.verificationStatus, "VERIFIED_RECOVERED");
  assert.equal(result.healthAfter, "HEALTHY", "and health followed the evidence, not the action");

  const fresh = getDb()
    .prepare("SELECT finished_at FROM connector_health_check_runs ORDER BY id DESC LIMIT 1")
    .get() as { finished_at: string };
  assert.ok(fresh.finished_at >= result.repairStartedAt, "the verifying row really is newer than the repair start");
});

test("OPS4-VERIFY-03: fresh failing evidence leaves the subsystem unhealthy", async () => {
  const jobSourceId = seedApprovedSource();
  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: failingFetcher });

  assert.equal(result.verificationStatus, "VERIFIED_STILL_FAILING");
  assert.notEqual(result.healthAfter, "HEALTHY");
});

// --- Idempotency ---------------------------------------------------------------------------------------

test("OPS4-IDEMPOTENT-01: running the repair twice is safe and not more destructive", async () => {
  const jobSourceId = seedApprovedSource();

  const first = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: successFetcher });
  const second = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: successFetcher });

  assert.equal(first.actionStatus, "EXECUTED");
  assert.equal(second.actionStatus, "EXECUTED");
  assert.equal(second.verificationStatus, "VERIFIED_RECOVERED");

  /* The only accumulation is append-only evidence — no source, company or job row is touched. */
  const db = getDb();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM connector_health_check_runs").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM job_sources").get() as { n: number }).n, 1);
  assert.equal(
    (db.prepare("SELECT review_status FROM job_sources WHERE id = ?").get(jobSourceId) as { review_status: string }).review_status,
    "APPROVED",
    "approval is untouched by any number of re-checks"
  );
});

// --- Boundaries ------------------------------------------------------------------------------------------

test("OPS4-DISCOVERY-01: the repair path cannot reach application automation", async () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/operations/repairRegistry.ts"), "utf8");
  for (const forbidden of ["@/lib/apply", "selectAdapter", "submitApplication", "applicationRun", "answerMemory"]) {
    assert.ok(!src.includes(forbidden), `the repair registry must not import ${forbidden}`);
  }

  /* And a healthy discovery verdict still says nothing about applying. */
  const { automatedSourceTypes } = await import("@/lib/apply/agent/selectAdapter");
  const jobSourceId = seedApprovedSource("ashby", "AshbyCo");
  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: successFetcher });
  assert.equal(result.verificationStatus, "VERIFIED_RECOVERED");
  assert.equal(automatedSourceTypes().includes("ashby"), false, "Ashby discovery works; Ashby apply does not exist");
});

test("OPS4-SUBMIT-01: no repair can submit or approve an application, or write candidate data", () => {
  const registrySrc = fs.readFileSync(path.join(process.cwd(), "src/lib/operations/repairRegistry.ts"), "utf8");
  const routeSrc = fs.readFileSync(path.join(process.cwd(), "src/app/api/admin/repairs/[repairId]/route.ts"), "utf8");

  for (const src of [registrySrc, routeSrc]) {
    for (const forbidden of [
      "INSERT INTO applications", "UPDATE applications", "INSERT INTO application_runs",
      "answer_memory", "work_authorization", "sponsorship", "approveProposal",
      "UPDATE job_sources", "INSERT INTO job_sources", "DELETE FROM",
    ]) {
      assert.ok(!src.includes(forbidden), `${forbidden} must not appear in the repair path`);
    }
  }
  /* The only write the registry performs is the probe's own evidence row, made by the checker. */
  assert.ok(registrySrc.includes("checkConnectorHealth"), "the one mutation is the recorded probe");
});

test("OPS4-SECRETS-01: no credential value appears in a repair result", async () => {
  const jobSourceId = seedApprovedSource("jobdiva", "SecretCo");
  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: configFetcher });

  const serialized = JSON.stringify(result);
  for (const f of ["password", "authorization", "Basic ", "secret", "JOBDIVA_API_PASSWORD"]) {
    assert.doesNotMatch(serialized, new RegExp(f, "i"), `${f} must never appear in a repair result`);
  }
  /* The safe category IS wanted — it is what tells an operator this is configuration, not an outage. */
  assert.match(serialized, /invalid_config/);
});

// --- Policy ------------------------------------------------------------------------------------------------

test("OPS4-POLICY-01: the repair route is declared OPERATOR in the mutation policy", async () => {
  const { MUTATION_POLICIES, FUTURE_REPAIR_ROUTE_GUARD } = await import("@/lib/auth/mutationPolicy");
  const entry = MUTATION_POLICIES.find((p) => p.route === "admin/repairs/[repairId]");

  assert.ok(entry, "the repair route must be declared — an undeclared mutating route is the hole the registry exists to close");
  assert.equal(entry!.guard, "OPERATOR");
  assert.equal(entry!.guard, FUTURE_REPAIR_ROUTE_GUARD, "and it matches what ADMIN-SEC-1 reserved for repair routes");
  assert.deepEqual(entry!.methods, ["POST"]);
});

test("OPS4-AUTH-01: the repair route is operator-guarded, and never candidate-guarded", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/api/admin/repairs/[repairId]/route.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.match(code, /requireAdminOwner\(req\)/, "the operator guard must actually be called");
  assert.match(code, /if \(!authorization\.ok\) return authorization\.response/, "and its refusal returned");
  assert.doesNotMatch(code, /requireCandidateAccess/, "candidate authority is not a repair boundary");
  /* The guard must precede any work. */
  assert.ok(
    code.indexOf("requireAdminOwner") < code.indexOf("context.params"),
    "authorization must come before the request is even interpreted"
  );
});

test("OPS4-AUTH-02: no test seam is reachable from the HTTP boundary", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/api/admin/repairs/[repairId]/route.ts"), "utf8");
  /* Comments are stripped first: the route's doc comment explains the seam deliberately, and
   * documenting a boundary is not crossing it. Only executable code is asserted on. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /* executeRepair's third argument carries the fetcher override. The route must never pass one. */
  assert.match(code, /executeRepair\(repairId as RepairId, parsed\.data as never\)/, "no options argument from HTTP");
  assert.doesNotMatch(code, /fetcher/, "no executable line may reference the test seam");
});

test("OPS4-DERIVED-01: health has no setter anywhere — it is derived, never assigned", async () => {
  /* The failure this forbids is the shortcut a repair controller invites: mark it green because the
   * action succeeded. There must be no seam to do that with. */
  const { execSync } = await import("node:child_process");
  const files = execSync("git ls-files 'src/**/*.ts'", { encoding: "utf8" })
    .trim().split("\n").filter((f) => f && !f.includes("__tests__"));

  const offenders: string[] = [];
  for (const rel of files) {
    const body = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    /* A function that takes a health verdict and stores it. Deriving one and returning it is fine;
     * persisting an operator-supplied verdict is not. */
    if (/function\s+setHealth\b|setHealthStatus\s*\(|UPDATE\s+\w+\s+SET\s+health\s*=/i.test(body)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "no health setter may exist");

  /* And the repair path in particular never names a verdict as a value it could assign. */
  const registrySrc = fs.readFileSync(path.join(process.cwd(), "src/lib/operations/repairRegistry.ts"), "utf8");
  assert.doesNotMatch(registrySrc, /healthAfter\s*=\s*"HEALTHY"/, "healthAfter must be re-derived, never set");
  assert.match(registrySrc, /const healthAfter = providerHealth\(source\.provider\)/, "it is re-read from storage");
});

test("OPS4-CATALOG-01: the operational API exposes repairability without inventing actions", async () => {
  const { getDiscoveryConnectorHealth } = await import("../discoveryConnectorHealth");

  /* A provider with a connector, no sources and no evidence must offer nothing. */
  const untouched = getDiscoveryConnectorHealth().find((c) => c.provider === "personio")!;
  const r = registry.repairabilityFor(untouched);
  assert.equal(r.repairability, "CONFIGURATION_REQUIRED");
  assert.deepEqual(r.availableActions, [], "no source means nothing to check");

  /* Every offered repair must exist in the closed registry. */
  const jobSourceId = seedApprovedSource("workable", "OfferCo");
  await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: failingFetcher });
  const failing = getDiscoveryConnectorHealth().find((c) => c.provider === "workable")!;
  for (const offer of registry.repairabilityFor(failing).availableActions) {
    assert.ok(registry.isRepairId(offer.repairId), `${offer.repairId} must be a registered repair`);
  }
});

test("OPS4-CONCURRENCY-01: simultaneous re-checks of one source stay bounded and non-destructive", async () => {
  const jobSourceId = seedApprovedSource();

  const [a, b] = await Promise.all([
    registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: successFetcher }),
    registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: successFetcher }),
  ]);

  /* Both ran; both saw fresh evidence. They may have read each other's row — the same probe against
   * the same source in the same instant — which is why the assertion is on the verdict, not on which
   * row produced it. */
  for (const r of [a, b]) {
    assert.equal(r.actionStatus, "EXECUTED");
    assert.equal(r.verificationStatus, "VERIFIED_RECOVERED");
  }

  const db = getDb();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM connector_health_check_runs").get() as { n: number }).n, 2,
    "exactly one evidence row each — nothing is lost or duplicated");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM job_sources").get() as { n: number }).n, 1,
    "and no source row is created, removed or altered by concurrent repairs");
});

test("OPS4-CONCURRENCY-02: repairs on different sources never read each other's evidence", async () => {
  const a = seedApprovedSource("greenhouse", "AlphaCo");
  const b = seedApprovedSource("lever", "BetaCo");

  const [ra, rb] = await Promise.all([
    registry.executeRepair("recheck_discovery_connector", { jobSourceId: a }, { fetcher: successFetcher }),
    registry.executeRepair("recheck_discovery_connector", { jobSourceId: b }, { fetcher: failingFetcher }),
  ]);

  assert.equal(ra.verificationStatus, "VERIFIED_RECOVERED", "the healthy source is not poisoned by the failing one");
  assert.equal(rb.verificationStatus, "VERIFIED_STILL_FAILING", "and the failing one is not rescued by the healthy one");
});

/* ================================================================================================
 * ADMIN-OPS-4.1 CHECKPOINT — adversarial re-review.
 * ============================================================================================== */

test("OPS4.1-REGISTRY-01: no prototype or inherited property can resolve as a repair", () => {
  const NUL = String.fromCharCode(0);
  for (const hostile of [
    "__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty",
    "isPrototypeOf", "propertyIsEnumerable", "../../../etc/passwd",
    "RECHECK_DISCOVERY_CONNECTOR", " recheck_discovery_connector", "recheck_discovery_connector ",
    "recheck%5Fdiscovery%5Fconnector", `recheck_discovery_connector${NUL}`,
  ]) {
    assert.equal(registry.isRepairId(hostile), false, `${JSON.stringify(hostile)} must not resolve`);
  }
  /* An object whose PROTOTYPE carries the real id must not resolve either — the check must prove own
   * membership, not mere reachability. */
  assert.equal(registry.isRepairId(Object.create({ recheck_discovery_connector: 1 })), false);
  for (const v of [0, 1, NaN, Infinity, null, undefined, true, {}, [], ["recheck_discovery_connector"]]) {
    assert.equal(registry.isRepairId(v), false, `${String(v)} must not resolve`);
  }
  assert.equal(registry.isRepairId("recheck_discovery_connector"), true, "and the real id still works");
});

test("OPS4.1-REGISTRY-02: numeric edge cases and coercions are refused by the input schema", () => {
  const S = registry.REPAIR_INPUT_SCHEMAS.recheck_discovery_connector;
  for (const [label, value] of [
    ["float", 1.5], ["negative", -1], ["zero", 0], ["NaN", NaN], ["Infinity", Infinity],
    ["string", "1"], ["null", null], ["array", [1]], ["object", { valueOf: 1 }],
  ] as [string, unknown][]) {
    assert.equal(S.safeParse({ jobSourceId: value }).success, false, `${label} must be refused`);
  }
  assert.equal(S.safeParse({ jobSourceId: 1 }).success, true);
});

test("OPS4.1-AUTH-01: authorization is evaluated before any request data is read", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/api/admin/repairs/[repairId]/route.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const guardAt = code.indexOf("requireAdminOwner");
  for (const later of ["context.params", "req.json()", "safeParse", "executeRepair", "isRepairId"]) {
    assert.ok(guardAt < code.indexOf(later), `${later} must not be reached before authorization`);
  }
  /* An unauthenticated caller must not be able to tell a real repairId from a fake one, because the
   * guard returns before the id is even examined. */
  assert.ok(guardAt >= 0 && guardAt < 400, "the guard is the first statement in the handler");
});

test("OPS4.1-AI-01: verification reads THIS repair's evidence by identity, never the newest row", () => {
  /* The defect this pins is cross-process and therefore not reproducible in a single-process test:
   * within one Node process the probe's INSERT and the verification read are adjacent and
   * synchronous. Across processes — an operator repairing while the launchd connector-health batch
   * probes the same source — a scan for "any row above the pre-repair watermark" could return the
   * batch's row, letting a failed probe announce recovery on a stranger's success.
   *
   * The structural assertion is what actually discriminates the fixed model from the broken one, so
   * it is stated directly rather than dressed up as behaviour. */
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/operations/repairRegistry.ts"), "utf8");

  assert.match(src, /WHERE id = \? AND job_source_id = \?/, "verification selects one row by identity");
  assert.doesNotMatch(src, /AND id > \?/, "no watermark scan may remain");
  assert.doesNotMatch(src, /ORDER BY finished_at DESC/, "and no newest-by-timestamp fallback");
  assert.match(src, /evidenceId = probe\.evidenceId/, "the id comes from this invocation's own probe");
  assert.match(src, /evidenceId === null \? null : evidenceById/, "and no id means no verification");
});

test("OPS4.1-CONCURRENCY-01: interleaved same-source repairs each report their OWN probe outcome", async () => {
  const jobSourceId = seedApprovedSource();

  /* Deliberately opposite outcomes, started together. If either could adopt the other's evidence,
   * one of these assertions would flip. */
  const [failed, succeeded] = await Promise.all([
    registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: failingFetcher }),
    registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: successFetcher }),
  ]);

  assert.equal(failed.verificationStatus, "VERIFIED_STILL_FAILING", "the failing probe must not claim recovery");
  assert.equal(succeeded.verificationStatus, "VERIFIED_RECOVERED", "and the succeeding one must not be dragged down");

  const rows = getDb()
    .prepare("SELECT outcome FROM connector_health_check_runs WHERE job_source_id = ? ORDER BY id")
    .all(jobSourceId) as { outcome: string }[];
  assert.equal(rows.length, 2, "one evidence row per repair — neither consumed the other's");
});

test("OPS4.1-CONCURRENCY-02: a foreign healthy row for the same source cannot rescue a failed repair", async () => {
  const jobSourceId = seedApprovedSource();
  /* Stands in for the scheduled batch having just probed the same source successfully. */
  seedProbeAt(jobSourceId, "HEALTHY_JOBS", new Date().toISOString());

  const result = await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: failingFetcher });
  assert.equal(result.verificationStatus, "VERIFIED_STILL_FAILING", "only this repair's own probe counts");
});

test("OPS4.1-DB-01: the repair suite never opens the real application database", () => {
  /* CAREER_OPS_DB_PATH is redirected in before(), so every getDb() here resolves to the temp file. */
  assert.ok(process.env.CAREER_OPS_DB_PATH?.startsWith(os.tmpdir()), "the DB path is a temp file");
  assert.ok(!process.env.CAREER_OPS_DB_PATH?.includes("data/app.db"), "and never the production database");
});

test("OPS4.1-EXTERNAL-01: a provider outage offers a DIAGNOSTIC action, never a claimed fix", async () => {
  const { getDiscoveryConnectorHealth } = await import("../discoveryConnectorHealth");
  const jobSourceId = seedApprovedSource("taleo", "OutageCo");
  await registry.executeRepair("recheck_discovery_connector", { jobSourceId }, { fetcher: failingFetcher });

  const row = getDiscoveryConnectorHealth().find((c) => c.provider === "taleo")!;
  const r = registry.repairabilityFor(row);

  assert.equal(r.repairability, "EXTERNAL_FAILURE", "Admin cannot mend someone else's provider");
  assert.equal(r.availableActions.length, 1);
  assert.equal(r.availableActions[0].kind, "DIAGNOSTIC", "and what it offers is re-observation, not repair");

  /* The overclaim risk is in the LABEL a UI renders as a button or heading, not in explanatory prose
   * — a reason may legitimately mention confirming "an external fix" the operator made themselves.
   * So the assertion targets titles, which is what would read as a promise. */
  for (const d of Object.values(registry.REPAIR_DESCRIPTORS)) {
    assert.doesNotMatch(d.title, /\bfix\b|\brepair\b|\bresolve\b|\brestore\b/i, `title "${d.title}" must not promise a cure`);
  }
  for (const a of r.availableActions) {
    assert.doesNotMatch(a.title, /\bfix\b|\brepair\b|\bresolve\b/i, `offer "${a.title}" must not promise a cure`);
  }
  /* And no REPAIR-kind action exists yet, so nothing can be mislabelled as one. */
  assert.deepEqual(Object.values(registry.REPAIR_DESCRIPTORS).filter((d) => d.kind === "REPAIR"), []);
});

test("OPS4.1-STATUS-01: the route maps each outcome to the established status convention", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/api/admin/repairs/[repairId]/route.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.match(code, /status: 404/, "unknown repair id");
  assert.match(code, /status: 400/, "malformed input");
  assert.match(code, /"REJECTED_INELIGIBLE" \? 409 : 200/, "ineligible resource is a conflict, not an error");
  /* The attacker-controlled id must not be echoed back. */
  assert.doesNotMatch(code, /error: `[^`]*\$\{repairId\}/, "the requested id is never reflected into the body");
});
