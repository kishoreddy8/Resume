import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/**
 * Connector Reliability Final Hardening — scan-level regression coverage for the per-job content-
 * failure resilience fix (see jobContentFailure.ts and the individual adapter changes). Uses the
 * exact same globalThis.fetch stubbing technique as affectedJobDedupeKeys.test.ts, targeting Oracle
 * Recruiting Cloud (explicitly named in the mission, and the provider with real production
 * evidence — Bristlecone, Inc., job 22367). Real (temp, isolated) SQLite DB via
 * CAREER_OPS_DB_PATH.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let getCompany: typeof import("@/db/queries/companies").getCompany;
let runScan: typeof import("@/lib/scan").runScan;
let listRediscoveryEligibleCompanies: typeof import("@/db/queries/reliability").listRediscoveryEligibleCompanies;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-description-resilience-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("@/db"));
  ({ createCompany, getCompany } = await import("@/db/queries/companies"));
  ({ runScan } = await import("@/lib/scan"));
  ({ listRediscoveryEligibleCompanies } = await import("@/db/queries/reliability"));

  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
async function withRestoredFetch<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

let companyCounter = 0;
function makeOracleCompany() {
  companyCounter++;
  return createCompany({
    name: `Oracle Resilience Test Co ${companyCounter}`,
    source_type: "oracle_recruiting_cloud",
    ats_board_token: `oracle-host-${companyCounter}.fa.us2.oraclecloud.com|CX_${companyCounter}`,
  });
}

interface OracleListingFixture {
  Id: string;
  Title: string;
  PrimaryLocation: string;
  PrimaryLocationCountry: string;
}

/** Serves a fixed listing (all US) and per-job details — a configurable subset of which come back
 *  with NO description content, matching the real "job N has no full description" evidence. Any
 *  id in `missingDescriptionIds` gets a detail response with an empty ExternalDescriptionStr. */
function stubOracle(listings: OracleListingFixture[], missingDescriptionIds: Set<string> = new Set()) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/recruitingCEJobRequisitions")) {
      return new Response(
        JSON.stringify({ items: [{ Offset: 0, Limit: 25, TotalJobsCount: listings.length, requisitionList: listings }], count: 1, hasMore: false }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.pathname.endsWith("/recruitingCEJobRequisitionDetails")) {
      const id = url.searchParams.get("finder")?.match(/Id=([^,]+)/)?.[1] ?? "";
      const listing = listings.find((l) => l.Id === id);
      const hasDescription = !missingDescriptionIds.has(id);
      return new Response(
        JSON.stringify({
          items: [
            {
              ...listing,
              ExternalDescriptionStr: hasDescription ? "<p>Complete role description text.</p>" : "",
              ExternalPostedStartDate: "2026-08-01T00:00:00+00:00",
              WorkplaceType: "Remote",
            },
          ],
          count: 1,
          hasMore: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

function oracleListing(id: string, title: string): OracleListingFixture {
  return { Id: id, Title: title, PrimaryLocation: "Austin, TX", PrimaryLocationCountry: "US" };
}

function activeJobsForCompany(companyId: number): { title: string; description_text: string | null }[] {
  return getDb()
    .prepare(`SELECT title, description_text FROM jobs WHERE company_id = ? AND is_active = 1`)
    .all(companyId) as { title: string; description_text: string | null }[];
}

test("1/2/3. one (or several) malformed/missing-description jobs do not abort the company scan — valid siblings still ingest normally", async () => {
  await withRestoredFetch(async () => {
    const company = makeOracleCompany();
    const listings = [oracleListing("1", "Data Engineer"), oracleListing("2", "Bad Job A"), oracleListing("3", "Product Manager"), oracleListing("4", "Bad Job B")];
    stubOracle(listings, new Set(["2", "4"]));

    const summary = await runScan([company]);
    assert.equal(summary.errors, 0, "the scan must not fail/throw over per-job content gaps");
    assert.equal(summary.results[0].status, "ok");

    const jobs = activeJobsForCompany(company.id);
    assert.equal(jobs.length, 4, "all 4 jobs must still be ingested, including the 2 with missing descriptions");
    const good = jobs.filter((j) => j.title === "Data Engineer" || j.title === "Product Manager");
    assert.equal(good.length, 2);
    assert.ok(good.every((j) => j.description_text && j.description_text.length > 0));
    const bad = jobs.filter((j) => j.title.startsWith("Bad Job"));
    assert.equal(bad.length, 2);
    assert.ok(bad.every((j) => !j.description_text));
  });
});

test("4. the description failure is counted/reported on the scan_run", async () => {
  await withRestoredFetch(async () => {
    const company = makeOracleCompany();
    const listings = [oracleListing("1", "Data Engineer"), oracleListing("2", "Bad Job")];
    stubOracle(listings, new Set(["2"]));
    await runScan([company]);
    const run = getDb().prepare(`SELECT description_failures FROM scan_runs WHERE company_id = ? ORDER BY id DESC LIMIT 1`).get(company.id) as { description_failures: number };
    assert.equal(run.description_failures, 1);
  });
});

test("5. a PARTIAL (not fully-failed) description gap keeps connector_health out of 'down' — it stays healthy since not every job failed", async () => {
  await withRestoredFetch(async () => {
    const company = makeOracleCompany();
    const listings = [oracleListing("1", "Data Engineer"), oracleListing("2", "Bad Job")];
    stubOracle(listings, new Set(["2"]));
    await runScan([company]);
    const after = getCompany(company.id)!;
    assert.equal(after.connector_health, "healthy");
    assert.equal(after.consecutive_failures, 0);
  });
});

test("6. ALL detail jobs failing (every description missing) does NOT become a false HEALTHY with zero jobs — it stays distinguishable as a partial/degraded connector state, not silently healthy-empty", async () => {
  await withRestoredFetch(async () => {
    const company = makeOracleCompany();
    const listings = [oracleListing("1", "Bad Job A"), oracleListing("2", "Bad Job B")];
    stubOracle(listings, new Set(["1", "2"]));
    const summary = await runScan([company]);
    assert.equal(summary.errors, 0, "this must not throw/error — it's a partial data-quality outcome, not a connector fetch failure");
    const run = getDb().prepare(`SELECT status, description_failures, jobs_discovered FROM scan_runs WHERE company_id = ? ORDER BY id DESC LIMIT 1`).get(company.id) as { status: string; description_failures: number; jobs_discovered: number };
    assert.equal(run.status, "partial");
    assert.equal(run.description_failures, 2);
    assert.equal(run.jobs_discovered, 2);
    const after = getCompany(company.id)!;
    assert.equal(after.connector_health, "degraded", "a total description failure must not be reported as a clean healthy scan");
    // Distinguishable from a genuine HEALTHY_EMPTY board (see reliability/state.ts) — this board
    // reported 2 real jobs, just with no usable description content, never zero jobs.
    const jobs = activeJobsForCompany(company.id);
    assert.equal(jobs.length, 2);
  });
});

test("7. a true board-level failure (malformed listing response) still fails the company scan", async () => {
  await withRestoredFetch(async () => {
    const company = makeOracleCompany();
    globalThis.fetch = (async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const summary = await runScan([company]);
    assert.equal(summary.errors, 1);
    const after = getCompany(company.id)!;
    assert.equal(after.connector_health, "degraded");
    assert.equal(after.last_error_category, "unknown");
  });
});

test("9. a description-only degrade never makes the company Discovery-V2/rediscovery-eligible (no error category is ever set for a partial-description scan)", async () => {
  await withRestoredFetch(async () => {
    const company = makeOracleCompany();
    const listings = [oracleListing("1", "Bad Job")];
    stubOracle(listings, new Set(["1"]));
    await runScan([company]);
    const after = getCompany(company.id)!;
    assert.equal(after.last_error_category, null);
    const eligible = listRediscoveryEligibleCompanies(25, 0);
    assert.equal(eligible.some((e) => e.company.id === company.id), false);
  });
});

test("12. company A's malformed job cannot affect company B's scan result", async () => {
  await withRestoredFetch(async () => {
    const companyA = makeOracleCompany();
    const companyB = makeOracleCompany();

    // Company A: one bad job. Company B: all good jobs. Route each host to its own fixture and run
    // both through the SAME scan batch.
    stubOracle([oracleListing("1", "Bad Job")], new Set(["1"]));
    const stubA = globalThis.fetch;
    stubOracle([oracleListing("1", "Good Job")], new Set());
    const stubB = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const fn = url.hostname.startsWith(`oracle-host-${companyA.id}.`) ? stubA : stubB;
      return fn(input as never);
    }) as typeof fetch;

    const summary = await runScan([companyA, companyB]);
    assert.equal(summary.errors, 0);
    const jobsA = activeJobsForCompany(companyA.id);
    const jobsB = activeJobsForCompany(companyB.id);
    assert.equal(jobsA.length, 1);
    assert.ok(!jobsA[0].description_text);
    assert.equal(jobsB.length, 1);
    assert.ok(jobsB[0].description_text && jobsB[0].description_text.length > 0);
  });
});
