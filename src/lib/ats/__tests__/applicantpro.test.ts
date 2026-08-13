import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalApplicantProUrl, fetchApplicantProJobs, normalizeApplicantProTenant } from "@/lib/ats/applicantpro";

test("ApplicantPro identity is tenant scoped", () => {
  assert.equal(normalizeApplicantProTenant("Example-Co"), "example-co");
  assert.equal(canonicalApplicantProUrl("example-co"), "https://example-co.applicantpro.com/jobs/");
  assert.throws(() => normalizeApplicantProTenant("www"));
});

test("ApplicantPro rejects incomplete count-matched listings", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/jobs/") return res.end(`<link rel="canonical" href="https://www.applicantpro.com/openings/example/jobs"><script>{ componentData: { organizationId: 1, domainId: 42, domainName: "applicantpro.com", subdomainName: "example" } }</script>`);
    if (req.url?.startsWith("/core/jobs/42")) { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ success: true, data: { jobCount: 2, jobs: [] } })); }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    await assert.rejects(fetchApplicantProJobs("example", { hostOverride: `http://127.0.0.1:${port}`, maxAttempts: 1 }), /incomplete/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("ApplicantPro filters structured locations before exact public details", async () => {
  const details: string[] = [];
  let origin = "";
  const server = http.createServer((req, res) => {
    if (req.url === "/jobs/") return res.end(`<link href="https://www.applicantpro.com/openings/example/jobs" rel="canonical"><script>{ componentData: { organizationId : 1, domainId : 42, getParams : {}, domainName : "applicantpro.com", subdomainName : "example" } }</script>`);
    if (req.url?.startsWith("/core/jobs/42?")) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: true, data: { jobCount: 2, jobs: [
        { id: 101, title: "US Engineer", subdomain: "example", siteId: 42, domainName: "applicantpro.com", jobUrl: `${origin}/jobs/101`, jobLocation: "Austin, TX, USA", orgTitle: "Engineering", employmentType: "Full Time" },
        { id: 202, title: "UK Engineer", subdomain: "example", siteId: 42, domainName: "applicantpro.com", jobUrl: `${origin}/jobs/202`, jobLocation: "London, UK", iso3: "GBR" },
      ] } }));
    }
    const id = req.url?.match(/^\/core\/jobs\/42\/(\d+)\/job-details$/)?.[1];
    if (id) {
      details.push(id);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: true, data: { id: Number(id), siteId: 42, title: "US Engineer", description: "<p>Complete ApplicantPro role.</p>", startDateRef: "2026-08-12" } }));
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
    const jobs = await fetchApplicantProJobs("example", { hostOverride: origin, usOnly: true, maxAttempts: 1 });
    assert.deepEqual(details, ["101"]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].descriptionText, "Complete ApplicantPro role.");
    assert.equal(jobs[0].department, "Engineering");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
