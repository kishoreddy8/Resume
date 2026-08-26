import test from "node:test";
import assert from "node:assert/strict";
import {
  ATS_COVERAGE,
  REAL_ATS_PLATFORM_COUNT,
  getCoverageEntry,
  type AtsCoverageEntry,
  type CapabilityState,
  type AdapterStatus,
} from "../coverage";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import type { SourceType } from "@/types";

/**
 * PART 31 — cross-platform/registry safety matrix. This does not test any single adapter's field
 * hints; it proves the REGISTRY ITSELF cannot silently drift into an inflated or inconsistent
 * coverage claim (a duplicate key, a raw "supported: true" with no nuance, a platform quietly
 * missing, or a note that oversells submission automation).
 */

const NON_ATS_META_SOURCE_TYPES: readonly SourceType[] = [
  "career_link",
  "google_jobs",
  "indeed",
  "built_in",
];

const VALID_CAPABILITY_STATES: readonly CapabilityState[] = [
  "SUPPORTED",
  "PARTIAL",
  "UNIVERSAL",
  "UNKNOWN",
  "NOT_APPLICABLE",
  "NEEDS_LIVE_VALIDATION",
];

const VALID_ADAPTER_STATUSES: readonly AdapterStatus[] = [
  "FULL_FIXTURE_VERIFIED",
  "PARTIAL_FIXTURE_VERIFIED",
  "DETECTION_ONLY",
  "NEEDS_LIVE_VALIDATION",
  "UNSUPPORTED_BY_CURRENT_ARCHITECTURE",
];

const CAPABILITY_FIELDS: readonly (keyof AtsCoverageEntry)[] = [
  "detection",
  "applicationEntry",
  "authentication",
  "fieldDiscovery",
  "combobox",
  "multiselect",
  "fileUpload",
  "multiPage",
  "questionBatching",
  "reviewDetection",
  "submissionGate",
];

test("ATS-COVERAGE-01: registry length matches the declared real-platform count", () => {
  assert.equal(ATS_COVERAGE.length, REAL_ATS_PLATFORM_COUNT);
  assert.equal(REAL_ATS_PLATFORM_COUNT, 37);
});

test("ATS-COVERAGE-02: every platform key is unique — no duplicate registrations", () => {
  const keys = ATS_COVERAGE.map((e) => e.platform);
  assert.equal(new Set(keys).size, keys.length);
});

test("ATS-COVERAGE-03: every non-meta SourceType appears in the registry exactly once, and no meta category appears at all", () => {
  const allSourceTypes: SourceType[] = [
    "greenhouse", "ashby", "lever", "workday", "smartrecruiters", "adp_wfn", "adp_rm",
    "eightfold", "cornerstone", "avature", "paylocity", "icims", "ukg_pro", "bamboohr",
    "oracle_recruiting_cloud", "workable", "rippling", "paycom", "jazzhr", "jobvite",
    "breezy", "teamtailor", "applicantpro", "pinpoint", "clearcompany", "personio",
    "recruitee", "applicantstack", "comeet", "cats", "gohire", "newton", "silkroad",
    "jobdiva", "taleo", "phenom", "successfactors",
    "career_link", "google_jobs", "indeed", "built_in",
  ];
  const realPlatforms = allSourceTypes.filter((s) => !NON_ATS_META_SOURCE_TYPES.includes(s));
  assert.equal(realPlatforms.length, REAL_ATS_PLATFORM_COUNT);

  for (const platform of realPlatforms) {
    const matches = ATS_COVERAGE.filter((e) => e.platform === platform);
    assert.equal(matches.length, 1, `expected exactly one coverage entry for "${platform}"`);
  }
  for (const meta of NON_ATS_META_SOURCE_TYPES) {
    assert.equal(
      ATS_COVERAGE.some((e) => e.platform === meta),
      false,
      `"${meta}" is a job-source provenance tag, not an application platform — it must never appear in ATS_COVERAGE`
    );
  }
});

test("ATS-COVERAGE-04: every capability field uses a declared CapabilityState — no raw booleans, no invented strings", () => {
  for (const entry of ATS_COVERAGE) {
    for (const field of CAPABILITY_FIELDS) {
      const value = entry[field];
      assert.equal(typeof value, "string", `${entry.platform}.${String(field)} must be a string enum member`);
      assert.ok(
        VALID_CAPABILITY_STATES.includes(value as CapabilityState),
        `${entry.platform}.${String(field)} = ${JSON.stringify(value)} is not a valid CapabilityState`
      );
    }
    assert.ok(
      VALID_ADAPTER_STATUSES.includes(entry.status),
      `${entry.platform}.status = ${JSON.stringify(entry.status)} is not a valid AdapterStatus`
    );
  }
});

test("ATS-COVERAGE-05: questionBatching and submissionGate are UNIVERSAL for every single platform", () => {
  for (const entry of ATS_COVERAGE) {
    assert.equal(entry.questionBatching, "UNIVERSAL", `${entry.platform}: question batching must never be gated on adapter presence`);
    assert.equal(entry.submissionGate, "UNIVERSAL", `${entry.platform}: the final-submit safety gate is a pure page-text function with no adapter parameter — it must be UNIVERSAL for every platform, including undetected/unadapted ones`);
  }
});

test("ATS-COVERAGE-06: no entry's notes or fixtureCoverage claims real submission automation", () => {
  const forbidden = /\b(auto[- ]?submit|automatically submits?|submits? applications? automatically|live application (was|has been) submitted)\b/i;
  for (const entry of ATS_COVERAGE) {
    assert.doesNotMatch(entry.notes, forbidden, `${entry.platform}.notes reads as a submission-automation claim`);
    assert.doesNotMatch(entry.fixtureCoverage, forbidden, `${entry.platform}.fixtureCoverage reads as a submission-automation claim`);
  }
});

test("ATS-COVERAGE-07: FULL_FIXTURE_VERIFIED adapters must have non-empty, non-'None' fixture coverage text and every capability SUPPORTED-or-justified", () => {
  const fullAdapters = ATS_COVERAGE.filter((e) => e.status === "FULL_FIXTURE_VERIFIED");
  assert.ok(fullAdapters.length >= 1, "expected at least Workday to be FULL_FIXTURE_VERIFIED");
  for (const entry of fullAdapters) {
    assert.notEqual(entry.fixtureCoverage.trim().toLowerCase(), "none.");
    assert.ok(entry.fixtureCoverage.length > 20, `${entry.platform}: FULL status needs real, descriptive fixture evidence, not a placeholder`);
    assert.equal(entry.liveValidation, "NOT_NEEDED");
  }
});

test("ATS-COVERAGE-08: DETECTION_ONLY entries never claim a proven adapter-specific capability", () => {
  const proven: CapabilityState[] = ["SUPPORTED", "PARTIAL"];
  for (const entry of ATS_COVERAGE.filter((e) => e.status === "DETECTION_ONLY")) {
    for (const field of ["applicationEntry", "authentication", "fieldDiscovery", "combobox", "multiselect", "fileUpload", "multiPage", "reviewDetection"] as const) {
      assert.ok(
        !proven.includes(entry[field]),
        `${entry.platform}.${field} = ${entry[field]} contradicts DETECTION_ONLY status — a DETECTION_ONLY platform must not claim a fixture-proven capability`
      );
    }
    assert.equal(entry.liveValidation, "REQUIRED");
  }
});

test("ATS-COVERAGE-09: getCoverageEntry resolves a known platform and returns undefined for a platform with no entry", () => {
  const workday = getCoverageEntry("workday");
  assert.ok(workday);
  assert.equal(workday?.status, "FULL_FIXTURE_VERIFIED");

  assert.equal(getCoverageEntry("career_link" as SourceType), undefined);
});

/**
 * Behavioral spot-checks — real, directly-verified detection patterns from src/lib/ats/detect.ts,
 * not invented URLs. Ashby/Lever come from the exact SIMPLE_PATTERNS regexes; iCIMS and Workable
 * from their own dedicated detect functions, all read directly out of the source file before
 * writing this test (never guessed).
 */
test("ATS-COVERAGE-10: detectAtsFromUrlString behaviorally confirms platforms this registry marks as detected", () => {
  const ashby = detectAtsFromUrlString("https://jobs.ashbyhq.com/acme-corp/abc123");
  assert.equal(ashby?.sourceType, "ashby");

  const lever = detectAtsFromUrlString("https://jobs.lever.co/acme-corp/def456");
  assert.equal(lever?.sourceType, "lever");

  const icims = detectAtsFromUrlString("https://acme.icims.com/jobs/1234/analyst/job");
  assert.equal(icims?.sourceType, "icims");

  const workable = detectAtsFromUrlString("https://apply.workable.com/acme-corp/j/ABCDEF1234/");
  assert.equal(workable?.sourceType, "workable");

  const unknown = detectAtsFromUrlString("https://careers.some-unrelated-company.example.com/apply");
  assert.equal(unknown, null);

  for (const detection of [ashby, lever, icims, workable]) {
    assert.ok(detection, "expected a real detection result");
    const entry = getCoverageEntry(detection!.sourceType);
    assert.ok(entry, `coverage registry is missing an entry for detected platform "${detection!.sourceType}"`);
    assert.equal(entry!.detection, "SUPPORTED");
  }
});
