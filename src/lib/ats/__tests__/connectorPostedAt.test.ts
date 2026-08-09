import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { fetchAshbyJobs } from "@/lib/ats/ashby";
import { fetchGreenhouseJobs } from "@/lib/ats/greenhouse";
import { fetchLeverJobs } from "@/lib/ats/lever";
import { encodeWorkdayToken, fetchWorkdayJobs } from "@/lib/ats/workday";

/**
 * Locks in each connector's actual posted-date semantics against a real local HTTP server (never
 * the live ATS APIs) — see AGENTS.md §18's audit: Ashby uses publishedAt, Lever uses createdAt
 * (converted to ISO), Workday uses startDate ONLY when the per-job detail fetch succeeds (null
 * otherwise), and Greenhouse has no true posted-date field at all — it substitutes updated_at, which
 * is NOT a guaranteed true posting date. Generic (genericPlaywright.ts) never sets one; see that
 * file's own NormalizedJob mapping, still always postedAt: null there.
 *
 * This test intentionally does NOT "fix" or "improve" any of these — it only proves current
 * behavior stays exactly as documented, so a future change can't silently drift without a failing
 * test forcing an explicit decision.
 */

const servers: http.Server[] = [];
function startServer(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}
after(() => {
  for (const server of servers) server.close();
});

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

test("Ashby connector: postedAt comes from publishedAt", async () => {
  const origin = await startServer((req, res) => {
    json(res, 200, {
      jobs: [
        { id: "1", title: "Data Engineer", jobUrl: "https://x/1", publishedAt: "2026-08-01T00:00:00Z" },
        { id: "2", title: "No Date Role", jobUrl: "https://x/2" }, // publishedAt omitted
      ],
    });
  });
  const jobs = await fetchAshbyJobs("acme", { hostOverride: origin });
  assert.equal(jobs[0].postedAt, "2026-08-01T00:00:00Z");
  assert.equal(jobs[1].postedAt, null); // never fabricated when publishedAt is absent
});

test("Lever connector: postedAt comes from createdAt, converted to an ISO string", async () => {
  const createdAtMs = Date.UTC(2026, 7, 1); // 2026-08-01
  const origin = await startServer((req, res) => {
    json(res, 200, [
      { id: "1", text: "Backend Engineer", hostedUrl: "https://x/1", createdAt: createdAtMs },
      { id: "2", text: "No Date Role", hostedUrl: "https://x/2" }, // createdAt omitted
    ]);
  });
  const jobs = await fetchLeverJobs("acme", { hostOverride: origin });
  assert.equal(jobs[0].postedAt, new Date(createdAtMs).toISOString());
  assert.equal(jobs[1].postedAt, null);
});

test("Greenhouse connector: postedAt substitutes updated_at (documented as NOT a true posting date)", async () => {
  const origin = await startServer((req, res) => {
    json(res, 200, {
      jobs: [{ id: 1, title: "Engineer", updated_at: "2026-08-01T00:00:00Z", absolute_url: "https://x/1" }],
    });
  });
  const jobs = await fetchGreenhouseJobs("acme", { hostOverride: origin });
  assert.equal(jobs[0].postedAt, "2026-08-01T00:00:00Z");
});

test("Workday connector: postedAt is startDate when the per-job detail fetch succeeds", async () => {
  const token = encodeWorkdayToken({ tenant: "acme", host: "wd5", site: "External" });
  const origin = await startServer((req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/jobs")) {
      json(res, 200, { total: 1, jobPostings: [{ title: "Data Engineer", externalPath: "/job/Remote/Data-Engineer_R1234" }] });
    } else {
      json(res, 200, {
        jobPostingInfo: {
          title: "Data Engineer",
          jobDescription: "<p>desc</p>",
          location: "Remote",
          startDate: "2026-08-01",
          jobReqId: "R1234",
        },
      });
    }
  });
  const jobs = await fetchWorkdayJobs(token, { hostOverride: origin });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].postedAt, "2026-08-01");
});

test("Workday connector: postedAt is null when the per-job detail fetch fails — never falls back to a guessed date", async () => {
  const token = encodeWorkdayToken({ tenant: "acme", host: "wd5", site: "External" });
  const origin = await startServer((req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/jobs")) {
      json(res, 200, { total: 1, jobPostings: [{ title: "Data Engineer", externalPath: "/job/Remote/Data-Engineer_R1234" }] });
    } else {
      res.writeHead(500);
      res.end("server error");
    }
  });
  const jobs = await fetchWorkdayJobs(token, { hostOverride: origin, maxAttempts: 1, baseDelayMs: 0 });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].postedAt, null);
  // externalId still recovers the requisition ID from the path even though the detail fetch failed
  // (see reqIdFromExternalPath's doc comment) — proves the fallback path, not a generic error, ran.
  assert.equal(jobs[0].externalId, "R1234");
});
