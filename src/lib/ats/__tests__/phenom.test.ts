import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  canonicalPhenomUrl,
  encodePhenomToken,
  fetchPhenomJobs,
  normalizePhenomToken,
  parsePhenomListingPage,
  parsePhenomToken,
} from "@/lib/ats/phenom";

test("Phenom token parsing, encoding, and canonical URL generation", () => {
  assert.equal(
    normalizePhenomToken("careers.gehealthcare.com|global/en"),
    "careers.gehealthcare.com|global/en"
  );
  assert.equal(
    normalizePhenomToken("CAREERS.MARS.COM|us/en"),
    "careers.mars.com|us/en"
  );
  assert.equal(
    normalizePhenomToken("jobs.danaher.com"),
    "jobs.danaher.com|global/en"
  );
  assert.equal(
    canonicalPhenomUrl("careers.gehealthcare.com|global/en"),
    "https://careers.gehealthcare.com/global/en/search-results"
  );

  const parsed = parsePhenomToken("careers.bose.com|us/en");
  assert.equal(parsed.host, "careers.bose.com");
  assert.equal(parsed.locale, "us/en");

  const encoded = encodePhenomToken(parsed);
  assert.equal(encoded, "careers.bose.com|us/en");
  assert.equal(encodePhenomToken({ host: "careers.conmed.com", locale: "" }), "careers.conmed.com|");

  assert.throws(() => parsePhenomToken("invalid_host!|us/en"), /Invalid Phenom host/);
  assert.throws(() => parsePhenomToken("careers.example.com|invalid locale!"), /Invalid Phenom locale/);
  assert.throws(() => encodePhenomToken({ host: "invalid_host!" }), /Invalid Phenom host/);
  assert.throws(() => encodePhenomToken({ host: "careers.example.com", locale: "invalid locale!" }), /Invalid Phenom locale/);
});

test("parsePhenomListingPage validates numeric totalHits and structured jobs", () => {
  const validDdo = {
    eagerLoadRefineSearch: {
      totalHits: 2,
      data: {
        jobs: [
          { jobId: "REQ-1", jobSeqNo: "SEQ-1", title: "Software Engineer", location: "Boston, MA, US" },
          { jobId: "REQ-2", jobSeqNo: "SEQ-2", title: "Product Manager", location: "New York, NY, US" },
        ],
      },
    },
  };

  const parsed = parsePhenomListingPage(validDdo);
  assert.equal(parsed.totalHits, 2);
  assert.equal(parsed.jobs.length, 2);
  assert.equal(parsed.jobs[0].jobId, "REQ-1");
  assert.equal(parsed.jobs[0].jobSeqNo, "SEQ-1");

  assert.throws(
    () => parsePhenomListingPage({ eagerLoadRefineSearch: { totalHits: "two" } }),
    /missing valid numeric totalHits/
  );
});

test("fetchPhenomJobs: successful multi-page snapshot with detail retrieval and location filtering", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/global/en/search-results") {
      const from = Number(url.searchParams.get("from") ?? "0");
      if (from === 0) {
        res.writeHead(200, { "Content-Type": "text/html" });
        const ddo = {
          eagerLoadRefineSearch: {
            totalHits: 3,
            data: {
              jobs: [
                { jobId: "JOB-1", jobSeqNo: "SEQ-1", title: "US Backend Lead", city: "Chicago", state: "IL", country: "United States", postedDate: "2026-08-01T00:00:00Z" },
                { jobId: "JOB-2", jobSeqNo: "SEQ-2", title: "US Frontend Engineer", city: "Austin", state: "TX", country: "US", postedDate: "2026-08-02T00:00:00Z" },
              ]
            }
          }
        };
        res.end(`<html><script>phApp.ddo = ${JSON.stringify(ddo)};</script></html>`);
        return;
      }
      if (from === 2) {
        res.writeHead(200, { "Content-Type": "text/html" });
        const ddo = {
          eagerLoadRefineSearch: {
            totalHits: 3,
            data: {
              jobs: [
                { jobId: "JOB-3", jobSeqNo: "SEQ-3", title: "EU Data Analyst", city: "Berlin", country: "Germany", postedDate: "2026-08-03T00:00:00Z" },
              ]
            }
          }
        };
        res.end(`<html><script>phApp.ddo = ${JSON.stringify(ddo)};</script></html>`);
        return;
      }
    }

    if (url.pathname.startsWith("/global/en/job/")) {
      const seqNo = url.pathname.split("/").pop();
      res.writeHead(200, { "Content-Type": "text/html" });
      const ddo = {
        jobDetail: {
          data: {
            job: {
              jobId: seqNo,
              jobSeqNo: seqNo,
              title: `Detail for ${seqNo}`,
              description: `<p>Full job description for ${seqNo}.</p>`,
              postedDate: "2026-08-01T00:00:00Z"
            }
          }
        }
      };
      res.end(`<html><script>phApp.ddo = ${JSON.stringify(ddo)};</script></html>`);
      return;
    }

    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  try {
    // US-only filter: should return exactly 2 US jobs out of 3 total
    const usJobs = await fetchPhenomJobs("careers.example.com|global/en", {
      originOverride: origin,
      allowPrivateNetworksForTests: true,
      usOnly: true,
      maxAttempts: 1,
    });

    assert.equal(usJobs.length, 2);
    assert.equal(usJobs[0].externalId, "JOB-1");
    assert.equal(usJobs[0].location, "Chicago, IL, United States");
    assert.ok(usJobs[0].descriptionText?.includes("Full job description for SEQ-1"));
    assert.equal(usJobs[1].externalId, "JOB-2");

    // Non-US filter (all jobs): should return all 3
    const allJobs = await fetchPhenomJobs("careers.example.com|global/en", {
      originOverride: origin,
      allowPrivateNetworksForTests: true,
      usOnly: false,
      maxAttempts: 1,
    });

    assert.equal(allJobs.length, 3);
    assert.equal(allJobs[2].externalId, "JOB-3");
  } finally {
    server.close();
  }
});

test("fetchPhenomJobs: fail-closed on duplicate requisition IDs within page", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    const ddo = {
      eagerLoadRefineSearch: {
        totalHits: 2,
        data: {
          jobs: [
            { jobId: "DUP-1", jobSeqNo: "DUP-1", title: "Job 1" },
            { jobId: "DUP-1", jobSeqNo: "DUP-1", title: "Job 2" },
          ]
        }
      }
    };
    res.end(`<html><script>phApp.ddo = ${JSON.stringify(ddo)};</script></html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(
      () =>
        fetchPhenomJobs("careers.example.com|global/en", {
          originOverride: origin,
          allowPrivateNetworksForTests: true,
          maxAttempts: 1,
        }),
      /Duplicate requisition ID detected within page in Phenom snapshot/
    );
  } finally {
    server.close();
  }
});

test("fetchPhenomJobs: fail-closed on totalCount mutation across pages", async () => {
  let requestCount = 0;
  const server = http.createServer((_req, res) => {
    requestCount++;
    res.writeHead(200, { "Content-Type": "text/html" });
    const ddo = {
      eagerLoadRefineSearch: {
        totalHits: requestCount === 1 ? 5 : 3,
        data: {
          jobs: [
            { jobId: `J-${requestCount}`, jobSeqNo: `SEQ-${requestCount}`, title: `Job ${requestCount}` }
          ]
        }
      }
    };
    res.end(`<html><script>phApp.ddo = ${JSON.stringify(ddo)};</script></html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(
      () =>
        fetchPhenomJobs("careers.example.com|global/en", {
          originOverride: origin,
          allowPrivateNetworksForTests: true,
          maxAttempts: 1,
        }),
      /Phenom totalCount mutated during pagination/
    );
  } finally {
    server.close();
  }
});

test("fetchPhenomJobs: fail-closed on empty page before authoritative totalHits is reached", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    const ddo = {
      eagerLoadRefineSearch: {
        totalHits: 5,
        data: { jobs: [] }
      }
    };
    res.end(`<html><script>phApp.ddo = ${JSON.stringify(ddo)};</script></html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(
      () =>
        fetchPhenomJobs("careers.example.com|global/en", {
          originOverride: origin,
          allowPrivateNetworksForTests: true,
          maxAttempts: 1,
        }),
      /Phenom pagination returned empty page 1 before reaching authoritative totalHits 5/
    );
  } finally {
    server.close();
  }
});

// ─── Phenom U.S.-Only Ingestion Characterization Tests ────────────────────────
//
// These tests prove that non-U.S. jobs cannot enter CareerOps production ingestion
// through any Phenom board locale, and that the U.S. filter derives eligibility
// solely from explicit job-location evidence — never from the board URL locale.

/**
 * Creates a deterministic Phenom test server with configurable job postings.
 * All jobs are returned on a single page with totalHits matching the array length.
 */
function createPhenomFixtureServer(postings: Array<{
  jobId: string; jobSeqNo: string; title: string;
  city?: string; state?: string; country?: string; location?: string;
}>): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname.includes("/search-results")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      const ddo = {
        eagerLoadRefineSearch: {
          totalHits: postings.length,
          data: { jobs: postings },
        },
      };
      res.end(`<html><script>phApp.ddo = ${JSON.stringify(ddo)};</script></html>`);
      return;
    }

    if (url.pathname.includes("/job/")) {
      // Return minimal detail page — enrichment not required for location tests
      res.writeHead(200, { "Content-Type": "text/html" });
      const seqNo = url.pathname.split("/").pop();
      const posting = postings.find((p) => p.jobSeqNo === seqNo);
      const ddo = {
        jobDetail: { data: { job: posting ?? { description: "No detail" } } },
      };
      res.end(`<html><script>phApp.ddo = ${JSON.stringify(ddo)};</script></html>`);
      return;
    }

    res.writeHead(404).end("Not found");
  });
}

async function withServer(
  postings: Parameters<typeof createPhenomFixtureServer>[0],
  fn: (origin: string) => Promise<void>
): Promise<void> {
  const server = createPhenomFixtureServer(postings);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

// ─── Test A: /global/en/ source + U.S. job → eligible ───────────────────────

test("Phenom US filter: /global/en/ source with explicit U.S. job → eligible", async () => {
  await withServer(
    [{ jobId: "US-1", jobSeqNo: "S1", title: "Engineer", city: "Dallas", state: "TX", country: "United States" }],
    async (origin) => {
      const jobs = await fetchPhenomJobs("careers.example.com|global/en", {
        originOverride: origin,
        allowPrivateNetworksForTests: true,
        usOnly: true,
        maxAttempts: 1,
      });
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].externalId, "US-1");
      assert.ok(jobs[0].location?.includes("TX"));
    }
  );
});

// ─── Test B: /global/en/ source + Germany job → filtered ─────────────────────

test("Phenom US filter: /global/en/ source with German job → filtered out", async () => {
  await withServer(
    [{ jobId: "DE-1", jobSeqNo: "S1", title: "Ingenieur", city: "Stuttgart", country: "Germany" }],
    async (origin) => {
      const jobs = await fetchPhenomJobs("careers.example.com|global/en", {
        originOverride: origin,
        allowPrivateNetworksForTests: true,
        usOnly: true,
        maxAttempts: 1,
      });
      assert.equal(jobs.length, 0, "German job must not appear when usOnly=true");
    }
  );
});

// ─── Test C: /us/en/ source + explicit foreign job → filtered ────────────────

test("Phenom US filter: /us/en/ source with explicit foreign job → filtered out", async () => {
  await withServer(
    [
      { jobId: "JP-1", jobSeqNo: "S1", title: "Engineer", city: "Chiba", country: "Japan" },
      { jobId: "IT-1", jobSeqNo: "S2", title: "Designer", city: "Milano", country: "Italy" },
      { jobId: "NL-1", jobSeqNo: "S3", title: "Analyst", city: "Eindhoven", country: "Netherlands" },
    ],
    async (origin) => {
      const jobs = await fetchPhenomJobs("careers.example.com|us/en", {
        originOverride: origin,
        allowPrivateNetworksForTests: true,
        usOnly: true,
        maxAttempts: 1,
      });
      assert.equal(jobs.length, 0, "Foreign jobs from a /us/en/ board must not appear");
    }
  );
});

// ─── Test D: /us/en/ source + U.S. job → eligible ───────────────────────────

test("Phenom US filter: /us/en/ source with explicit U.S. job → eligible", async () => {
  await withServer(
    [
      { jobId: "FL-1", jobSeqNo: "S1", title: "Machinist", city: "Largo", state: "Florida", country: "United States of America" },
      { jobId: "NJ-1", jobSeqNo: "S2", title: "VP Treasury", city: "Marlton", state: "New Jersey", country: "United States of America" },
    ],
    async (origin) => {
      const jobs = await fetchPhenomJobs("careers.example.com|us/en", {
        originOverride: origin,
        allowPrivateNetworksForTests: true,
        usOnly: true,
        maxAttempts: 1,
      });
      assert.equal(jobs.length, 2);
      assert.equal(jobs[0].externalId, "FL-1");
      assert.equal(jobs[1].externalId, "NJ-1");
    }
  );
});

// ─── Test E: "Remote, <US state>, USA" → handled correctly ──────────────────

test("Phenom US filter: 'Remote, Indiana' with explicit US evidence → eligible", async () => {
  await withServer(
    [
      { jobId: "RI-1", jobSeqNo: "S1", title: "Call Center Rep", location: "Remote, Indiana" },
      { jobId: "RU-1", jobSeqNo: "S2", title: "US Remote Worker", location: "Remote - United States" },
    ],
    async (origin) => {
      const jobs = await fetchPhenomJobs("careers.example.com|us/en", {
        originOverride: origin,
        allowPrivateNetworksForTests: true,
        usOnly: true,
        maxAttempts: 1,
      });
      assert.equal(jobs.length, 2, "Remote jobs with explicit U.S. evidence must be eligible");
    }
  );
});

// ─── Test F: Ambiguous "Remote" without U.S. evidence → UNKNOWN, not U.S. ──

test("Phenom US filter: bare 'Remote' without US evidence → filtered as UNKNOWN", async () => {
  const filteredScopes: string[] = [];
  await withServer(
    [{ jobId: "R-1", jobSeqNo: "S1", title: "Remote Worker", location: "Remote" }],
    async (origin) => {
      const jobs = await fetchPhenomJobs("careers.example.com|us/en", {
        originOverride: origin,
        allowPrivateNetworksForTests: true,
        usOnly: true,
        maxAttempts: 1,
        onLocationFiltered: (scope) => filteredScopes.push(scope),
      });
      assert.equal(jobs.length, 0, "Bare 'Remote' must not be treated as U.S.");
      assert.ok(filteredScopes.includes("UNKNOWN"), "Bare 'Remote' must be classified as UNKNOWN");
    }
  );
});

// ─── Test G: Mixed board → only U.S. postings survive ────────────────────────

test("Phenom US filter: mixed board with US, Germany, Japan → only US survives", async () => {
  const filteredScopes: string[] = [];
  await withServer(
    [
      { jobId: "US-TX", jobSeqNo: "S1", title: "CDL Driver", city: "Celina", state: "Texas", country: "United States" },
      { jobId: "US-FL", jobSeqNo: "S2", title: "PTA", city: "Dallas", state: "TX", country: "US" },
      { jobId: "US-TN", jobSeqNo: "S3", title: "Machine Op", city: "Cleveland", state: "Tennessee", country: "United States" },
      { jobId: "DE-1", jobSeqNo: "S4", title: "R&D Manager", city: "Bad Kreuznach", country: "Germany" },
      { jobId: "PL-1", jobSeqNo: "S5", title: "Pracownicy", city: "Stargard Szczecinski", country: "Poland" },
      { jobId: "JP-1", jobSeqNo: "S6", title: "Field Engineer", city: "Chiba", country: "Japan" },
      { jobId: "NL-1", jobSeqNo: "S7", title: "Magazijn", city: "Eindhoven", country: "Netherlands" },
      { jobId: "JP-2", jobSeqNo: "S8", title: "Field Engineer 2", city: "Aomori", country: "Japan" },
      { jobId: "CN-1", jobSeqNo: "S9", title: "VP BTC", city: "Shenzhen", country: "China" },
      { jobId: "IT-1", jobSeqNo: "S10", title: "Marketing EMEA", city: "Milano", country: "Italy" },
    ],
    async (origin) => {
      const jobs = await fetchPhenomJobs("careers.example.com|global/en", {
        originOverride: origin,
        allowPrivateNetworksForTests: true,
        usOnly: true,
        maxAttempts: 1,
        onLocationFiltered: (scope) => filteredScopes.push(scope),
      });
      assert.equal(jobs.length, 3, "Only 3 U.S. jobs must survive from the mixed board");
      const ids = jobs.map((j) => j.externalId);
      assert.ok(ids.includes("US-TX"));
      assert.ok(ids.includes("US-FL"));
      assert.ok(ids.includes("US-TN"));
      assert.ok(!ids.includes("DE-1"), "German job must not survive");
      assert.ok(!ids.includes("PL-1"), "Polish job must not survive");
      assert.ok(!ids.includes("JP-1"), "Japanese job must not survive");
      assert.ok(!ids.includes("NL-1"), "Dutch job must not survive");
      assert.ok(!ids.includes("CN-1"), "Chinese job must not survive");
      assert.ok(!ids.includes("IT-1"), "Italian job must not survive");
      assert.equal(filteredScopes.filter((s) => s === "NON_US").length, 7, "7 foreign jobs must be reported as NON_US");
    }
  );
});

// ─── Test H: Connector validation can validate using foreign samples ─────────

test("Phenom connector validation: usOnly=false returns foreign jobs for evidence without production insert", async () => {
  await withServer(
    [
      { jobId: "DE-1", jobSeqNo: "S1", title: "Ingenieur", city: "Stuttgart", country: "Germany" },
      { jobId: "JP-1", jobSeqNo: "S2", title: "Engineer", city: "Chiba", country: "Japan" },
      { jobId: "IT-1", jobSeqNo: "S3", title: "Designer", city: "Milano", country: "Italy" },
    ],
    async (origin) => {
      // Connector validation path: usOnly=false to get global evidence
      const globalJobs = await fetchPhenomJobs("careers.example.com|global/en", {
        originOverride: origin,
        allowPrivateNetworksForTests: true,
        usOnly: false,
        maxJobs: 3,
        maxAttempts: 1,
      });
      assert.equal(globalJobs.length, 3, "Connector validation with usOnly=false must return all 3 global jobs");
      assert.equal(globalJobs[0].externalId, "DE-1");
      assert.equal(globalJobs[1].externalId, "JP-1");
      assert.equal(globalJobs[2].externalId, "IT-1");

      // Production path: same board, usOnly=true → zero results
      const prodJobs = await fetchPhenomJobs("careers.example.com|global/en", {
        originOverride: origin,
        allowPrivateNetworksForTests: true,
        usOnly: true,
        maxAttempts: 1,
      });
      assert.equal(prodJobs.length, 0, "Production scan with usOnly=true must return zero foreign jobs");
    }
  );
});
