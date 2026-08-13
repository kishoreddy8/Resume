import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  canonicalOracleRecruitingCloudUrl,
  decodeOracleRecruitingCloudToken,
  encodeOracleRecruitingCloudToken,
  fetchOracleRecruitingCloudJobs,
} from "@/lib/ats/oracleRecruitingCloud";

test("Oracle Recruiting Cloud identity preserves exact host and site", () => {
  const token = encodeOracleRecruitingCloudToken({ host: "EDEL.fa.us2.oraclecloud.com", site: "CX_2001" });
  assert.equal(token, "edel.fa.us2.oraclecloud.com|CX_2001");
  assert.deepEqual(decodeOracleRecruitingCloudToken(token), { host: "edel.fa.us2.oraclecloud.com", site: "CX_2001" });
  assert.equal(canonicalOracleRecruitingCloudUrl(token), "https://edel.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2001");
  assert.throws(() => encodeOracleRecruitingCloudToken({ host: "oraclecloud.com", site: "CX" }));
});

test("Oracle Recruiting Cloud validates complete listing and filters U.S. before details", async () => {
  const detailIds: string[] = [];
  const listings = [
    { Id: "101", Title: "US Engineer", PostedDate: "2026-08-01", PrimaryLocation: "Austin, TX", PrimaryLocationCountry: "US", JobSchedule: "Full time" },
    { Id: "102", Title: "Germany Engineer", PrimaryLocation: "Frankfurt, Hessen, Germany", PrimaryLocationCountry: "DE" },
  ];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.endsWith("/recruitingCEJobRequisitions")) {
      return res.end(JSON.stringify({ items: [{ Offset: 0, Limit: 25, TotalJobsCount: 2, requisitionList: listings }], count: 1, hasMore: false }));
    }
    if (url.pathname.endsWith("/recruitingCEJobRequisitionDetails")) {
      const id = url.searchParams.get("finder")?.match(/Id=([^,]+)/)?.[1] ?? "";
      detailIds.push(id);
      return res.end(JSON.stringify({ items: [{ ...listings[0], ExternalDescriptionStr: "<p>Complete role. Salary $120,000 - $140,000.</p>", ExternalPostedStartDate: "2026-08-01T00:00:00+00:00", WorkplaceType: "Hybrid" }], count: 1, hasMore: false }));
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchOracleRecruitingCloudJobs("edel.fa.us2.oraclecloud.com|CX_2001", {
      hostOverride: `http://127.0.0.1:${port}`,
      usOnly: true,
      maxJobs: 3,
      maxAttempts: 1,
    });
    assert.deepEqual(detailIds, ["101"]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].location, "Austin, TX, United States");
    assert.equal(jobs[0].descriptionText, "Complete role. Salary $120,000 - $140,000.");
    assert.equal(jobs[0].salaryText, "$120,000 - $140,000");
    assert.equal(jobs[0].postedAt, "2026-08-01T00:00:00+00:00");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
