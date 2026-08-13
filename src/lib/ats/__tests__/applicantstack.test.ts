import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalApplicantStackUrl, fetchApplicantStackJobs, normalizeApplicantStackTenant } from "@/lib/ats/applicantstack";

test("ApplicantStack identity is tenant-scoped and canonical", () => {
  assert.equal(normalizeApplicantStackTenant("Example-Co"), "example-co");
  assert.equal(canonicalApplicantStackUrl("example-co"), "https://example-co.applicantstack.com/x/openings");
  assert.throws(() => normalizeApplicantStackTenant("example.applicantstack.com"));
});

test("ApplicantStack exhausts exact pagination, filters before detail, and validates JSON-LD identity", async () => {
  const details: string[] = [];
  let origin = "";
  const row = (id: string, title: string, location: string) => `<tr><td><a href="${origin}/x/detail/${id}">${title}</a></td><td>Engineering</td><td>${location}</td></tr>`;
  const page = (start: number, end: number, total: number, rows: string) => `<!doctype html><title>ApplicantStack</title><table id="data-table"><tbody>${rows}</tbody></table><div>Showing ${start} - ${end} of ${total}</div><footer>Powered by ApplicantStack&trade;</footer>`;
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/x/openings") return res.end(page(1, 2, 3, row("abc123", "US Engineer", "Austin, TX") + row("eu456", "EU Engineer", "Berlin, Germany")));
    if (req.url === "/x/openings?pge=2") return res.end(page(3, 3, 3, row("xyz789", "US Analyst", "Madison, WI")));
    const id = req.url?.match(/^\/x\/detail\/([a-z0-9]+)$/)?.[1];
    if (id) {
      details.push(id);
      const title = id === "abc123" ? "US Engineer" : "US Analyst";
      const city = id === "abc123" ? "Austin" : "Madison";
      const region = id === "abc123" ? "TX" : "WI";
      return res.end(`<meta property="og:url" content="${origin}/x/detail/${id}"><script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", identifier: { value: id }, title, datePosted: "2026-08-01T10:00:00Z", description: `<p>Complete ${title} description. Salary $120,000.</p>`, jobLocation: { address: { addressLocality: city, addressRegion: region, addressCountry: "United States" } } })}</script>`);
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
    const jobs = await fetchApplicantStackJobs("example", { hostOverride: origin, usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(details.sort(), ["abc123", "xyz789"]);
    assert.deepEqual(jobs.map((job) => job.externalId), ["abc123", "xyz789"]);
    assert.equal(jobs[0].location, "Austin, TX, United States");
    assert.match(jobs[0].descriptionText ?? "", /Complete US Engineer description/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
