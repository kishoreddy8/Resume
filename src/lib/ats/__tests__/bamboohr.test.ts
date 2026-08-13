import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalBambooHrUrl, fetchBambooHrJobs, normalizeBambooHrTenant } from "@/lib/ats/bamboohr";

test("BambooHR identity is tenant-scoped and canonical", () => {
  assert.equal(normalizeBambooHrTenant("Example-Co"), "example-co");
  assert.equal(canonicalBambooHrUrl("example-co"), "https://example-co.bamboohr.com/careers");
  assert.throws(() => normalizeBambooHrTenant("example.bamboohr.com"));
});

test("BambooHR validates complete listing count and filters U.S. before details", async () => {
  const detailIds: string[] = [];
  const listings = [
    { id: "1", jobOpeningName: "US Engineer", departmentLabel: "Engineering", employmentStatusLabel: "Full-Time", atsLocation: { country: "United States", state: "Texas", city: "Austin" } },
    { id: "2", jobOpeningName: "Canada Engineer", atsLocation: { country: "Canada", state: "Ontario", city: "Toronto" } },
  ];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/careers/list") return res.end(JSON.stringify({ meta: { totalCount: 2 }, result: listings }));
    const id = req.url?.match(/^\/careers\/(\d+)\/detail$/)?.[1];
    if (id) {
      detailIds.push(id);
      return res.end(JSON.stringify({ result: { jobOpening: { ...listings[0], description: "<p>Complete description. Salary $120,000 - $140,000.</p>", compensation: "$120,000 - $140,000", datePosted: "2026-08-01" } } }));
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchBambooHrJobs("example", { hostOverride: `http://127.0.0.1:${port}`, usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(detailIds, ["1"]);
    assert.deepEqual(jobs.map((job) => job.externalId), ["1"]);
    assert.equal(jobs[0].location, "Austin, Texas, United States");
    assert.equal(jobs[0].descriptionText, "Complete description. Salary $120,000 - $140,000.");
    assert.equal(jobs[0].postedAt, "2026-08-01");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
