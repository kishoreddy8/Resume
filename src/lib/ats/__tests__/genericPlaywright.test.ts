import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { scrapeCareerPageDetailed } from "@/lib/ats/genericPlaywright";

/**
 * Generic (non-ATS) connector regression coverage — see AGENTS.md §15/§16/§18. Locks in the actual
 * current posted-date behavior after the Phase 2.5 jobValidation.ts change: the anchor-heuristic
 * fallback path never sets postedAt (matches the pre-existing "Generic: currently null" audit), but
 * when a page publishes JSON-LD JobPosting structured data, that data's real datePosted is used —
 * this was an explicit, reasoned part of the positive-evidence validation work (real evidence, not a
 * fabricated date), not a silent drift. Runs a real headless Chromium against a local HTTP server —
 * never a live company site.
 */

const servers: http.Server[] = [];
function startServer(html: string): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
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

test("genericPlaywright: JSON-LD JobPosting data is used directly, including its real datePosted", async () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org/","@type":"JobPosting","title":"Data Engineer",
     "url":"https://example.com/jobs/1","datePosted":"2026-08-01",
     "jobLocation":{"address":{"addressLocality":"Remote"}}}
  </script></head><body><h1>Careers</h1></body></html>`;
  const origin = await startServer(html);
  const { jobs } = await scrapeCareerPageDetailed(origin);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "Data Engineer");
  assert.equal(jobs[0].postedAt, "2026-08-01");
});

test("genericPlaywright: the anchor-heuristic fallback (no JSON-LD) never fabricates postedAt — always null", async () => {
  const html = `<html><body>
    <a href="/jobs/software-engineer-482913">Software Engineer</a>
    <a href="/privacy">Privacy</a>
    <a href="/about">About Us</a>
  </body></html>`;
  const origin = await startServer(html);
  const { jobs } = await scrapeCareerPageDetailed(origin);
  assert.ok(jobs.length >= 1, "expected at least the requisition-shaped link to be accepted");
  for (const job of jobs) assert.equal(job.postedAt, null);
});

test("genericPlaywright: positive-evidence validation rejects nav clutter even when rendered in a real page", async () => {
  const html = `<html><body>
    <a href="/jobs/data-engineer-482913">Data Engineer</a>
    <a href="/privacy">Privacy</a>
    <a href="/benefits">Benefits</a>
    <a href="/locations">Locations</a>
    <a href="/talent-network">Talent Network</a>
  </body></html>`;
  const origin = await startServer(html);
  const { jobs } = await scrapeCareerPageDetailed(origin);
  const titles = jobs.map((j) => j.title);
  assert.ok(titles.includes("Data Engineer"));
  for (const navTitle of ["Privacy", "Benefits", "Locations", "Talent Network"]) {
    assert.ok(!titles.includes(navTitle), `"${navTitle}" should have been rejected, not ingested as a job`);
  }
});
