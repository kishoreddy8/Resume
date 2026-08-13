import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalWorkableUrl, fetchWorkableJobs, normalizeWorkableSlug } from "@/lib/ats/workable";

test("Workable identity is account-slug scoped", () => {
  assert.equal(normalizeWorkableSlug("Example-Co"), "example-co");
  assert.equal(canonicalWorkableUrl("example-co"), "https://apply.workable.com/example-co/");
  assert.throws(() => normalizeWorkableSlug("j"));
});

test("Workable follows opaque pagination and filters U.S. before details", async () => {
  const listBodies: unknown[] = [];
  const detailIds: string[] = [];
  const canada = { id: 1, shortcode: "CANADA1", title: "Canada Engineer", location: { display: "Toronto, Ontario, Canada", country: "Canada", countryCode: "CA" } };
  const us = { id: 2, shortcode: "US1", title: "US Engineer", location: { display: "Austin, Texas, United States", country: "United States", countryCode: "US" }, published: "2026-08-01T00:00:00.000Z", type: "full", workplace: "hybrid" };
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url?.endsWith("/api/v3/accounts/example/jobs")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        listBodies.push(parsed);
        res.end(JSON.stringify(parsed.token
          ? { total: 2, nextPage: null, results: [us] }
          : { total: 2, nextPage: "opaque-page-2", results: [canada] }));
      });
      return;
    }
    const id = req.url?.match(/\/api\/v2\/accounts\/example\/jobs\/([^/?]+)/)?.[1];
    if (id) {
      detailIds.push(id);
      return res.end(JSON.stringify({ ...us, description: "<p>Complete role.</p>", requirements: "<p>Salary $120,000 - $140,000.</p>" }));
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchWorkableJobs("example", {
      hostOverride: `http://127.0.0.1:${port}`,
      usOnly: true,
      maxJobs: 3,
      maxAttempts: 1,
    });
    assert.deepEqual(listBodies, [{}, { query: "", token: "opaque-page-2" }]);
    assert.deepEqual(detailIds, ["US1"]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].descriptionText, "Complete role. Salary $120,000 - $140,000.");
    assert.equal(jobs[0].salaryText, "$120,000 - $140,000");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
