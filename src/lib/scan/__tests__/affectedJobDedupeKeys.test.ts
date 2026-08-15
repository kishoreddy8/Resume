import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/**
 * Phase 4 Stage 2 — "affected job" detection tests: ScanResult/ScanSummary.affectedJobDedupeKeys
 * must contain exactly the jobs newly inserted or materially changed (per the EXISTING
 * hasContentChanged comparator, reused unmodified — see src/lib/scan/status.ts), and exclude
 * everything else. Real (temp, isolated) SQLite DB via CAREER_OPS_DB_PATH, same pattern as
 * src/db/queries/__tests__/scanReliability.test.ts. globalThis.fetch is stubbed to return
 * Greenhouse-shaped JSON — no real network, no real ATS host — mirroring the exact stubbing
 * technique already used for runScan() in src/db/queries/__tests__/settings.test.ts.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let runScan: typeof import("@/lib/scan").runScan;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-affected-jobs-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("@/db"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ runScan } = await import("@/lib/scan"));

  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

let companyCounter = 0;
function makeCompany() {
  companyCounter++;
  return createCompany({
    name: `Affected Jobs Test Co ${companyCounter}`,
    source_type: "greenhouse",
    ats_board_token: `affected-jobs-token-${companyCounter}`,
  });
}

interface GreenhouseFixtureJob {
  id: number | string;
  title: string;
  location?: string;
  content?: string;
  updated_at?: string;
  absolute_url?: string;
}

function greenhouseJob(overrides: Partial<GreenhouseFixtureJob> & { id: number | string; title: string }): GreenhouseFixtureJob {
  return {
    location: "Austin, TX",
    content: "<p>Default job description content.</p>",
    // Dynamic (not hardcoded) so this fixture never drifts into "stale" as real time passes — the
    // 20-day freshness gate (src/lib/ats/jobFreshness.ts) compares against the real system clock.
    updated_at: new Date().toISOString(),
    absolute_url: `https://boards.greenhouse.io/co/jobs/${overrides.id}`,
    ...overrides,
  };
}

function stubGreenhouseResponse(jobs: GreenhouseFixtureJob[]) {
  const body = {
    jobs: jobs.map((j) => ({
      id: j.id,
      title: j.title,
      location: j.location ? { name: j.location } : null,
      departments: [{ name: "Engineering" }],
      absolute_url: j.absolute_url,
      content: j.content,
      updated_at: j.updated_at,
    })),
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

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

test("61. a newly inserted job is included in affectedJobDedupeKeys", async () => {
  await withRestoredFetch(async () => {
    const company = makeCompany();
    stubGreenhouseResponse([greenhouseJob({ id: 1, title: "Data Engineer" })]);
    const summary = await runScan([company]);
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "1");
    assert.ok(summary.affectedJobDedupeKeys.includes(dedupeKey));
    assert.equal(summary.results[0].affectedJobDedupeKeys.length, 1);
  });
});

test("62. an unchanged re-seen job (identical content) is excluded from affectedJobDedupeKeys", async () => {
  await withRestoredFetch(async () => {
    const company = makeCompany();
    const fixture = greenhouseJob({ id: 2, title: "Backend Engineer" });
    stubGreenhouseResponse([fixture]); // first scan: inserted
    await runScan([company]);

    stubGreenhouseResponse([fixture]); // second scan: byte-identical re-seen
    const summary = await runScan([company]);
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "2");
    assert.ok(!summary.affectedJobDedupeKeys.includes(dedupeKey));
  });
});

test("63. only last_seen_at changing (content byte-identical) is excluded, even though the DB row's last_seen_at column does change", async () => {
  await withRestoredFetch(async () => {
    const company = makeCompany();
    const fixture = greenhouseJob({ id: 3, title: "Platform Engineer" });
    stubGreenhouseResponse([fixture]);
    await runScan([company]);
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "3");
    const firstSeenAt = getJobByDedupeKey(dedupeKey)!.last_seen_at;

    await new Promise((resolve) => setTimeout(resolve, 1100)); // ensure a distinguishable datetime('now') tick
    stubGreenhouseResponse([fixture]);
    const summary = await runScan([company]);

    const updatedRow = getJobByDedupeKey(dedupeKey)!;
    assert.notEqual(updatedRow.last_seen_at, firstSeenAt, "last_seen_at itself DOES change on every re-seen scan");
    assert.ok(!summary.affectedJobDedupeKeys.includes(dedupeKey), "but that alone must not mark the job affected");
  });
});

test("64. a description change on an existing job is included in affectedJobDedupeKeys", async () => {
  await withRestoredFetch(async () => {
    const company = makeCompany();
    stubGreenhouseResponse([greenhouseJob({ id: 4, title: "Data Engineer", content: "<p>Original description.</p>" })]);
    await runScan([company]);

    stubGreenhouseResponse([greenhouseJob({ id: 4, title: "Data Engineer", content: "<p>Materially different description.</p>" })]);
    const summary = await runScan([company]);
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "4");
    assert.ok(summary.affectedJobDedupeKeys.includes(dedupeKey));
  });
});

test("65. a title change on an existing job is included in affectedJobDedupeKeys", async () => {
  await withRestoredFetch(async () => {
    const company = makeCompany();
    stubGreenhouseResponse([greenhouseJob({ id: 5, title: "Software Engineer I" })]);
    await runScan([company]);

    stubGreenhouseResponse([greenhouseJob({ id: 5, title: "Software Engineer II" })]);
    const summary = await runScan([company]);
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "5");
    assert.ok(summary.affectedJobDedupeKeys.includes(dedupeKey));
  });
});

test("66. a location change on an existing job is included in affectedJobDedupeKeys", async () => {
  await withRestoredFetch(async () => {
    const company = makeCompany();
    stubGreenhouseResponse([greenhouseJob({ id: 6, title: "Data Engineer", location: "Austin, TX" })]);
    await runScan([company]);

    stubGreenhouseResponse([greenhouseJob({ id: 6, title: "Data Engineer", location: "Denver, CO" })]);
    const summary = await runScan([company]);
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "6");
    assert.ok(summary.affectedJobDedupeKeys.includes(dedupeKey));
  });
});

test("67. a foreign-filtered job (non-US location) never appears in affectedJobDedupeKeys", async () => {
  await withRestoredFetch(async () => {
    const company = makeCompany();
    stubGreenhouseResponse([greenhouseJob({ id: 7, title: "Data Engineer", location: "London, United Kingdom" })]);
    const summary = await runScan([company]);
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "7");
    assert.ok(!summary.affectedJobDedupeKeys.includes(dedupeKey));
    assert.equal(getJobByDedupeKey(dedupeKey), undefined, "a foreign-filtered job is never persisted at all");
  });
});

test("68. a pseudo-job (talent-community style title) never appears in affectedJobDedupeKeys", async () => {
  await withRestoredFetch(async () => {
    const company = makeCompany();
    stubGreenhouseResponse([greenhouseJob({ id: 8, title: "Join Our Talent Community" })]);
    const summary = await runScan([company]);
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "8");
    assert.ok(!summary.affectedJobDedupeKeys.includes(dedupeKey));
    assert.equal(getJobByDedupeKey(dedupeKey), undefined, "a pseudo-job is never persisted at all");
  });
});

test("69. a stale-rejected job (no prior DB row, posted well outside the freshness window) never appears in affectedJobDedupeKeys", async () => {
  await withRestoredFetch(async () => {
    const company = makeCompany();
    const staleDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days ago
    stubGreenhouseResponse([greenhouseJob({ id: 9, title: "Data Engineer", updated_at: staleDate })]);
    const summary = await runScan([company]);
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "9");
    assert.ok(!summary.affectedJobDedupeKeys.includes(dedupeKey));
    assert.equal(getJobByDedupeKey(dedupeKey), undefined, "a stale-rejected job is never persisted at all");
  });
});

test("70. the same dedupe key appearing twice in one company's job list within one scan appears only once in affectedJobDedupeKeys", async () => {
  await withRestoredFetch(async () => {
    const company = makeCompany();
    stubGreenhouseResponse([
      greenhouseJob({ id: 10, title: "Data Engineer" }),
      greenhouseJob({ id: 10, title: "Data Engineer" }), // duplicate listing, same external id
    ]);
    const summary = await runScan([company]);
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "10");
    const occurrences = summary.affectedJobDedupeKeys.filter((k) => k === dedupeKey).length;
    assert.equal(occurrences, 1);
  });
});

test("94. a partially-successful runScan() (one company fails, one succeeds) only includes affected jobs from the successful company", async () => {
  await withRestoredFetch(async () => {
    const goodCompany = makeCompany();
    const badCompany = makeCompany();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(String(badCompany.ats_board_token))) {
        return new Response("Internal Server Error", { status: 500 });
      }
      const body = {
        jobs: [
          {
            id: 42,
            title: "Data Engineer",
            location: { name: "Austin, TX" },
            departments: [{ name: "Engineering" }],
            absolute_url: "https://boards.greenhouse.io/co/jobs/42",
            content: "<p>desc</p>",
            updated_at: new Date().toISOString(),
          },
        ],
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const summary = await runScan([goodCompany, badCompany]);
    assert.equal(summary.errors, 1, "the bad company's scan must be recorded as an error");

    const goodResult = summary.results.find((r) => r.companyId === goodCompany.id)!;
    const badResult = summary.results.find((r) => r.companyId === badCompany.id)!;
    assert.equal(goodResult.status, "ok");
    assert.equal(badResult.status, "error");
    assert.equal(badResult.affectedJobDedupeKeys.length, 0, "a failed company contributes zero affected jobs");

    const goodDedupeKey = dedupeKeyForAts("greenhouse", goodCompany.id, "42");
    assert.ok(summary.affectedJobDedupeKeys.includes(goodDedupeKey));
    assert.equal(summary.affectedJobDedupeKeys.length, 1, "only the successful company's admitted job is affected");
  });
});

test("71. a suppressed job (previously marked Not Interested) is never re-added to affectedJobDedupeKeys", async () => {
  await withRestoredFetch(async () => {
    const { markNotInterested } = await import("@/db/queries/jobs");
    const company = makeCompany();
    const fixture = greenhouseJob({ id: 11, title: "Data Engineer" });
    stubGreenhouseResponse([fixture]);
    await runScan([company]); // inserted
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "11");
    const job = getJobByDedupeKey(dedupeKey)!;
    markNotInterested(job.id);
    assert.equal(getJobByDedupeKey(dedupeKey), undefined, "Not Interested deletes the row and suppresses the identity");

    stubGreenhouseResponse([fixture]); // reappears in the next scan
    const summary = await runScan([company]);
    assert.ok(!summary.affectedJobDedupeKeys.includes(dedupeKey), "a suppressed outcome must never be treated as affected");
  });
});
