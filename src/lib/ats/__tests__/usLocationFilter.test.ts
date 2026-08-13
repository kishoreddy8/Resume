import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { fetchGreenhouseJobs } from "@/lib/ats/greenhouse";
import { encodeWorkdayToken, fetchWorkdayJobs, workdayListingFingerprint } from "@/lib/ats/workday";
import { classifyJobLocation } from "@/lib/jobLocationScope";

const servers: http.Server[] = [];
function startServer(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });
}
after(() => servers.forEach((server) => server.close()));

function json(res: http.ServerResponse, body: unknown) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

test("location classifier requires explicit U.S. evidence and preserves ambiguity", () => {
  assert.equal(classifyJobLocation("Austin, TX"), "US");
  assert.equal(classifyJobLocation("Remote - United States"), "US");
  assert.equal(classifyJobLocation("Toronto, Canada"), "NON_US");
  assert.equal(classifyJobLocation("Toronto, ON, CA"), "NON_US");
  assert.equal(classifyJobLocation("Vancouver, BC, CA"), "NON_US");
  assert.equal(classifyJobLocation("London, UK"), "NON_US");
  assert.equal(classifyJobLocation("Remote"), "UNKNOWN");
  assert.equal(classifyJobLocation(null), "UNKNOWN");
});

test("Greenhouse U.S. filter applies maxJobs after filtering", async () => {
  const origin = await startServer((_req, res) => {
    json(res, {
      jobs: [
        { id: 1, title: "Canada", updated_at: "2026-01-01", absolute_url: "https://x/1", location: { name: "Toronto, Canada" } },
        { id: 2, title: "US one", updated_at: "2026-01-01", absolute_url: "https://x/2", location: { name: "Austin, TX" } },
        { id: 3, title: "US two", updated_at: "2026-01-01", absolute_url: "https://x/3", location: { name: "New York, NY" } },
        { id: 4, title: "Ambiguous", updated_at: "2026-01-01", absolute_url: "https://x/4", location: { name: "Remote" } },
      ],
    });
  });
  const filteredScopes: string[] = [];
  const jobs = await fetchGreenhouseJobs("acme", {
    hostOverride: origin,
    usOnly: true,
    maxJobs: 1,
    onLocationFiltered: (scope) => filteredScopes.push(scope),
  });
  assert.deepEqual(jobs.map((job) => job.externalId), ["2"]);
  assert.deepEqual(filteredScopes, ["NON_US", "UNKNOWN"]);
});

test("Workday skips detail requests for explicit non-U.S. listings", async () => {
  let detailRequests = 0;
  const origin = await startServer((req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/jobs")) {
      json(res, {
        total: 2,
        jobPostings: [
          { title: "Canada", externalPath: "/job/Canada/Role_R1", locationsText: "Toronto, Canada" },
          { title: "US", externalPath: "/job/US/Role_R2", locationsText: "Denver, CO" },
        ],
      });
      return;
    }
    detailRequests++;
    json(res, { jobPostingInfo: { title: "US", jobReqId: "R2", location: "Denver, CO", jobDescription: "<p>Role</p>" } });
  });
  const token = encodeWorkdayToken({ tenant: "acme", host: "wd5", site: "External" });
  const jobs = await fetchWorkdayJobs(token, { hostOverride: origin, usOnly: true });
  assert.equal(detailRequests, 1);
  assert.deepEqual(jobs.map((job) => job.externalId), ["R2"]);
});

test("Workday U.S. sample stops paging after enough eligible listings", async () => {
  let listRequests = 0;
  let detailRequests = 0;
  const origin = await startServer((req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/jobs")) {
      listRequests++;
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const offset = (JSON.parse(body) as { offset: number }).offset;
        const postings = offset === 0
          ? Array.from({ length: 20 }, (_, index) => ({ title: `Canada ${index}`, externalPath: `/job/CA/Role_R${index}`, locationsText: "Toronto, Canada" }))
          : Array.from({ length: 20 }, (_, index) => ({ title: `US ${index}`, externalPath: `/job/US/Role_US${index}`, locationsText: "Austin, TX" }));
        json(res, { total: 100, jobPostings: postings });
      });
      return;
    }
    detailRequests++;
    const reqId = req.url?.match(/_(US\d+)$/)?.[1] ?? "US";
    json(res, { jobPostingInfo: { title: reqId, jobReqId: reqId, location: "Austin, TX" } });
  });
  const token = encodeWorkdayToken({ tenant: "acme", host: "wd5", site: "External" });
  const jobs = await fetchWorkdayJobs(token, { hostOverride: origin, usOnly: true, maxJobs: 3 });
  assert.equal(listRequests, 2);
  assert.equal(detailRequests, 3);
  assert.equal(jobs.length, 3);
});

test("Workday skips details when a stored listing fingerprint is unchanged", async () => {
  let detailRequests = 0;
  const listing = { title: "US", externalPath: "/job/US/Role_R2", locationsText: "Denver, CO" };
  const origin = await startServer((req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/jobs")) {
      json(res, { total: 1, jobPostings: [listing] });
      return;
    }
    detailRequests++;
    json(res, { jobPostingInfo: { title: "US", jobReqId: "R2", location: "Denver, CO" } });
  });
  const token = encodeWorkdayToken({ tenant: "acme", host: "wd5", site: "External" });
  const jobs = await fetchWorkdayJobs(token, {
    hostOverride: origin,
    usOnly: true,
    existingExternalIds: new Set(["R2"]),
    existingListingFingerprints: new Map([["R2", workdayListingFingerprint(listing)]]),
  });
  assert.equal(detailRequests, 0);
  assert.equal(jobs[0].lifecycleOnly, true);
});

test("existing out-of-scope jobs remain lifecycle sightings", async () => {
  const origin = await startServer((_req, res) => {
    json(res, {
      jobs: [
        { id: 9, title: "Canada", updated_at: "2026-01-01", absolute_url: "https://x/9", location: { name: "Toronto, Canada" } },
      ],
    });
  });
  const jobs = await fetchGreenhouseJobs("acme", {
    hostOverride: origin,
    usOnly: true,
    existingExternalIds: new Set(["9"]),
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].lifecycleOnly, true);
});
