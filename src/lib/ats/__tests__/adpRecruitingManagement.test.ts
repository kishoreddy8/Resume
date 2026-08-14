import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalAdpRmUrl, fetchAdpRmJobs, normalizeAdpRmToken } from "@/lib/ats/adpRecruitingManagement";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import { isRealJobPosting } from "@/lib/ats/jobValidation";
import type { NormalizedJob } from "@/types";

const token = "woodmark|8a85520f-3ae2-4ffc-bdcc-ed9627cf28ee|G38EETAC9W8ZZ87W|woodmark1";

test("ADP RM identity is exact and canonical", () => {
  assert.equal(normalizeAdpRmToken(token), token);
  const url = new URL(canonicalAdpRmUrl(token));
  assert.equal(url.pathname, "/woodmark");
  assert.equal(url.searchParams.get("siteId"), "8a85520f-3ae2-4ffc-bdcc-ed9627cf28ee");
  assert.throws(() => normalizeAdpRmToken("woodmark|bad|G38EETAC9W8ZZ87W|woodmark1"));
});

test("detectAtsFromUrlString detects ADP RM from full query URL and slug-based URL", () => {
  const full = detectAtsFromUrlString("https://myjobs.adp.com/woodmark?siteId=8a85520f-3ae2-4ffc-bdcc-ed9627cf28ee&orgoid=G38EETAC9W8ZZ87W&clientId=woodmark1");
  assert.equal(full?.sourceType, "adp_rm");
  assert.equal(full?.atsBoardToken, token);

  const slugOnly = detectAtsFromUrlString("https://myjobs.adp.com/auduboncorporatecareers/cx");
  assert.equal(slugOnly?.sourceType, "adp_rm");
  assert.equal(slugOnly?.atsBoardToken, "auduboncorporatecareers");
  assert.equal(slugOnly?.canonicalSourceUrl, "https://myjobs.adp.com/auduboncorporatecareers");

  // Rejects invalid system paths
  assert.equal(detectAtsFromUrlString("https://myjobs.adp.com/public/staffing"), null);
  assert.equal(detectAtsFromUrlString("https://myjobs.adp.com/api/v1"), null);
});

test("ADP RM resolves single-slug tokens via career-site lookup and extracts jobs", async () => {
  const jobs = [
    {
      reqId: "6001",
      publishedJobTitle: "Senior Project Engineer",
      jobDescription: "<p>Lead engineering projects.</p>",
      careerSiteDomains: ["auduboncorporatecareers"],
      requisitionLocations: [{
        address: { cityName: "Houston", countrySubdivisionLevel1: { codeValue: "TX" }, country: { codeValue: "USA" } },
      }],
    },
    {
      reqId: "6002",
      publishedJobTitle: "International Specialist",
      jobDescription: "<p>Work in Germany.</p>",
      careerSiteDomains: ["auduboncorporatecareers"],
      requisitionLocations: [{
        address: { cityName: "Munich", country: { codeValue: "DEU" } },
      }],
    },
  ];

  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/public/staffing/v1/career-site/auduboncorporatecareers") {
      return res.end(JSON.stringify({
        id: "ad4f2121-56eb-4475-97c2-bec419de65d6",
        domain: "auduboncorporatecareers",
        orgoid: "0D9ZMBGKGGC00F1X",
        isiClientId: "auduboneng",
        active: true,
        isMyJobsEnabled: true,
        myJobsToken: "test-token-123",
      }));
    }
    return res.end(JSON.stringify({ count: jobs.length, jobRequisitions: jobs }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const result = await fetchAdpRmJobs("auduboncorporatecareers", {
      myJobsOriginOverride: origin,
      apiOriginOverride: origin,
      usOnly: true,
      maxJobs: 3,
      maxAttempts: 1,
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].externalId, "6001");
    assert.equal(result[0].title, "Senior Project Engineer");
    assert.equal(result[0].location, "Houston, TX, USA");
    assert.match(result[0].descriptionText ?? "", /Lead engineering projects/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("ADP RM exhausts the count and filters complete jobs to U.S. scope", async () => {
  const jobs = Array.from({ length: 101 }, (_, index) => ({
    reqId: String(5000 + index),
    publishedJobTitle: `Engineer ${index}`,
    jobDescription: `<p>Complete description ${index}</p>`,
    careerSiteDomains: ["woodmark"],
    requisitionLocations: [{
      address: index === 100
        ? { cityName: "Austin", countrySubdivisionLevel1: { codeValue: "TX" }, country: { codeValue: "USA" } }
        : { cityName: "Berlin", country: { codeValue: "DEU" } },
    }],
  }));
  const skips: number[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/public/staffing/v1/career-site/woodmark") {
      return res.end(JSON.stringify({
        id: "8a85520f-3ae2-4ffc-bdcc-ed9627cf28ee",
        domain: "woodmark",
        orgoid: "G38EETAC9W8ZZ87W",
        isiClientId: "woodmark1",
        active: true,
        isMyJobsEnabled: true,
        myJobsToken: "short-lived-token",
      }));
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const skip = Number(url.searchParams.get("$skip") ?? "0");
    skips.push(skip);
    return res.end(JSON.stringify({ count: jobs.length, jobRequisitions: jobs.slice(skip, skip + 100) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const result = await fetchAdpRmJobs(token, {
      myJobsOriginOverride: origin,
      apiOriginOverride: origin,
      usOnly: true,
      maxJobs: 3,
      maxAttempts: 1,
    });
    assert.deepEqual(skips, [0, 100]);
    assert.deepEqual(result.map((job) => job.externalId), ["5100"]);
    assert.match(result[0].descriptionText ?? "", /Complete description 100/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("shared real-job validation filters ADP RM jobs correctly", () => {
  const realJob: NormalizedJob = {
    externalId: "50012345",
    title: "Senior Project Engineer",
    location: "Houston, TX, USA",
    department: null,
    url: "https://myjobs.adp.com/auduboncorporatecareers/cx/job-details?reqId=50012345",
    descriptionHtml: "<p>Manage industrial engineering projects.</p>",
    descriptionText: "Manage industrial engineering projects.",
    employmentType: "Full Time",
    workplaceType: null,
    salaryText: null,
    postedAt: "2026-08-10T00:00:00Z",
    raw: null,
  };

  assert.equal(isRealJobPosting(realJob), true);

  const pseudoJob: NormalizedJob = {
    ...realJob,
    title: "Join Our Talent Community",
  };
  assert.equal(isRealJobPosting(pseudoJob), false);

  const talentRole: NormalizedJob = {
    ...realJob,
    title: "Talent Acquisition Partner",
  };
  assert.equal(isRealJobPosting(talentRole), true);
});
