import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalPersonioUrl, fetchPersonioJobs, normalizePersonioTenant } from "@/lib/ats/personio";

test("Personio identity is tenant-scoped and canonical", () => {
  assert.equal(normalizePersonioTenant("Example-GmbH"), "example-gmbh");
  assert.equal(canonicalPersonioUrl("example-gmbh"), "https://example-gmbh.jobs.personio.de/");
  assert.throws(() => normalizePersonioTenant("example.jobs.personio.de"));
});

test("Personio validates complete feed jobs and filters U.S. locations", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><workzag-jobs>
    <position><id>123</id><subcompany>Example Inc.</subcompany><office>Austin, TX, United States</office><department>Engineering</department><name>Platform Engineer</name>
      <jobDescriptions><jobDescription><name>Role</name><value><![CDATA[<p>Build reliable systems. Salary $120,000 - $140,000.</p>]]></value></jobDescription></jobDescriptions>
      <employmentType>permanent</employmentType><schedule>full-time</schedule><createdAt>2026-08-01T10:00:00+00:00</createdAt></position>
    <position><id>456</id><office>Berlin, Germany</office><name>EU Engineer</name><jobDescriptions><jobDescription><name>Role</name><value><![CDATA[<p>Build EU systems.</p>]]></value></jobDescription></jobDescriptions></position>
  </workzag-jobs>`;
  const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/xml"); res.end(xml); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchPersonioJobs("example", { hostOverride: `http://127.0.0.1:${port}`, usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].externalId, "123");
    assert.equal(jobs[0].url, `http://127.0.0.1:${port}/job/123`);
    assert.equal(jobs[0].descriptionText, "Role Build reliable systems. Salary $120,000 - $140,000.");
    assert.equal(jobs[0].salaryText, "$120,000 - $140,000");
    assert.equal(jobs[0].postedAt, "2026-08-01T10:00:00.000Z");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Personio rejects malformed or duplicate feed identities", async () => {
  const xml = `<?xml version="1.0"?><workzag-jobs><position><id>1</id><office>Remote</office><name>One</name><jobDescriptions><jobDescription><name>Role</name><value><![CDATA[<p>Full role</p>]]></value></jobDescription></jobDescriptions></position><position><id>1</id><office>Remote</office><name>Two</name><jobDescriptions><jobDescription><name>Role</name><value><![CDATA[<p>Full role</p>]]></value></jobDescription></jobDescriptions></position></workzag-jobs>`;
  const server = http.createServer((_req, res) => res.end(xml));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await assert.rejects(() => fetchPersonioJobs("example", { hostOverride: `http://127.0.0.1:${port}`, maxAttempts: 1 }), /duplicate position ID/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
