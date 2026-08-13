import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalTeamtailorUrl, fetchTeamtailorJobs, normalizeTeamtailorTenant } from "@/lib/ats/teamtailor";

test("Teamtailor identity is tenant scoped", () => {
  assert.equal(normalizeTeamtailorTenant("Example-Co"), "example-co");
  assert.equal(canonicalTeamtailorUrl("example-co"), "https://example-co.teamtailor.com/jobs");
  assert.throws(() => normalizeTeamtailorTenant("www"));
});

test("Teamtailor parses its complete RSS descriptions and filters structured locations", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/rss+xml");
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:tt="https://teamtailor.com/locations"><channel>
      <link>https://example.teamtailor.com/jobs</link>
      <item><title>Canada Role</title><description>&lt;p&gt;Canada description&lt;/p&gt;</description><link>${origin}/jobs/100-canada</link><tt:locations><tt:location><tt:city>Toronto</tt:city><tt:country>Canada</tt:country></tt:location></tt:locations></item>
      <item><title>US Engineer</title><description>&lt;p&gt;Complete role &amp;amp; salary $120,000.&lt;/p&gt;</description><pubDate>Thu, 30 Jul 2026 02:34:56 -0600</pubDate><link>${origin}/jobs/200-us-engineer</link><guid>uuid</guid><tt:locations><tt:location><tt:name>HQ</tt:name><tt:city>Austin</tt:city><tt:country>United States</tt:country></tt:location></tt:locations><tt:department>Engineering</tt:department></item>
    </channel></rss>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchTeamtailorJobs("example", { hostOverride: `http://127.0.0.1:${port}`, usOnly: true, maxAttempts: 1 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].externalId, "200");
    assert.equal(jobs[0].location, "HQ, Austin, United States");
    assert.equal(jobs[0].descriptionText, "Complete role & salary $120,000.");
    assert.equal(jobs[0].department, "Engineering");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
