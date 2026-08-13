import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalGoHireUrl, fetchGoHireJobs, normalizeGoHireToken } from "@/lib/ats/gohire";

test("GoHire identity is an exact eight-character client hash", () => {
  assert.equal(normalizeGoHireToken("9t3BsLUp"), "9t3BsLUp");
  assert.equal(canonicalGoHireUrl("9t3BsLUp"), "https://widget.gohire.io/widget/9t3BsLUp");
  assert.throws(() => normalizeGoHireToken("short"));
});

test("GoHire filters the complete listing before exact client/job details", async () => {
  const requested: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/widget-jobs/9t3BsLUp?")) return res.end(JSON.stringify({ jobs: [
      { id: 123, title: "US Engineer", location: "Austin, United States", salary: "$120,000", type: "Full-time", date: "12 August, 2026" },
      { id: 456, title: "EU Engineer", location: "Berlin, Germany", type: "Full-time" },
    ] }));
    const id = new URL(req.url ?? "/", "http://test").searchParams.get("jobId");
    if (req.url?.startsWith("/widget-job?") && id) {
      requested.push(id);
      return res.end(JSON.stringify({ id: Number(id), title: "US Engineer", city: "Austin", county: "Texas",
        country: { code: "US", name: "United States" }, type: { name: "Full-time" }, salary: "$120,000",
        client: { id: 99, name: "Example" }, description: "<p>Complete U.S. role description.</p>" }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    const jobs = await fetchGoHireJobs("9t3BsLUp", { listingOrigin: origin, detailOrigin: origin, usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(requested, ["123"]);
    assert.deepEqual(jobs.map((job) => job.externalId), ["123"]);
    assert.match(jobs[0].descriptionText ?? "", /Complete U.S. role/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
