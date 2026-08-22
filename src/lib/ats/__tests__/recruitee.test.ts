import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalRecruiteeUrl, fetchRecruiteeJobs, normalizeRecruiteeTenant } from "@/lib/ats/recruitee";

const offer = (id: string, location: string, extra = "") => `<offer><id>${id}</id><slug>platform-${id}</slug><title><![CDATA[Platform Engineer ${id}]]></title><description><![CDATA[<p>Build reliable platforms. Salary $120,000 - $140,000.</p>]]></description><requirements><![CDATA[<p>Production experience.</p>]]></requirements><location>${location}</location><department>Engineering</department><employment_type_code>full_time</employment_type_code><remote>false</remote><hybrid>true</hybrid><on_site>false</on_site><company_name>Example</company_name><careers_url>https://example.recruitee.com/o/platform-${id}</careers_url><published_at>2026-08-01 10:00:00 UTC</published_at>${extra}</offer>`;

test("Recruitee identity is tenant-scoped and canonical", () => {
  assert.equal(normalizeRecruiteeTenant("Example-Co"), "example-co");
  assert.equal(canonicalRecruiteeUrl("example-co"), "https://example-co.recruitee.com/");
  assert.throws(() => normalizeRecruiteeTenant("example.recruitee.com"));
});

test("Recruitee parses the official feed, filters locations, and preserves canonical URLs", async () => {
  const xml = `<?xml version="1.0"?><offers>${offer("101", "Austin, Texas, United States", "<locations><location><city>Austin</city><state>Texas</state><country>United States</country></location></locations>")}${offer("202", "Berlin, Germany")}</offers>`;
  const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/xml"); res.end(xml); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchRecruiteeJobs("example", { hostOverride: `http://127.0.0.1:${port}`, usOnly: true, maxAttempts: 1 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].externalId, "101");
    assert.equal(jobs[0].url, "https://example.recruitee.com/o/platform-101");
    assert.equal(jobs[0].workplaceType, "Hybrid");
    assert.match(jobs[0].descriptionText ?? "", /Production experience/);
    assert.equal(jobs[0].salaryText, "$120,000 - $140,000");
    assert.equal(jobs[0].postedAt, "2026-08-01T10:00:00.000Z");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Recruitee rejects malformed, duplicate, and cross-tenant offers", async () => {
  const cases = [
    `<?xml version="1.0"?><offers>${offer("1", "Remote")}${offer("1", "Remote")}</offers>`,
    `<?xml version="1.0"?><offers><offer><id>1</id><title>Missing fields</title></offer></offers>`,
    `<?xml version="1.0"?><offers>${offer("2", "Remote").replace("example.recruitee.com", "other.recruitee.com")}</offers>`,
  ];
  for (const xml of cases) {
    const server = http.createServer((_req, res) => res.end(xml));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      await assert.rejects(() => fetchRecruiteeJobs("example", { hostOverride: `http://127.0.0.1:${port}`, maxAttempts: 1 }));
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test("Recruitee isolates network failures", async () => {
  await assert.rejects(() => fetchRecruiteeJobs("example", { hostOverride: "http://127.0.0.1:1", maxAttempts: 1, timeoutMs: 50 }));
});
