import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalJazzHrUrl, fetchJazzHrJobs, normalizeJazzHrTenant } from "@/lib/ats/jazzhr";

test("JazzHR identity is tenant scoped", () => {
  assert.equal(normalizeJazzHrTenant("Example-Co"), "example-co");
  assert.equal(canonicalJazzHrUrl("example-co"), "https://example-co.applytojob.com/apply");
  assert.throws(() => normalizeJazzHrTenant("www"));
});

test("JazzHR parses the complete server list and filters U.S. before details", async () => {
  const details: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/apply") {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const origin = `http://127.0.0.1:${port}`;
      return res.end(`<main><div class="job-board-list"><div class="jobs-list">
        <h3 class="list-group-item-heading"><a href="${origin}/apply/AAAAAAAAAA/Canada">Canada</a></h3>
        <ul><li><i class="fa fa-map-marker"></i>Toronto, Canada</li></ul>
        <h3 class="list-group-item-heading"><a href="${origin}/apply/BBBBBBBBBB/Us-Engineer">US Engineer</a></h3>
        <ul><li><i class="fa fa-map-marker"></i>Austin, TX</li><li><i class="fa fa-sitemap"></i>Engineering</li></ul>
      </div></div></main>`);
    }
    const id = req.url?.match(/\/apply\/([A-Z]{10})\//)?.[1];
    if (id) {
      details.push(id);
      return res.end(`<script type="application/ld+json">${JSON.stringify({
        "@type": "JobPosting", title: "US Engineer", url: `https://example.applytojob.com/apply/${id}/Us-Engineer`,
        description: "<p>Complete role. Salary $120,000 - $140,000.</p>", datePosted: "2026-08-01",
        jobLocation: { address: { addressLocality: "Austin", addressRegion: "TX", addressCountry: "US" } },
      })}</script>`);
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchJazzHrJobs("example", { hostOverride: `http://127.0.0.1:${port}`, usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(details, ["BBBBBBBBBB"]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].department, "Engineering");
    assert.equal(jobs[0].descriptionText, "Complete role. Salary $120,000 - $140,000.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("JazzHR accepts an identity-matched legacy HTML description", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/apply") {
      return res.end(`<main><div class="job-board-list"><div class="jobs-list">
        <h3 class="list-group-item-heading"><a href="/apply/CCCCCCCCCC/Engineer">Engineer</a></h3>
        <ul><li><i class="fa fa-map-marker"></i>New York, NY</li></ul>
      </div></div></main>`);
    }
    if (req.url === "/apply/CCCCCCCCCC/Engineer") {
      return res.end(`<div id="job-description"><div><p>Complete legacy role.</p></div><p>Salary $100,000.</p></div>
        <input id="resumator-job-value" value="CCCCCCCCCC" type="hidden">`);
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchJazzHrJobs("example", { hostOverride: `http://127.0.0.1:${port}`, usOnly: true, maxAttempts: 1 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].descriptionText, "Complete legacy role. Salary $100,000.");
    assert.equal((jobs[0].raw as { detail: { format: string } }).detail.format, "legacy-html");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
