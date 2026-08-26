import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
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
  /* Behaviour must be unchanged by the extraction — these are the counts measured before it. */
  assert.equal(SCANNABLE_PROVIDERS.length, 36, "scan allowlist");
  assert.equal(VALIDATION_ELIGIBLE_PROVIDERS.length, 37, "validation sweep = scan + phenom");
  assert.equal(HEALTH_PROBE_PROVIDERS.length, 37, "health probe = scan + phenom");
  assert.equal(CLI_VALIDATION_PROVIDERS.length, 35, "CLI/export = scan - recruitee");
  assert.ok(!CLI_VALIDATION_PROVIDERS.includes("recruitee" as SourceType), "the recruitee omission is preserved, not silently fixed");
  assert.ok(SCANNABLE_PROVIDERS.includes("recruitee" as SourceType), "recruitee IS scannable — that is the inconsistency");
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

test("OPS3.1-RECRUITEE-01: recruitee behaviour is unchanged — scanned, but absent from CLI tooling", () => {
  assert.ok(SCANNABLE_PROVIDERS.includes("recruitee" as SourceType), "recruitee IS scanned");
  assert.ok(VALIDATION_ELIGIBLE_PROVIDERS.includes("recruitee" as SourceType), "and is validation-eligible");
  assert.ok(!CLI_VALIDATION_PROVIDERS.includes("recruitee" as SourceType), "but the CLI omits it — unchanged");
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
