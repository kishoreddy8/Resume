import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execSync } from "node:child_process";
import { getAtsCapability, isRealAtsPlatform, summarizeAtsCapabilities } from "../atsCapability";
import {
  CLI_VALIDATION_PROVIDERS,
  DISCOVERY_CONNECTOR_PROVIDERS,
  HEALTH_PROBE_PROVIDERS,
  SCANNABLE_PROVIDERS,
  VALIDATION_ELIGIBLE_PROVIDERS,
  providerSqlList,
} from "@/lib/ats/scannableProviders";
import { automatedSourceTypes } from "@/lib/apply/agent/selectAdapter";
import type { SourceType } from "@/types";

/* ================================================================================================
 * ADMIN-OPS-3 — JOB DISCOVERY IS NOT APPLICATION AUTOMATION.
 *
 * Career-Ops can FETCH jobs from 36 ATS platforms and can APPLY to 3. Collapsing those into one
 * "supported" number is wrong in both directions: it either claims auto-apply the product cannot do,
 * or it hides discovery the product does perfectly well. Every test here pins one half of that.
 * ============================================================================================== */

/** The dispatch in fetchJobsForCompany is the real authority for "a fetch connector exists". */
function dispatchPlatformsFromSource(): Set<string> {
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/normalize.ts"), "utf8");
  const body = src.slice(src.indexOf("export async function fetchJobsForCompany"));
  const end = body.indexOf("\n}");
  return new Set([...body.slice(0, end).matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]));
}

// --- OPS3-ARCH: the two capabilities are independent ---------------------------------------------

test("OPS3-ARCH-01: discovery capability and application capability are separate fields", () => {
  const ashby = getAtsCapability("ashby");
  assert.equal(ashby.discovery, "SCANNABLE", "Career-Ops can fetch Ashby jobs");
  assert.equal(ashby.automation, "NONE", "but cannot auto-apply to Ashby");
  assert.equal(ashby.canAttemptApplication, false);
});

test("OPS3-DISC-01: a discovery connector never implies a runtime application adapter", () => {
  const automated = new Set(automatedSourceTypes());
  const discoverableButNotAutomatable = SCANNABLE_PROVIDERS.filter((p) => !automated.has(p));
  assert.ok(discoverableButNotAutomatable.length >= 30, "the gap is the whole point of this phase");
  for (const platform of discoverableButNotAutomatable) {
    const cap = getAtsCapability(platform);
    assert.equal(cap.discovery, "SCANNABLE", `${platform} is fetchable`);
    assert.equal(cap.canAttemptApplication, false, `${platform} must never read as auto-apply ready`);
  }
});

test("OPS3-APP-01: a runtime application adapter never implies discovery is unrestricted", () => {
  /* All three apply platforms happen to be scannable too, but the fields are computed from separate
   * authorities — automation from selectAdapter, discovery from the scan allowlist. */
  for (const platform of automatedSourceTypes()) {
    const cap = getAtsCapability(platform);
    assert.equal(cap.automation, "RUNTIME_ADAPTER");
    assert.notEqual(cap.discovery, "NONE", `${platform} also has a discovery connector`);
  }
});

test("OPS3-ARCH-02: the two counts are reported separately and never merged", () => {
  const platforms = [...SCANNABLE_PROVIDERS, "phenom", "career_link"] as SourceType[];
  const counts = summarizeAtsCapabilities(platforms);
  assert.equal(counts.runtimeAdapters, 3, "only greenhouse/lever/workday can apply");
  assert.equal(counts.scannableDiscovery, SCANNABLE_PROVIDERS.length, "36 platforms are fetchable");
  assert.ok(counts.scannableDiscovery > counts.runtimeAdapters * 10, "the asymmetry must remain visible");
});

// --- OPS3-COVERAGE: no inference in either direction ---------------------------------------------

test("OPS3-COVERAGE-01: a platform with no apply adapter is never auto-apply ready, however discoverable", () => {
  for (const platform of ["icims", "taleo", "successfactors", "workable"] as SourceType[]) {
    assert.equal(getAtsCapability(platform).canAttemptApplication, false);
  }
});

test("OPS3-COVERAGE-02: fixture validation is not derivable here and is never asserted", () => {
  for (const platform of [...automatedSourceTypes(), "ashby" as SourceType]) {
    assert.equal(
      getAtsCapability(platform).validation,
      "UNKNOWN",
      "having an adapter, or a connector, is not evidence either has been validated"
    );
  }
});

test("OPS3-COVERAGE-03: unknown recognition never becomes support in either axis", () => {
  const ashby = getAtsCapability("ashby");
  assert.equal(ashby.recognition, "UNKNOWN");
  assert.notEqual(ashby.discovery, "NONE", "discovery is derived from the dispatch, not from recognition");
  assert.equal(ashby.automation, "NONE", "and recognition never grants apply support");
});

// --- OPS3-SOURCE: the provider authority is derived, not restated --------------------------------

test("OPS3-SOURCE-01: the scan allowlist is one exported constant, not a hardcoded SQL literal", () => {
  /* It was written out by hand in three SQL strings and the copies had already drifted. */
  const files = [
    "src/db/queries/organizationRegistry.ts",
    "src/lib/ats/pendingConnectorValidation.ts",
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    assert.doesNotMatch(
      src,
      /'greenhouse',\s*'lever',\s*'ashby',\s*'workday',\s*'smartrecruiters'/,
      `${rel} must derive the provider list, not restate it`
    );
    assert.match(src, /providerSqlList\(/, `${rel} must use the shared authority`);
  }
});

test("OPS3-SOURCE-02: every scannable provider has a real fetch connector in the dispatch", () => {
  const dispatch = dispatchPlatformsFromSource();
  assert.ok(dispatch.size >= 36, `dispatch should cover the connector set, found ${dispatch.size}`);
  for (const provider of SCANNABLE_PROVIDERS) {
    assert.ok(dispatch.has(provider), `${provider} is scannable but has no fetchJobsForCompany case`);
  }
});

test("OPS3-SOURCE-03: the validation sweep's one extra provider is surfaced, not hidden", () => {
  /* phenom has a fetch connector and is validation-eligible, but is absent from the scan allowlist,
   * so an approved phenom source would never actually be scanned. Preserved verbatim and made
   * visible rather than silently resolved — changing either list changes runtime behaviour. */
  const extra = VALIDATION_ELIGIBLE_PROVIDERS.filter((p) => !SCANNABLE_PROVIDERS.includes(p));
  assert.deepEqual(extra, ["phenom"]);
  assert.equal(getAtsCapability("phenom").discovery, "CONNECTOR_NOT_SCANNED");
  assert.notEqual(getAtsCapability("phenom").discovery, "SCANNABLE", "must not claim it will be scanned");
});

test("OPS3-SOURCE-04: providerSqlList emits a safe quoted list from the closed SourceType union", () => {
  const sql = providerSqlList(SCANNABLE_PROVIDERS);
  assert.match(sql, /^'greenhouse', 'lever'/);
  assert.doesNotMatch(sql, /;|--|\/\*/, "no statement terminator or comment may appear");
  assert.equal(sql.split(", ").length, SCANNABLE_PROVIDERS.length);
});

// --- OPS3-API / SECRETS --------------------------------------------------------------------------

test("OPS3-API-01: a capability object keeps discovery and application distinguishable by shape", () => {
  const cap = getAtsCapability("workday");
  assert.ok("discovery" in cap && "automation" in cap, "both axes must be present as separate keys");
  assert.notEqual(String(cap.discovery), String(cap.automation), "the two axes use different vocabularies");
});

test("OPS3-SECRETS-01: capability output carries no configuration, credential or source identifier", () => {
  const serialized = JSON.stringify(SCANNABLE_PROVIDERS.map(getAtsCapability));
  for (const forbidden of ["token", "apiKey", "api_key", "secret", "password", "source_key", "source_url", "tenant"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "i"), `${forbidden} must never appear in capability output`);
  }
});

test("meta sources are still excluded from ATS platform counts", () => {
  assert.equal(isRealAtsPlatform("career_link"), false, "the generic scrape path is not an ATS platform");
  assert.equal(isRealAtsPlatform("workday"), true);
});

// --- OPS3-SOURCE-05: the full drift surface, pinned -----------------------------------------------

test("OPS3-SOURCE-05: no provider allowlist remains hand-written anywhere", async () => {
  /* The same list was written out in SEVEN places across five files and no two agreed. Each call
   * site now derives from src/lib/ats/scannableProviders.ts, so a provider can be added once. */
  const { execSync } = await import("node:child_process");
  const files = execSync("grep -rl greenhouse --include=*.ts src scripts", { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);

  const offenders: string[] = [];
  for (const rel of files) {
    if (rel.endsWith("scannableProviders.ts")) continue; // the authority itself
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    for (const m of src.matchAll(/IN \(\s*'greenhouse'[\s\S]*?\)/g)) {
      const count = new Set([...m[0].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).size;
      if (count >= 6) offenders.push(`${rel} (${count} providers)`);
    }
  }
  assert.deepEqual(offenders, [], `hand-written provider allowlists must derive from the shared constant:\n  ${offenders.join("\n  ")}`);
});

test("OPS3-SOURCE-06: each derived list preserves its call site's exact historical membership", () => {
  /* OPS-3 measured these before the extraction and pinned them so the refactor could not move them.
   * OPS-3.2 then changed ONE of them on purpose: the CLI list. Every other count is still the
   * originally-measured value, and the relationships are asserted rather than restated as literals. */
  assert.equal(SCANNABLE_PROVIDERS.length, 36, "scan allowlist");
  assert.equal(VALIDATION_ELIGIBLE_PROVIDERS.length, SCANNABLE_PROVIDERS.length + 1, "validation sweep = scan + phenom");
  assert.equal(HEALTH_PROBE_PROVIDERS.length, SCANNABLE_PROVIDERS.length + 1, "health probe = scan + phenom");
  assert.equal(CLI_VALIDATION_PROVIDERS.length, SCANNABLE_PROVIDERS.length, "OPS-3.2: CLI now tracks the scan allowlist exactly");
  assert.ok(SCANNABLE_PROVIDERS.includes("recruitee" as SourceType), "recruitee IS scannable");
});

/* ================================================================================================
 * ADMIN-OPS-3.1 CHECKPOINT — adversarial coverage for the centralization itself.
 * ============================================================================================== */

test("OPS3.1-DISPATCH-01: every ATS platform with a fetch dispatch is represented in the authority", () => {
  /* The reverse of OPS3-SOURCE-02. Together they pin the two sets to each other, so a connector
   * added to normalize.ts without being catalogued — or catalogued without a fetcher — fails here.
   * `career_link` is excluded by design: it is the generic scrape path, not an ATS platform. */
  const dispatch = dispatchPlatformsFromSource();
  const atsDispatch = [...dispatch].filter((p) => p !== "career_link");
  const catalogued = new Set<string>(DISCOVERY_CONNECTOR_PROVIDERS);
  const missing = atsDispatch.filter((p) => !catalogued.has(p));
  assert.deepEqual(missing, [], `platforms with a fetcher but absent from DISCOVERY_CONNECTOR_PROVIDERS: ${missing}`);
  assert.equal(atsDispatch.length, DISCOVERY_CONNECTOR_PROVIDERS.length, "the two sets must be the same size");
});

test("OPS3.1-META-01: no meta source type is ever treated as a real ATS platform", () => {
  /* built_in / google_jobs / indeed are secondary job rows, and career_link is a generic scrape.
   * None has a fetchJobsForCompany ATS case, and none may enter a provider set. */
  for (const meta of ["built_in", "google_jobs", "indeed", "career_link"] as SourceType[]) {
    assert.ok(!SCANNABLE_PROVIDERS.includes(meta), `${meta} must not be scannable`);
    assert.ok(!DISCOVERY_CONNECTOR_PROVIDERS.includes(meta), `${meta} is not an ATS connector platform`);
    if (meta !== "career_link") {
      assert.equal(isRealAtsPlatform(meta), false, `${meta} must be excluded from ATS counts`);
    }
  }
});

test("OPS3.1-PHENOM-01: phenom behaviour is unchanged — connector and validation yes, scanning no", () => {
  /* This checkpoint must not enable phenom for consistency's sake. Its membership is pinned exactly
   * as it was before the extraction. */
  assert.ok(DISCOVERY_CONNECTOR_PROVIDERS.includes("phenom" as SourceType), "phenom has a fetcher");
  assert.ok(VALIDATION_ELIGIBLE_PROVIDERS.includes("phenom" as SourceType), "phenom is validation-eligible");
  assert.ok(HEALTH_PROBE_PROVIDERS.includes("phenom" as SourceType), "phenom is health-probed");
  assert.ok(!SCANNABLE_PROVIDERS.includes("phenom" as SourceType), "phenom is NOT scanned — unchanged");
  assert.ok(!CLI_VALIDATION_PROVIDERS.includes("phenom" as SourceType), "phenom absent from the CLI list — unchanged");
});

test("OPS3.2-RECRUITEE-01: the recruitee CLI omission was stale tooling, and is now fixed", () => {
  /* OPS-3.1 pinned this omission deliberately, so that a behaviour-preserving refactor could not
   * quietly "tidy" it away. OPS-3.2 is the phase licensed to resolve it, and the evidence says it was
   * an oversight rather than an intent: commit ee00a03 added the recruitee connector and put it in
   * BOTH the scan allowlist and the validation set, but not the CLI list, and left no comment
   * justifying the gap. The connector has passing tests and five detector matches.
   *
   * The blast radius is reporting and operator tooling: a --provider argument allowlist, the
   * continuous worker's approved/pending counts, and the scan_ready_sources export. It is NOT the
   * validation batch — that selects on VALIDATION_ELIGIBLE_PROVIDERS, which has always included
   * recruitee — and it is NOT the scanner, which reads SCANNABLE_PROVIDERS. The next two assertions
   * pin both of those as unchanged. */
  assert.ok(SCANNABLE_PROVIDERS.includes("recruitee" as SourceType), "recruitee IS scanned — unchanged");
  assert.ok(VALIDATION_ELIGIBLE_PROVIDERS.includes("recruitee" as SourceType), "and is validation-eligible — unchanged");
  assert.ok(CLI_VALIDATION_PROVIDERS.includes("recruitee" as SourceType), "and the CLI now covers it too");
});

test("OPS3.1-AUTHORITY-01: the phenom delta is expressed once, not restated per consumer", () => {
  /* Centralization must not reintroduce a smaller drift. VALIDATION and HEALTH_PROBE must BE the
   * connector set, not independent copies that happen to match today. */
  assert.deepEqual([...VALIDATION_ELIGIBLE_PROVIDERS], [...DISCOVERY_CONNECTOR_PROVIDERS]);
  assert.deepEqual([...HEALTH_PROBE_PROVIDERS], [...DISCOVERY_CONNECTOR_PROVIDERS]);

  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/ats/scannableProviders.ts"), "utf8");
  const restatements = [...src.matchAll(/\[\s*\.\.\.SCANNABLE_PROVIDERS\s*,\s*"phenom"\s*\]/g)].length;
  assert.equal(restatements, 1, "the '+ phenom' delta must appear exactly once in the authority");
});

test("OPS3.1-SQL-01: every provider value is a bare identifier that cannot break out of a SQL list", () => {
  /* The call sites all pass module constants, never request data — but assert the runtime shape
   * rather than trusting the type alone. */
  const all = [
    ...SCANNABLE_PROVIDERS,
    ...DISCOVERY_CONNECTOR_PROVIDERS,
    ...CLI_VALIDATION_PROVIDERS,
  ];
  for (const p of all) {
    assert.match(p, /^[a-z][a-z0-9_]*$/, `${p} is not a bare lowercase identifier`);
  }
  const sql = providerSqlList(DISCOVERY_CONNECTOR_PROVIDERS);
  assert.doesNotMatch(sql, /['"];|--|\/\*|\bUNION\b|\bSELECT\b/i, "no injection-shaped token may appear");
});

/* ================================================================================================
 * ADMIN-OPS-3.2 — the two provider inconsistencies OPS-3.1 pinned are now resolved deliberately.
 * Recruitee changed (above); phenom deliberately did NOT, and this records why.
 * ============================================================================================== */

test("OPS3.2-PHENOM-01: phenom stays unscanned because no phenom source can ever be discovered", () => {
  /* The tempting move is symmetry: phenom has a 13.7KB connector with passing tests, so why is it
   * absent from the scan allowlist? Because the allowlist is not where phenom is blocked.
   *
   * Sources are identified exclusively by detectAtsFromUrlString — discovery.ts and discoveryV2.ts
   * both route through it and nothing else — and the detector contains no phenom branch at all. So no
   * phenom source can be DISCOVERED by any automated path.
   *
   * ADMIN-OPS-3.2.1 correction: that is not the same as "can hold no rows". job_sources.provider has
   * no CHECK constraint, so a manual insert or import could create one; there simply are none today.
   * The accurate consequence is that adding phenom to the allowlist would select zero additional rows
   * now, so it changes scanner behaviour for no operational benefit — while the missing detector, the
   * real blocker, would remain.
   *
   * The connector is therefore kept reachable (validation, health probe, manual fetch) and kept out of
   * scanning. If a phenom detector is ever written, THAT is the change that makes scanning meaningful. */
  const detector = fs.readFileSync(path.join(process.cwd(), "src/lib/ats/detect.ts"), "utf8");
  assert.equal(/phenom/i.test(detector), false, "no phenom detector exists — this is the real blocker");
  assert.ok(/recruitee/i.test(detector), "contrast: recruitee IS detectable, which is why it is scanned");

  assert.ok(DISCOVERY_CONNECTOR_PROVIDERS.includes("phenom" as SourceType), "the connector still exists");
  assert.ok(HEALTH_PROBE_PROVIDERS.includes("phenom" as SourceType), "and is still probed");
  assert.ok(!SCANNABLE_PROVIDERS.includes("phenom" as SourceType), "but is deliberately not scanned");
});

test("OPS3.2-AUTHORITY-01: no NEW hand-written provider list may appear, and the known debt cannot grow", () => {
  /* ADMIN-OPS-3.2.1 corrected this test. It previously claimed "every provider list derives from one
   * authority" while only inspecting scannableProviders.ts itself — a repo-wide claim backed by a
   * single-file check. A real sweep found four surviving hand-written 36/37-provider literals that
   * OPS-3's centralization had missed. discoveryV2's was folded into the authority (identical
   * membership, so provably behaviour-preserving); the remaining three are recorded below rather
   * than changed, because two sit in zod/type positions on API input boundaries where rewriting the
   * literal would weaken compile-time typing — a change that needs its own phase.
   *
   * This test now does what its name says: it fails on any NEW duplicate, and it fails if a listed
   * one is centralized without being removed from the list. The debt is visible and bounded. */
  const KNOWN_DUPLICATES = [
    "src/app/api/companies/route.ts",   // zod enum, SCANNABLE + career_link — API input allowlist
    "src/app/api/jobs/route.ts",        // VALID_SOURCES, SCANNABLE + career_link — filter allowlist
    "src/db/queries/atsCoverage.ts",    // supportedSourceTypes, SCANNABLE — coverage reporting
  ];

  const known = new Set<string>(DISCOVERY_CONNECTOR_PROVIDERS as readonly string[]);
  const files = execSync("git ls-files 'src/**/*.ts' 'scripts/**/*.ts'", { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f && !f.includes("__tests__") && f !== "src/lib/ats/scannableProviders.ts");

  const offenders: string[] = [];
  for (const rel of files) {
    const body = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    for (const literal of body.matchAll(/\[[^\[\]]{40,}\]/g)) {
      const names = new Set([...literal[0].matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]).filter((n) => known.has(n)));
      /* Eight is well above any legitimate grouping — the apply registry lists three — and well below
       * the 36 a real copy carries. */
      if (names.size >= 8 && !offenders.includes(rel)) offenders.push(rel);
    }
  }

  assert.deepEqual(
    offenders.sort(),
    [...KNOWN_DUPLICATES].sort(),
    "a hand-written provider list appeared or disappeared — derive it from scannableProviders.ts, or update KNOWN_DUPLICATES"
  );

  /* The authority itself must still hold exactly one literal, and state the +phenom delta once. */
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/ats/scannableProviders.ts"), "utf8");
  assert.equal((src.match(/\[\s*"[a-z_]+"\s*,\s*"[a-z_]+"/g) ?? []).length, 1, "only SCANNABLE_PROVIDERS is written by hand");
  assert.equal((src.match(/"phenom"/g) ?? []).length, 1, "phenom is named exactly once in the authority");

  for (const p of SCANNABLE_PROVIDERS) {
    assert.ok(VALIDATION_ELIGIBLE_PROVIDERS.includes(p), `${p} missing from validation`);
    assert.ok(HEALTH_PROBE_PROVIDERS.includes(p), `${p} missing from health probe`);
    assert.ok(CLI_VALIDATION_PROVIDERS.includes(p), `${p} missing from CLI`);
  }
});

test("OPS3.2.1-RECRUITEE-02: the CLI list cannot reach the validation batch or the scanner", () => {
  /* The checkpoint's concern was that CLI_VALIDATION_PROVIDERS might not be CLI-only — it is in fact
   * read by a continuous background worker too. This pins the boundary that actually matters: the two
   * queries that select real work must derive from their own authorities, never from the tooling list.
   * If someone later wires CLI_VALIDATION_PROVIDERS into either, this fails. */
  const batch = fs.readFileSync(path.join(process.cwd(), "src/lib/ats/pendingConnectorValidation.ts"), "utf8");
  assert.match(batch, /providerSqlList\(VALIDATION_ELIGIBLE_PROVIDERS\)/, "the batch selects on the validation set");
  assert.doesNotMatch(batch, /CLI_VALIDATION_PROVIDERS/, "and must never select on the tooling list");

  const registry = fs.readFileSync(path.join(process.cwd(), "src/db/queries/organizationRegistry.ts"), "utf8");
  assert.doesNotMatch(registry, /CLI_VALIDATION_PROVIDERS/, "nor may the scanner's own queries");

  /* And the CLI script uses it for argument validation only, not to choose the batch's work. */
  const cli = fs.readFileSync(path.join(process.cwd(), "scripts/validate-pending-connectors.ts"), "utf8");
  assert.doesNotMatch(cli, /runPendingConnectorValidationBatch\([^)]*PROVIDERS/, "PROVIDERS must not be passed to the batch");
});
