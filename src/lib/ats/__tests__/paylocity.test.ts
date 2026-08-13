import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  canonicalPaylocityUrl,
  decodePaylocityToken,
  encodePaylocityToken,
  extractAssignedJson,
  fetchPaylocityJobs,
} from "@/lib/ats/paylocity";

const identity = { companyId: "c41ecedc-a1f9-407e-9fba-86b6e144fb39", slug: "Kashiv-Biosciences-LLC" };

test("Paylocity identity round-trips and generates a stable board URL", () => {
  const token = encodePaylocityToken(identity);
  assert.deepEqual(decodePaylocityToken(token), identity);
  assert.equal(canonicalPaylocityUrl(token),
    "https://recruiting.paylocity.com/recruiting/jobs/All/c41ecedc-a1f9-407e-9fba-86b6e144fb39/Kashiv-Biosciences-LLC");
});

test("assigned JSON parser handles braces and escaped quotes inside job descriptions", () => {
  const parsed = extractAssignedJson<{ Jobs: Array<{ Description: string }> }>(
    '<script>window.pageData = {"Jobs":[{"Description":"Use {data} and \\"quotes\\""}]};</script>',
    "window.pageData"
  );
  assert.equal(parsed.Jobs[0].Description, 'Use {data} and "quotes"');
});

test("Paylocity filters the complete listing before fetching full details", async () => {
  const detailIds: string[] = [];
  const jobs = [
    { JobId: 101, JobTitle: "US Engineer", PublishedDate: "2026-08-01", HiringDepartment: "Engineering", JobLocation: { City: "Austin", State: "TX", Country: "USA" }, IsRemote: false },
    { JobId: 102, JobTitle: "Canada Engineer", PublishedDate: "2026-08-01", JobLocation: { City: "Toronto", State: "ON", Country: "Canada" }, IsRemote: false },
    { JobId: 103, JobTitle: "Remote US Engineer", PublishedDate: "2026-08-02", JobLocation: { Country: "USA" }, IsRemote: true },
  ];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    const detail = req.url?.match(/\/Recruiting\/Jobs\/Details\/(\d+)/)?.[1];
    if (detail) {
      detailIds.push(detail);
      res.end(`<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org", "@type": "JobPosting", title: detail === "101" ? "US Engineer" : "Remote US Engineer",
        datePosted: "2026-08-03", description: `<p>Full description for ${detail}. Salary $120,000 - $140,000 per year.</p>`,
      })}</script>`);
      return;
    }
    res.end(`<script>window.pageData = ${JSON.stringify({ Jobs: jobs, ModuleId: "123" })};</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const results = await fetchPaylocityJobs(encodePaylocityToken(identity), {
      hostOverride: `http://127.0.0.1:${port}`,
      usOnly: true,
      maxJobs: 2,
      maxAttempts: 1,
    });
    assert.deepEqual(detailIds.sort(), ["101", "103"]);
    assert.deepEqual(results.map((job) => job.externalId), ["101", "103"]);
    assert.equal(results[0].descriptionText, "Full description for 101. Salary $120,000 - $140,000 per year.");
    assert.equal(results[0].salaryText, "$120,000 - $140,000");
    assert.equal(results[1].location, "Remote - United States");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
