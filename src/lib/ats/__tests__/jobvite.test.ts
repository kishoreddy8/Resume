import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalJobviteUrl, fetchJobviteJobs, normalizeJobviteTenant } from "@/lib/ats/jobvite";

test("Jobvite identity is careers-site tenant scoped", () => {
  assert.equal(normalizeJobviteTenant("Example_Careers"), "example_careers");
  assert.equal(canonicalJobviteUrl("example"), "https://jobs.jobvite.com/example/jobs");
  assert.throws(() => normalizeJobviteTenant("your-careersite-name"));
});

test("Jobvite parses the complete list, filters U.S. before details, and verifies detail identity", async () => {
  const details: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/example/jobs") {
      return res.end(`<body class="jv-page-jobs"><h3>Engineering</h3><table class="jv-job-list">
        <tr><td class="jv-job-list-name"><a href="/example/job/aaaaaaaa">Canada Role</a></td><td class="jv-job-list-location">Toronto, Canada</td></tr>
        <tr><td class="jv-job-list-name"><a href="/example/job/bbbbbbbb">US Engineer</a></td><td class="jv-job-list-location">Austin, TX</td></tr>
      </table></body>`);
    }
    const id = req.url?.match(/\/example\/job\/([a-z]{8})/)?.[1];
    if (id) {
      details.push(id);
      return res.end(`<script type="application/ld+json">${JSON.stringify({
        "@type": "JobPosting", identifier: id, title: "US Engineer", industry: "Engineering",
        description: "<p>Complete role. Salary $120,000.</p>", datePosted: "2026-08-01", employmentType: "Full-time",
      })}</script>`);
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchJobviteJobs("example", { hostOverride: `http://127.0.0.1:${port}`, usOnly: true, maxAttempts: 1 });
    assert.deepEqual(details, ["bbbbbbbb"]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].descriptionText, "Complete role. Salary $120,000.");
    assert.equal(jobs[0].department, "Engineering");
    assert.equal(jobs[0].postedAt, "2026-08-01");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Jobvite accepts legacy detail HTML only when its embedded job ID matches", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/example/jobs") {
      return res.end(`<body class="jv-page-jobs"><table class="jv-job-list"><tr>
        <td class="jv-job-list-name"><a href="/example/job/cccccccc">Legacy Engineer</a></td>
        <td class="jv-job-list-location">Boston, MA</td></tr></table></body>`);
    }
    if (req.url === "/example/job/cccccccc") {
      return res.end(`<script>function getJobId() { return 'cccccccc'; }</script>
        <div class="jv-job-detail-description"><h3>Description</h3><div><p>Complete legacy role.</p></div></div>`);
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchJobviteJobs("example", { hostOverride: `http://127.0.0.1:${port}`, usOnly: true, maxAttempts: 1 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].descriptionText, "Description Complete legacy role.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
