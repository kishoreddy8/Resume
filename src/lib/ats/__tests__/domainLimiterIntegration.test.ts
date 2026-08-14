import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { encodeWorkdayToken, fetchWorkdayJobs } from "@/lib/ats/workday";
import { encodeAdpWorkforceNowToken, fetchAdpWorkforceNowJobs } from "@/lib/ats/adpWorkforceNow";
import { fetchPhenomJobs } from "@/lib/ats/phenom";
import { resetForTesting } from "@/lib/scan/domainLimiter";

const servers: http.Server[] = [];

function createServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

after(() => {
  for (const s of servers) s.close();
});

beforeEach(() => {
  resetForTesting();
});

test("Workday domain limiter throttles concurrent multi-tenant scans to max concurrency 2", async () => {
  let activeRequests = 0;
  let maxActiveObserved = 0;

  const { url } = await createServer((req, res) => {
    activeRequests++;
    maxActiveObserved = Math.max(maxActiveObserved, activeRequests);

    setTimeout(() => {
      activeRequests--;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.includes("/jobs")) {
        res.end(JSON.stringify({
          total: 1,
          jobPostings: [{ title: "Software Engineer", externalPath: "/job/SE_JR100", locationsText: "Austin, TX, US" }],
        }));
      } else {
        res.end(JSON.stringify({
          jobPostingInfo: { title: "Software Engineer", jobReqId: "JR100", jobDescription: "Great job in US", location: "Austin, TX, US" },
        }));
      }
    }, 25);
  });

  // Launch 5 concurrent Workday tenant scans simultaneously
  const tenants = ["tenant1", "tenant2", "tenant3", "tenant4", "tenant5"];
  const scanPromises = tenants.map((tenant) => {
    const token = encodeWorkdayToken({ tenant, host: "wd1", site: "careers" });
    return fetchWorkdayJobs(token, { hostOverride: url, usOnly: true, maxAttempts: 1 });
  });

  const allResults = await Promise.all(scanPromises);
  assert.equal(allResults.length, 5);
  for (const jobs of allResults) {
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].externalId, "JR100");
  }

  // Verify that peak concurrent requests to the mock server never exceeded 2
  assert.ok(maxActiveObserved <= 2, `Expected max concurrent requests <= 2, observed ${maxActiveObserved}`);
});

test("ADP WFN domain limiter serializes multi-tenant scans to max concurrency 1", async () => {
  let activeRequests = 0;
  let maxActiveObserved = 0;

  const { url } = await createServer((req, res) => {
    activeRequests++;
    maxActiveObserved = Math.max(maxActiveObserved, activeRequests);

    setTimeout(() => {
      activeRequests--;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.includes("job-requisitions?")) {
        res.end(JSON.stringify({
          meta: { totalNumber: 1 },
          jobRequisitions: [{
            itemID: "ITEM-99",
            requisitionTitle: "Staff Engineer",
            requisitionLocations: [{ address: { cityName: "Dallas", countrySubdivisionLevel1: { codeValue: "TX" }, countryCode: "US" } }],
          }],
        }));
      } else {
        res.end(JSON.stringify({
          itemID: "ITEM-99",
          requisitionTitle: "Staff Engineer",
          requisitionDescription: "<p>Full job description</p>",
          requisitionLocations: [{ address: { cityName: "Dallas", countrySubdivisionLevel1: { codeValue: "TX" }, countryCode: "US" } }],
        }));
      }
    }, 15);
  });

  // Launch 3 concurrent ADP WFN tenant scans simultaneously
  const tokens = [
    encodeAdpWorkforceNowToken({ cid: "11111111-1111-1111-1111-111111111111", ccId: "CC1", lang: "en_US" }),
    encodeAdpWorkforceNowToken({ cid: "22222222-2222-2222-2222-222222222222", ccId: "CC2", lang: "en_US" }),
    encodeAdpWorkforceNowToken({ cid: "33333333-3333-3333-3333-333333333333", ccId: "CC3", lang: "en_US" }),
  ];

  const scanPromises = tokens.map((token) => {
    return fetchAdpWorkforceNowJobs(token, { hostOverride: url, usOnly: true, maxAttempts: 1 });
  });

  const allResults = await Promise.all(scanPromises);
  assert.equal(allResults.length, 3);
  for (const jobs of allResults) {
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].externalId, "ITEM-99");
  }

  // Verify that concurrency was strictly 1
  assert.equal(maxActiveObserved, 1, `Expected max concurrent requests = 1, observed ${maxActiveObserved}`);
});

test("Phenom adapter handles pagination cutoff gracefully when totalHits is advisory", async () => {
  const { url } = await createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    const u = new URL(req.url ?? "/", "http://localhost");
    const from = Number(u.searchParams.get("from") ?? "0");

    if (u.pathname.includes("/search-results")) {
      if (from === 0) {
        // Page 1 returns 2 jobs, but advertises totalHits: 50 (e.g. including unlisted/internal/foreign jobs)
        const ddo = {
          eagerLoadRefineSearch: {
            totalHits: 50,
            data: {
              jobs: [
                { jobId: "J1", jobSeqNo: "SEQ1", title: "US Cloud Architect", city: "Denver", state: "CO", country: "United States" },
                { jobId: "J2", jobSeqNo: "SEQ2", title: "US Security Engineer", city: "Boulder", state: "CO", country: "United States" },
              ],
            },
          },
        };
        res.end(`<html><script>phApp.ddo = ${JSON.stringify(ddo)};</script></html>`);
        return;
      } else {
        // Page 2 returns empty jobs array
        const ddo = {
          refineSearch: {
            data: {
              totalHits: 50,
              jobs: [],
            },
          },
        };
        res.end(`<html><script>phApp.ddo = ${JSON.stringify(ddo)};</script></html>`);
        return;
      }
    }

    if (u.pathname.includes("/job/")) {
      const ddo = {
        jobDetail: {
          data: {
            job: {
              description: "<p>Great role</p>",
            },
          },
        },
      };
      res.end(`<html><script>phApp.ddo = ${JSON.stringify(ddo)};</script></html>`);
      return;
    }

    res.writeHead(404).end("Not found");
  });

  // Should succeed and return the 2 collected jobs without throwing count mismatch or empty page error
  const jobs = await fetchPhenomJobs("careers.example.com|global/en", {
    originOverride: url,
    allowPrivateNetworksForTests: true,
    usOnly: true,
    maxAttempts: 1,
  });

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].externalId, "J1");
  assert.equal(jobs[1].externalId, "J2");
});
