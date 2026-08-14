import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  canonicalPaylocityUrl,
  decodePaylocityToken,
  encodePaylocityToken,
  extractAssignedJson,
  extractPaylocityDetail,
  fetchPaylocityJobs,
} from "@/lib/ats/paylocity";
import { detectAtsFromUrlString } from "@/lib/ats/detect";

const identity = { companyId: "c41ecedc-a1f9-407e-9fba-86b6e144fb39", slug: "Kashiv-Biosciences-LLC" };

test("Paylocity identity round-trips and generates a stable board URL", () => {
  const token = encodePaylocityToken(identity);
  assert.deepEqual(decodePaylocityToken(token), identity);
  assert.equal(canonicalPaylocityUrl(token),
    "https://recruiting.paylocity.com/recruiting/jobs/All/c41ecedc-a1f9-407e-9fba-86b6e144fb39/Kashiv-Biosciences-LLC");
});

test("detectPaylocity handles canonical URLs, no-slug URLs, and rejects malformed/templates", () => {
  // Canonical with slug
  const d1 = detectAtsFromUrlString("https://recruiting.paylocity.com/recruiting/jobs/All/c41ecedc-a1f9-407e-9fba-86b6e144fb39/Kashiv-Biosciences-LLC");
  assert.equal(d1?.sourceType, "paylocity");
  assert.equal(d1?.atsBoardToken, "c41ecedc-a1f9-407e-9fba-86b6e144fb39|Kashiv-Biosciences-LLC");

  // No-slug variant
  const d2 = detectAtsFromUrlString("https://recruiting.paylocity.com/Recruiting/Jobs/All/e6921fab-47b2-4a4a-8cf3-258c62cfe89f");
  assert.equal(d2?.sourceType, "paylocity");
  assert.equal(d2?.atsBoardToken, "e6921fab-47b2-4a4a-8cf3-258c62cfe89f|_");
  assert.equal(d2?.canonicalSourceUrl, "https://recruiting.paylocity.com/recruiting/jobs/All/e6921fab-47b2-4a4a-8cf3-258c62cfe89f/_");

  // Rejects non-Paylocity or malformed
  assert.equal(detectAtsFromUrlString("https://recruiting.paylocity.com/"), null);
  assert.equal(detectAtsFromUrlString("https://recruiting.paylocity.com/recruiting/jobs/All/invalid-uuid/slug"), null);
  assert.equal(detectAtsFromUrlString("https://recruiting.paylocity.com/recruiting/jobs/All/${CONFIG.company}/slug"), null);
  assert.equal(detectAtsFromUrlString("https://other.com/recruiting/jobs/All/c41ecedc-a1f9-407e-9fba-86b6e144fb39/slug"), null);
});

test("assigned JSON parser handles braces and escaped quotes inside job descriptions", () => {
  const parsed = extractAssignedJson<{ Jobs: Array<{ Description: string }> }>(
    '<script>window.pageData = {"Jobs":[{"Description":"Use {data} and \\"quotes\\""}]};</script>',
    "window.pageData"
  );
  assert.equal(parsed.Jobs[0].Description, 'Use {data} and "quotes"');
});

test("extractPaylocityDetail extracts from JSON-LD when available", () => {
  const html = `
    <!DOCTYPE html>
    <html><body>
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "JobPosting",
          "title": "Software Engineer",
          "datePosted": "2026-08-01",
          "description": "<p>Full job description from JSON-LD schema.</p>"
        }
      </script>
    </body></html>
  `;
  const result = extractPaylocityDetail(html);
  assert.notEqual(result, null);
  assert.equal(result?.source, "JSON-LD");
  assert.equal(result?.title, "Software Engineer");
  assert.equal(result?.datePosted, "2026-08-01");
  assert.equal(result?.descriptionHtml, "<p>Full job description from JSON-LD schema.</p>");
});

test("extractPaylocityDetail extracts from structured HTML section headers when JSON-LD is absent", () => {
  const html = `
    <!DOCTYPE html>
    <html><body>
      <div class="citruslike-container job-preview" role="main">
        <div class="vertical-padding">
          <div class="job-listing-header">Job Type</div>
          <div>Full-Time</div>
        </div>
        <div class="job-listing-header">Description</div>
        <div><p>Detailed duties and responsibilities for the role.</p></div>
        <div class="job-listing-header">Requirements</div>
        <div data-bind="html: Job.Requirements"><p>Minimum 5 years experience in TypeScript and React.</p></div>
      </div>
    </body></html>
  `;
  const result = extractPaylocityDetail(html);
  assert.notEqual(result, null);
  assert.equal(result?.source, "HTML");
  assert.match(result?.descriptionHtml || "", /Detailed duties and responsibilities/);
  assert.match(result?.descriptionHtml || "", /Minimum 5 years experience/);
});

test("extractPaylocityDetail rejects pages with missing or short descriptions", () => {
  assert.equal(extractPaylocityDetail("<html><body><div>No description header here</div></body></html>"), null);
  assert.equal(extractPaylocityDetail('<html><body><div class="job-listing-header">Description</div><div>Short</div></body></html>'), null);
});

test("fetchPaylocityJobs rejects duplicate JobId on the board", async () => {
  const jobs = [
    { JobId: 101, JobTitle: "Engineer 1", JobLocation: { City: "Austin", State: "TX", Country: "USA" } },
    { JobId: 101, JobTitle: "Engineer 1 Duplicate", JobLocation: { City: "Austin", State: "TX", Country: "USA" } },
  ];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<script>window.pageData = ${JSON.stringify({ Jobs: jobs, ModuleId: "123" })};</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await assert.rejects(
      async () => {
        await fetchPaylocityJobs(encodePaylocityToken(identity), {
          hostOverride: `http://127.0.0.1:${port}`,
          maxAttempts: 1,
        });
      },
      /duplicate job ID 101/
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchPaylocityJobs handles empty boards cleanly", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<script>window.pageData = ${JSON.stringify({ Jobs: [], ModuleId: "123" })};</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const results = await fetchPaylocityJobs(encodePaylocityToken(identity), {
      hostOverride: `http://127.0.0.1:${port}`,
      maxAttempts: 1,
    });
    assert.deepEqual(results, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Paylocity filters the complete listing before fetching full details", async () => {
  const detailIds: string[] = [];
  const jobs = [
    { JobId: 101, JobTitle: "US Engineer", PublishedDate: "2026-08-01", HiringDepartment: "Engineering", JobLocation: { City: "Austin", State: "TX", Country: "USA" }, IsRemote: false },
    { JobId: 102, JobTitle: "Canada Engineer", PublishedDate: "2026-08-01", JobLocation: { City: "Toronto", State: "ON", Country: "Canada" }, IsRemote: false },
    { JobId: 103, JobTitle: "Remote US Engineer", PublishedDate: "2026-08-02", JobLocation: { Country: "USA" }, IsRemote: true },
    { JobId: 104, JobTitle: "Bare Remote Engineer", PublishedDate: "2026-08-02", JobLocation: null, IsRemote: true },
  ];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    const detail = req.url?.match(/\/Recruiting\/Jobs\/Details\/(\d+)/)?.[1];
    if (detail) {
      detailIds.push(detail);
      if (detail === "101") {
        // Return JSON-LD
        res.end(`<script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org", "@type": "JobPosting", title: "US Engineer",
          datePosted: "2026-08-03", description: `<p>Full description for 101. Salary $120,000 - $140,000 per year.</p>`,
        })}</script>`);
      } else {
        // Return HTML section headers
        res.end(`
          <div class="citruslike-container job-preview">
            <div class="job-listing-header">Description</div>
            <div><p>Full description for ${detail} via HTML container.</p></div>
          </div>
        `);
      }
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
    // 101 (US) and 103 (Remote US) survive; 102 (Canada) and 104 (Bare Remote -> UNKNOWN) are excluded
    assert.deepEqual(detailIds.sort(), ["101", "103"]);
    assert.deepEqual(results.map((job) => job.externalId), ["101", "103"]);
    assert.equal(results[0].descriptionText, "Full description for 101. Salary $120,000 - $140,000 per year.");
    assert.equal(results[0].salaryText, "$120,000 - $140,000");
    assert.equal(results[1].location, "Remote - United States");
    assert.equal(results[1].descriptionText, "Full description for 103 via HTML container.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
