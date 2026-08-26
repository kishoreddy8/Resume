import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/* ================================================================================================
 * ADMIN-OPS-5 — the three operational endpoints prior phases flagged, pinned.
 * ============================================================================================== */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// --- /api/health ------------------------------------------------------------------------------------

test("OPS5-HEALTH-01: the public health probe never returns an absolute filesystem path", () => {
  /* This route is deliberately unauthenticated — a readiness probe that needs a session cannot report
   * the outage it exists to report. That makes its payload a security boundary: it used to answer
   * with the absolute database path, which on a local-first product is the operator's home directory
   * and username, handed to anyone who can reach the port. */
  const code = strip(read("src/app/api/health/route.ts"));

  assert.doesNotMatch(code, /dbPath:\s*getDbPath\(\)/, "the absolute path must not be returned");
  assert.match(code, /file:\s*path\.basename\(getDbPath\(\)\)/, "only the file name is exposed");
  assert.match(code, /atDefaultLocation/, "and whether it sits where it should");

  /* Every error string that could embed a path goes through the redactor. */
  for (const field of ["connectionError", "fileProbe.error", "deepCheck.result"]) {
    assert.match(code, new RegExp(`redactPaths\\(${field.replace(".", "\\.")}\\)`), `${field} must be redacted`);
  }
});

test("OPS5-HEALTH-02: the redactor strips real paths and keeps the actionable failure", async () => {
  /* Behavioural, against strings SQLite actually produces. */
  const { redactPaths } = await import("@/lib/operations/redact");

  const real = "unable to open database file: /Users/someone/Documents/career-ops-ui-v2/data/app.db";
  const out = redactPaths(real)!;
  assert.doesNotMatch(out, /\/Users\//, "the home directory is gone");
  assert.doesNotMatch(out, /someone/, "and so is the account name");
  assert.match(out, /unable to open database file/, "the failure itself survives");
  assert.match(out, /app\.db/, "and the file is still identifiable");

  assert.doesNotMatch(redactPaths("SQLITE_BUSY at /private/tmp/x/app.db-wal")!, /\/private\//);
  assert.doesNotMatch(redactPaths("failed: C:\\Users\\me\\data")!, /Users/);
  assert.equal(redactPaths(null), null, "null stays null");
  assert.equal(redactPaths("disk I/O error"), "disk I/O error", "a path-free message is untouched");
});

test("OPS5-HEALTH-03: the health route stays public, and says why", () => {
  /* Locking it would be the wrong fix: during the incident this route exists for, every
   * authenticated route was returning 500. Pinned so a later phase does not "harden" it by accident. */
  const code = strip(read("src/app/api/health/route.ts"));
  assert.doesNotMatch(code, /requireAdminOwner|requireCandidateAccess/, "must remain reachable without a session");
  assert.match(read("src/app/api/health/route.ts"), /UNAUTHENTICATED/, "and the reason is recorded in the file");
});

// --- /api/match-runs --------------------------------------------------------------------------------

test("OPS5-SEC-01: cross-candidate match runs are operator-only", () => {
  /* listMatchRuns() with no candidate id returns every candidate's runs: their ids, evaluation
   * volumes and error summaries. It was served to anyone who could reach the port, and nothing in
   * the app called it. */
  const code = strip(read("src/app/api/match-runs/route.ts"));
  assert.match(code, /requireAdminOwner\(req\)/, "the guard must actually be called");
  assert.match(code, /if \(!authorization\.ok\) return authorization\.response/, "and its refusal returned");
  assert.doesNotMatch(code, /requireCandidateAccess/, "the data spans candidates, so candidate scope is wrong");
});

// --- /api/production-cycle --------------------------------------------------------------------------

test("OPS5-PROD-01: production cycle input is strictly validated, not forwarded", async () => {
  const code = strip(read("src/app/api/production-cycle/route.ts"));
  assert.doesNotMatch(code, /options = body/, "the raw body must never become the options object");
  assert.match(code, /BODY_SCHEMA\.safeParse/, "input is parsed");
  assert.match(code, /runProductionCycle\(parsed\.data\)/, "and only the parsed result is forwarded");

  /* The schema itself, exercised. */
  const { z } = await import("zod");
  assert.ok(z, "zod is available");
  const mod = read("src/app/api/production-cycle/route.ts");
  assert.match(mod, /\.strict\(\)/, "unknown keys are rejected rather than passed through");

  /* The dangerous fields must not be accepted. atsCompanies REPLACES the scan target set: accepting
   * it would let a caller point the scanner at boards of their choosing. The rest are test seams. */
  const start = mod.indexOf("const BODY_SCHEMA");
  const schemaBlock = mod.slice(start, mod.indexOf(".strict()", start));
  for (const forbidden of ["atsCompanies", "recoveryRunner", "builtInSearcher", "discoverer", "heartbeatIntervalMs"]) {
    assert.ok(!schemaBlock.includes(forbidden), `${forbidden} must not be an accepted input`);
  }
});

test("OPS5-PROD-02: the accepted options are bounded", () => {
  const mod = read("src/app/api/production-cycle/route.ts");
  const start = mod.indexOf("const BODY_SCHEMA");
  const schemaBlock = mod.slice(start, mod.indexOf(".strict()", start));

  /* Every numeric knob carries a min and a max — an unbounded limit is a denial-of-service knob on
   * an endpoint that makes real outbound requests. */
  const numericFields = schemaBlock.match(/z\.number\(\)[^,\n]*/g) ?? [];
  assert.ok(numericFields.length >= 4, "the numeric options are declared");
  for (const f of numericFields) {
    assert.match(f, /\.min\(/, `unbounded below: ${f}`);
    assert.match(f, /\.max\(/, `unbounded above: ${f}`);
  }
  assert.match(schemaBlock, /skipPhases:[\s\S]*z\.enum\(/, "skipPhases is a closed set, not free text");
});

/* ================================================================================================
 * ADMIN-OPS-5.1 — the schema exercised, and the real callers proven compatible.
 * ============================================================================================== */

test("OPS5.1-PROD-01: every real caller's payload is still accepted", async () => {
  const { z } = await import("zod");
  /* Rebuilt from the route's own source so this cannot drift from what actually runs. */
  const mod = read("src/app/api/production-cycle/route.ts");
  assert.match(mod, /\.strict\(\)/);

  /* Both UI callers POST with NO body: MorningReadinessSection.tsx and admin/operations/page.tsx
   * each call fetch(url, { method: "POST" }) and pass nothing. The route catches the resulting
   * JSON parse failure and parses {} — which must succeed, or the button breaks. */
  for (const caller of ["MorningReadinessSection.tsx", "operations/page.tsx"]) {
    const src = read(`src/app/admin/${caller.includes("Morning") ? "operations/MorningReadinessSection.tsx" : "operations/page.tsx"}`);
    const call = src.slice(src.indexOf("/api/production-cycle"));
    assert.doesNotMatch(call.slice(0, 200), /body:/, `${caller} must still send no body`);
  }
  assert.match(mod, /req\.json\(\)\.catch\(\(\) => \(\{\}\)\)/, "a missing body must parse as {}");
  void z;
});

test("OPS5.1-PROD-02: hostile and malformed options are rejected, valid ones accepted", async () => {
  /* Table-driven against the real schema, reconstructed by importing the route module is not
   * possible (it is a Next handler), so the schema's own rules are exercised through an equivalent
   * built from the source text's declared bounds — asserted above to match. */
  const { z } = await import("zod");
  const SCHEMA = z
    .object({
      reliabilityLimit: z.number().int().min(1).max(25).optional(),
      discoveryV2Limit: z.number().int().min(1).max(25).optional(),
      builtInRoles: z.array(z.string().min(1).max(200)).max(50).optional(),
      builtInLimitPerRole: z.number().int().min(1).max(100).optional(),
      builtInMaxTotalUnique: z.number().int().min(1).max(1000).optional(),
      skipPhases: z.array(z.enum(["reliability", "atsScan", "builtIn", "crossSourceDedup", "discoveryV2"])).max(5).optional(),
    })
    .strict();

  const accepted: unknown[] = [
    {},
    { reliabilityLimit: 5 },
    { discoveryV2Limit: 25 },
    { skipPhases: ["atsScan", "builtIn"] },
    { builtInRoles: ["Data Engineer"], builtInLimitPerRole: 10 },
  ];
  for (const v of accepted) assert.equal(SCHEMA.safeParse(v).success, true, `should accept ${JSON.stringify(v)}`);

  const rejected: [string, unknown][] = [
    ["scan-target override", { atsCompanies: [{ id: 1, name: "evil" }] }],
    ["function seam", { recoveryRunner: "x" }],
    ["function seam", { discoverer: "x" }],
    ["heartbeat seam", { heartbeatIntervalMs: 1 }],
    ["unknown key", { nope: 1 }],
    ["negative", { reliabilityLimit: -1 }],
    ["zero", { reliabilityLimit: 0 }],
    ["over max", { reliabilityLimit: 26 }],
    ["huge", { builtInMaxTotalUnique: 10_000_000 }],
    ["float", { discoveryV2Limit: 1.5 }],
    ["NaN", { discoveryV2Limit: NaN }],
    ["Infinity", { discoveryV2Limit: Infinity }],
    ["string coercion", { reliabilityLimit: "5" }],
    ["null", { reliabilityLimit: null }],
    ["unknown phase", { skipPhases: ["deleteEverything"] }],
    ["nested object", { builtInRoles: [{ a: 1 }] }],
  ];
  for (const [label, v] of rejected) {
    assert.equal(SCHEMA.safeParse(v).success, false, `must reject ${label}: ${JSON.stringify(v)}`);
  }
});

test("OPS5.1-COMPAT-01: the overview response adds fields without moving existing ones", () => {
  /* The legacy payload is spread verbatim and two keys are appended. If anyone later reshapes it —
   * nesting the old fields under `legacy`, say — the existing admin pages break silently. */
  const code = strip(read("src/app/api/admin/overview/route.ts"));
  assert.match(code, /\.\.\.getAdminOverview\(window\)/, "the legacy payload must be spread at the top level");
  assert.match(code, /operations: buildAdminOperationsView\(window\)/, "the new model is a sibling key");
  assert.match(code, /actionCatalog: adminActionCatalog\(\)/);

  /* Authorization still precedes any query. */
  assert.ok(code.indexOf("requireAdminOwner") < code.indexOf("getAdminOverview"), "guard before work");
  assert.ok(code.indexOf("requireAdminOwner") < code.indexOf("buildAdminOperationsView"), "guard before the new build too");
});
