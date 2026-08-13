import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalPinpointUrl, fetchPinpointJobs, normalizePinpointTenant } from "@/lib/ats/pinpoint";

test("Pinpoint identity is tenant scoped", () => {
  assert.equal(normalizePinpointTenant("Example-Co"), "example-co");
  assert.equal(canonicalPinpointUrl("example-co"), "https://example-co.pinpointhq.com/");
  assert.throws(() => normalizePinpointTenant("www"));
});

test("Pinpoint parses full sections and filters structured locations without details", async () => {
  let origin = "";
  const server = http.createServer((req, res) => {
    if (req.url !== "/postings.json") { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Type", "application/json");
    const posting = (uuid: string, location: string) => ({ id: "12", title: "Engineer", url: `${origin}/en/postings/${uuid}`, path: `/en/postings/${uuid}`,
      description: "<p>Role overview.</p>", key_responsibilities: "<ul><li>Build systems.</li></ul>", skills_knowledge_expertise: "<p>TypeScript.</p>",
      benefits: "<p>Health.</p>", employment_type_text: "Full Time", workplace_type_text: "Remote", compensation: "$100,000 / year",
      job: { requisition_id: "REQ-1", department: { name: "Engineering" } }, location: { name: location } });
    res.end(JSON.stringify({ data: [
      posting("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "United States - Austin, TX"),
      posting("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "London, United Kingdom"),
    ] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
    const jobs = await fetchPinpointJobs("example", { hostOverride: origin, usOnly: true, maxAttempts: 1 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].externalId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const description = jobs[0].descriptionText ?? "";
    for (const text of ["Role overview", "Key Responsibilities", "Build systems", "TypeScript", "Benefits", "Health"]) {
      assert.ok(description.includes(text));
    }
    assert.equal(jobs[0].salaryText, "$100,000 / year");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
