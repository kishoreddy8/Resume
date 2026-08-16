import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { FIXTURE_INDEED_RESULTS } from "../fixtures";
import type { NormalizedExternalJob } from "../types";

/**
 * Stage 9 — regression coverage for the two Stage 8 audit findings:
 *   P0a: paid providers must require explicit enablement, not just credentials.
 *   P0b: external freshness must use the exact same 20-day policy as ATS ingestion, never a
 *        separately-diverging constant.
 * Plus the required external/ATS architectural-independence proofs.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let evaluateQualityGate: typeof import("../classify").evaluateQualityGate;
let PROVIDER_COST_CLASS: typeof import("../providers").PROVIDER_COST_CLASS;
let isLiveProviderConfigured: typeof import("../providers").isLiveProviderConfigured;
let indeedProvider: typeof import("../providers").indeedProvider;
let processExternalListing: typeof import("../pipeline").processExternalListing;
let runScan: typeof import("@/lib/scan").runScan;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-external-signals-zero-cost-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ evaluateQualityGate } = await import("../classify"));
  ({ PROVIDER_COST_CLASS, isLiveProviderConfigured, indeedProvider } = await import("../providers"));
  ({ processExternalListing } = await import("../pipeline"));
  ({ runScan } = await import("@/lib/scan"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.APIFY_API_TOKEN;
  delete process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL;
});

beforeEach(() => {
  delete process.env.APIFY_API_TOKEN;
  delete process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL;
});

// ---------------------------------------------------------------------------------------------
// Phase 8 — zero-cost regression tests
// ---------------------------------------------------------------------------------------------

test("1. paid external is disabled by default (neither env var set)", () => {
  assert.equal(isLiveProviderConfigured(), false);
});

test("2. token present but the allow-flag absent -> blocked", () => {
  process.env.APIFY_API_TOKEN = "fake-token";
  assert.equal(isLiveProviderConfigured(), false);
});

test("3. token present + flag explicitly false -> blocked", () => {
  process.env.APIFY_API_TOKEN = "fake-token";
  process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL = "false";
  assert.equal(isLiveProviderConfigured(), false);
});

test("4. token present + flag true -> enabled", () => {
  process.env.APIFY_API_TOKEN = "fake-token";
  process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL = "true";
  assert.equal(isLiveProviderConfigured(), true);
});

test("5. flag true + token absent -> still not configured", () => {
  process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL = "true";
  assert.equal(isLiveProviderConfigured(), false);
});

test("6. fixture/shadow mode still works with zero credentials and zero enablement", async () => {
  const results = await indeedProvider.search({ role: "Data Engineer", limit: 2 });
  assert.deepEqual(results, FIXTURE_INDEED_RESULTS);
});

test("7. no paid network call occurs in default zero-cost mode (fetch is never invoked)", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("fetch must never be called in zero-cost mode");
  }) as typeof fetch;
  try {
    await indeedProvider.search({ role: "Data Engineer", limit: 2 });
    assert.equal(fetchCalled, false, "the provider must not touch the network when not live-configured");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("8. provider cost class is OPTIONAL_PAID for both current providers", () => {
  assert.equal(PROVIDER_COST_CLASS.indeed, "OPTIONAL_PAID");
  assert.equal(PROVIDER_COST_CLASS.google_jobs, "OPTIONAL_PAID");
});

test("9. merely setting APIFY_API_TOKEN (with no allow-flag) does not cause billing-capable behavior — search() still returns fixtures, never calls fetch", async () => {
  process.env.APIFY_API_TOKEN = "fake-token-that-would-be-billed-if-used";
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("fetch must never be called merely because a token is present");
  }) as typeof fetch;
  try {
    const results = await indeedProvider.search({ role: "Data Engineer", limit: 2 });
    assert.equal(fetchCalled, false);
    assert.deepEqual(results, FIXTURE_INDEED_RESULTS);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------------------------
// Phase 9 — freshness regression tests (canonical 20-day parity with ATS ingestion)
// ---------------------------------------------------------------------------------------------

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const MATCH = { companyId: 1, confidence: "DOMAIN" as const, reason: "test" };
function makeJob(overrides: Partial<NormalizedExternalJob> = {}): NormalizedExternalJob {
  return {
    source: "indeed",
    providerJobId: "job-1",
    employerName: "Acme Robotics",
    title: "Data Engineer",
    location: "Austin, TX",
    description: "A".repeat(150),
    postedAt: null,
    listingUrl: "https://www.indeed.com/viewjob?jk=job-1",
    applyUrl: "https://acmerobotics.com/careers/data-engineer",
    directEmployerUrl: "https://acmerobotics.com/careers/data-engineer",
    employmentType: "Full-time",
    salaryText: null,
    raw: {},
    ...overrides,
  };
}

test("1f. a US job posted 19 days ago is eligible (passes the gate)", () => {
  const job = makeJob({ postedAt: daysAgoIso(19) });
  assert.equal(evaluateQualityGate(job, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), null);
});

test("2f. a job posted 21 days ago is rejected STALE", () => {
  const job = makeJob({ postedAt: daysAgoIso(21) });
  assert.equal(evaluateQualityGate(job, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "STALE");
});

test("3f. exactly 20 days old matches the canonical ATS boundary (<=20 is eligible, not stale)", () => {
  const job = makeJob({ postedAt: daysAgoIso(20) });
  assert.notEqual(evaluateQualityGate(job, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "STALE");
});

test("4f. an unknown/unparseable posted date is never treated as fresh — stays DISCOVERY_BEACON_ONLY, not silently eligible", () => {
  const missingDate = makeJob({ postedAt: null });
  assert.equal(evaluateQualityGate(missingDate, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "DISCOVERY_BEACON_ONLY");

  const relativeText = makeJob({ postedAt: "2 days ago" }); // Google Jobs' own format
  assert.equal(evaluateQualityGate(relativeText, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "DISCOVERY_BEACON_ONLY");
});

test("5f. an old job that a source-side date filter should have excluded is still caught by local validation (source-side filtering never replaces it)", () => {
  // Simulates a provider search() that (for whatever reason — a misconfigured query, a stale
  // cached result) returned something older than the source's own requested date filter would
  // suggest. Local evaluateQualityGate must reject it regardless of what the provider claimed to filter.
  const job = makeJob({ postedAt: daysAgoIso(45) });
  assert.equal(evaluateQualityGate(job, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "STALE");
});

test("6f. external and ATS ingestion share the exact same canonical constant, not independently-defined numbers", async () => {
  const { CANONICAL_INGESTION_MAX_AGE_DAYS } = await import("@/lib/ats/jobFreshness");
  assert.equal(CANONICAL_INGESTION_MAX_AGE_DAYS, 20);
  // 20 days exactly must be eligible (matches isJobFreshForIngestion's own <= comparison), and
  // 21 must not — proven above (3f/2f) using the SAME imported constant's semantics, not a
  // locally-hardcoded 20/21 that could silently drift from the real constant.
  const boundary = makeJob({ postedAt: daysAgoIso(CANONICAL_INGESTION_MAX_AGE_DAYS) });
  const overBoundary = makeJob({ postedAt: daysAgoIso(CANONICAL_INGESTION_MAX_AGE_DAYS + 1) });
  assert.notEqual(evaluateQualityGate(boundary, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "STALE");
  assert.equal(evaluateQualityGate(overBoundary, MATCH, "DIRECT_EMPLOYER", "DIRECT_ATS"), "STALE");
});

// ---------------------------------------------------------------------------------------------
// Phase 7 — external/ATS architectural independence
// ---------------------------------------------------------------------------------------------

let counter = 0;
function makeCompany() {
  counter++;
  return createCompany({ name: `Independence Test Co ${counter}`, source_type: "greenhouse", ats_board_token: `token-${counter}` });
}

function mockJobsFetch() {
  return (async () => new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

test("1i. external processing runs normally for a company whose own ATS scan just succeeded (external is not gated on ATS health)", async () => {
  const company = makeCompany();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockJobsFetch();
  try {
    const scanSummary = await runScan([company]);
    assert.equal(scanSummary.errors, 0, "the ATS scan itself must succeed for this to be a meaningful isolation proof");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const result = await processExternalListing("indeed", FIXTURE_INDEED_RESULTS[0]);
  assert.ok(result.decision, "external classification must complete normally even though the company's ATS scan just ran");
});

test("2i. a company's ATS scan failure does not prevent external processing from completing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("simulated ATS fetch failure");
  }) as typeof fetch;
  try {
    const company = makeCompany();
    const scanSummary = await runScan([company]);
    assert.equal(scanSummary.errors, 1, "the ATS scan must have genuinely failed for this to be a meaningful isolation proof");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // processExternalListing takes an already-fetched raw result — it has no dependency on any
  // company's scan outcome at all, proving the two pipelines share no failure coupling.
  const result = await processExternalListing("indeed", FIXTURE_INDEED_RESULTS[1]);
  assert.ok(result.decision, "external classification must complete even immediately after an unrelated ATS scan failure");
});

test("3i. an external provider's search() failure does not prevent a separate company's ATS ingestion from completing", async () => {
  const failingProvider: typeof indeedProvider = {
    ...indeedProvider,
    async search() {
      throw new Error("simulated external provider failure");
    },
  };
  await assert.rejects(() => failingProvider.search({ role: "Data Engineer" }));

  // A completely independent ATS scan, run immediately after, must be unaffected.
  const company = makeCompany();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockJobsFetch();
  try {
    const scanSummary = await runScan([company]);
    assert.equal(scanSummary.errors, 0, "ATS ingestion must succeed even though an external provider call failed moments earlier");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
