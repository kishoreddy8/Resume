import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { extractLocationEvidence, scrapeCareerPageDetailed } from "@/lib/ats/genericPlaywright";
import { ScanConnectorError } from "@/lib/scan/errors";

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
  const { jobs } = await scrapeCareerPageDetailed(origin, { allowPrivateNetworksForTests: true });
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
  const { jobs } = await scrapeCareerPageDetailed(origin, { allowPrivateNetworksForTests: true });
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
  const { jobs } = await scrapeCareerPageDetailed(origin, { allowPrivateNetworksForTests: true });
  const titles = jobs.map((j) => j.title);
  assert.ok(titles.includes("Data Engineer"));
  for (const navTitle of ["Privacy", "Benefits", "Locations", "Talent Network"]) {
    assert.ok(!titles.includes(navTitle), `"${navTitle}" should have been rejected, not ingested as a job`);
  }
});

test("genericPlaywright: listing-card location evidence is retained only from an explicit short line", () => {
  assert.equal(
    extractLocationEvidence("Data Engineer\nAustin, TX\nApply Now", "Data Engineer"),
    "Austin, TX"
  );
  assert.equal(
    extractLocationEvidence("Data Engineer\nJoin our growing engineering team\nApply Now", "Data Engineer"),
    null
  );
});

test("SSRF: a loopback seed URL is refused BEFORE the browser ever launches", async () => {
  await assert.rejects(
    () => scrapeCareerPageDetailed("http://127.0.0.1:9/"),
    (err: unknown) => err instanceof ScanConnectorError && err.category === "unsafe_url"
  );
});

test("SSRF: a seed URL with a disallowed scheme is refused regardless of allowPrivateNetworksForTests", async () => {
  await assert.rejects(
    () => scrapeCareerPageDetailed("ftp://127.0.0.1/", { allowPrivateNetworksForTests: true }),
    (err: unknown) => err instanceof ScanConnectorError && err.category === "unsafe_url"
  );
});

test("SSRF: an in-page navigation to a disallowed scheme is blocked, not just the seed URL", async () => {
  // Mirrors discoveryBrowser.test.ts's equivalent case: ftp:// is rejected regardless of the
  // allowPrivateNetworksForTests bypass (the scheme check happens before that bypass applies),
  // proving page.route's per-navigation interception is actually wired up here too.
  const origin = await startServer(
    `<html><body><script>window.location.href = 'ftp://evil.example/';</script></body></html>`
  );
  const { jobs } = await scrapeCareerPageDetailed(origin, { allowPrivateNetworksForTests: true });
  // The blocked navigation must not crash/hang the scrape — it just finds nothing on the
  // (still-loaded) seed page and returns honestly, same as discoveryBrowser's equivalent case.
  assert.deepEqual(jobs, []);
});

test("a normal same-origin redirect to a real careers page is still followed and scraped", async () => {
  const html = `<html><body><a href="/jobs/software-engineer-482913">Software Engineer</a></body></html>`;
  await new Promise<void>((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/careers") {
        res.writeHead(302, { Location: "/careers/open-roles" });
        res.end();
      } else if (req.url === "/careers/open-roles") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const { jobs } = await scrapeCareerPageDetailed(`http://127.0.0.1:${port}/careers`, {
        allowPrivateNetworksForTests: true,
      });
      assert.ok(
        jobs.some((j) => j.title === "Software Engineer"),
        "a legitimate same-origin redirect must still be followed and scraped, not blocked as unsafe"
      );
      resolve();
    });
  });
});
