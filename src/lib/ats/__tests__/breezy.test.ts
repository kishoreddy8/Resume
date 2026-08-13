import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalBreezyUrl, fetchBreezyJobs, normalizeBreezyTenant } from "@/lib/ats/breezy";

test("Breezy identity is tenant scoped", () => {
  assert.equal(normalizeBreezyTenant("Example-Co"), "example-co");
  assert.equal(canonicalBreezyUrl("example-co"), "https://example-co.breezy.hr/");
  assert.throws(() => normalizeBreezyTenant("www"));
});

test("Breezy accepts legacy HTML only with an exact embedded position ID", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/") return res.end(`<div class="positions-container"><a href="/p/cccccccccccc-role"><h2>Legacy Role</h2><li class="location"><i></i><span>Denver, CO</span></li></a></div>`);
    if (req.url === "/p/cccccccccccc-role") return res.end(`<script>var positionId="cccccccccccc"</script><div class="description"><div><p>Complete legacy role.</p></div></div>`);
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchBreezyJobs("example", { hostOverride: `http://127.0.0.1:${port}`, usOnly: true, maxAttempts: 1 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].descriptionText, "Complete legacy role.");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Breezy deduplicates multi-location cards and filters before exact details", async () => {
  const details: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/") return res.end(`<div class="positions-container">
      <h2 class="group-header"><i></i><span>Toronto, Canada</span></h2><a href="/p/aaaaaaaaaaaa-engineer"><h2>Engineer</h2><li class="department"><span>Tech</span></li></a>
      <h2 class="group-header"><i></i><span>Austin, TX</span></h2><a href="/p/aaaaaaaaaaaa-engineer"><h2>Engineer</h2><li class="department"><span>Tech</span></li></a>
      <h2 class="group-header"><i></i><span>Paris, France</span></h2><a href="/p/bbbbbbbbbbbb-designer"><h2>Designer</h2></a></div>`);
    const id = req.url?.match(/\/p\/([a-f]{12})-/)?.[1];
    if (id) {
      details.push(id);
      return res.end(`<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", url: `https://example.breezy.hr${req.url}`, title: "Engineer", description: "<p>Complete role.</p>", datePosted: "2026-08-01" })}</script>`);
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchBreezyJobs("example", { hostOverride: `http://127.0.0.1:${port}`, usOnly: true, maxAttempts: 1 });
    assert.deepEqual(details, ["aaaaaaaaaaaa"]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].location, "Toronto, Canada; Austin, TX");
    assert.equal(jobs[0].descriptionText, "Complete role.");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
