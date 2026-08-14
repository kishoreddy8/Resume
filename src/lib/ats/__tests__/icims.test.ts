import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalIcimsUrl, fetchIcimsJobs, normalizeIcimsHost, parseIcimsListings } from "@/lib/ats/icims";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import { isRealJobPosting, validateNormalizedJob } from "@/lib/ats/jobValidation";
import type { NormalizedJob } from "@/types";

function card(id: string, title: string, location: string, pathSuffix = "job"): string {
  return `<li class="iCIMS_JobCardItem">
    <a href="https://careers-example.icims.com/jobs/${id}/${title.toLowerCase().replace(/\s+/g, "-")}/${pathSuffix}?in_iframe=1"><h3>${title}</h3></a>
    <dl class="iCIMS_JobHeaderGroup">
      <div><dt class="iCIMS_JobHeaderField">Category</dt><dd class="iCIMS_JobHeaderData"><span>Engineering</span></dd></div>
      <div><dt class="iCIMS_JobHeaderField"><span class="sr-only field-label">Job Locations</span></dt><dd class="iCIMS_JobHeaderData"><span>${location}</span></dd></div>
      <div><dt class="iCIMS_JobHeaderField">Position Type</dt><dd class="iCIMS_JobHeaderData"><span>Full-Time</span></dd></div>
    </dl>
  </li>`;
}

function page(current: number, total: number, cards: string): string {
  return `<h2>Search Results Page ${current} of ${total}</h2><ul class="iCIMS_JobsTable">${cards}</ul>`;
}

test("iCIMS tenant identity is host-scoped and canonical", () => {
  assert.equal(normalizeIcimsHost("Careers-Example.ICIMS.com"), "careers-example.icims.com");
  assert.equal(normalizeIcimsHost("uscareers-msci.icims.com"), "uscareers-msci.icims.com");
  assert.equal(canonicalIcimsUrl("careers-example.icims.com"), "https://careers-example.icims.com/jobs/search");
  assert.throws(() => normalizeIcimsHost("www.icims.com"));
  assert.throws(() => normalizeIcimsHost("icims.com.evil.example"));
  assert.throws(() => normalizeIcimsHost("https://careers-example.icims.com"));
  assert.throws(() => normalizeIcimsHost(""));
});

test("detectAtsFromUrlString strictly detects iCIMS portals across root and search paths", () => {
  const root = detectAtsFromUrlString("https://careers-fastenterprises.icims.com/");
  assert.equal(root?.sourceType, "icims");
  assert.equal(root?.atsBoardToken, "careers-fastenterprises.icims.com");
  assert.equal(root?.canonicalSourceUrl, "https://careers-fastenterprises.icims.com/jobs/search");

  const search = detectAtsFromUrlString("https://uscareers-msci.icims.com/jobs/search?ss=1");
  assert.equal(search?.sourceType, "icims");
  assert.equal(search?.atsBoardToken, "uscareers-msci.icims.com");

  const bare = detectAtsFromUrlString("https://careers-chenega.icims.com");
  assert.equal(bare?.sourceType, "icims");
  assert.equal(bare?.atsBoardToken, "careers-chenega.icims.com");

  // Rejects vendor website, privacy notices, and arbitrary paths
  assert.equal(detectAtsFromUrlString("https://www.icims.com/products/career-site-builder/"), null);
  assert.equal(detectAtsFromUrlString("https://www.icims.com/legal/privacy-notice-website/"), null);
  assert.equal(detectAtsFromUrlString("https://careers.example.com/other-ats"), null);
});

test("iCIMS listing parser reads stable IDs, fields, and total pages", () => {
  const parsed = parseIcimsListings(page(1, 3, card("20089", "Senior Engineer", "US-TX-Austin")));
  assert.equal(parsed.totalPages, 3);
  assert.deepEqual(parsed.jobs[0], {
    id: "20089",
    title: "Senior Engineer",
    path: "/jobs/20089/senior-engineer/job",
    location: "US-TX-Austin",
    department: "Engineering",
    employmentType: "Full-Time",
  });
});

test("iCIMS listing parser rejects duplicate requisition cards on the same page", () => {
  const duplicates = card("3001", "Software Engineer", "New York, NY") + card("3001", "Software Engineer (Duplicate)", "New York, NY");
  const parsed = parseIcimsListings(page(1, 1, duplicates));
  assert.equal(parsed.jobs.length, 1);
  assert.equal(parsed.jobs[0].id, "3001");
  assert.equal(parsed.jobs[0].title, "Software Engineer");
});

test("iCIMS listing parser handles valid empty boards gracefully", () => {
  const emptyHtml = `<div class="iCIMS_JobListing"><p>No open jobs were found matching your criteria.</p></div>`;
  const parsed = parseIcimsListings(emptyHtml);
  assert.equal(parsed.jobs.length, 0);
  assert.equal(parsed.totalPages, 1);
});

test("iCIMS exhausts listing pages, filters to U.S. before details, and returns full jobs", async () => {
  const detailIds: string[] = [];
  const listingPages: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    const detailId = req.url?.match(/^\/jobs\/(\d+)\//)?.[1];
    if (detailId) {
      detailIds.push(detailId);
      res.end(`<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "JobPosting",
        title: detailId === "101" ? "US Engineer" : "Remote US Engineer",
        description: `<h2>Overview</h2><p>Complete job description ${detailId}. Salary $120,000 - $140,000 per year.</p>`,
        datePosted: "2026-08-01T00:00:00.000Z",
        employmentType: "FULL_TIME",
        jobLocation: [{ address: { addressLocality: "Austin", addressRegion: "TX", addressCountry: "US" } }],
      })}</script>`);
      return;
    }
    const pageIndex = Number(new URL(req.url ?? "/", "http://fixture").searchParams.get("pr") ?? "0");
    listingPages.push(String(pageIndex));
    res.end(pageIndex === 0
      ? page(1, 2, card("101", "US Engineer", "US-TX-Austin") + card("102", "Canada Engineer", "Toronto, ON, Canada"))
      : page(2, 2, card("103", "Remote US Engineer", "US-Remote")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchIcimsJobs("careers-example.icims.com", {
      hostOverride: `http://127.0.0.1:${port}`,
      usOnly: true,
      maxJobs: 3,
      maxAttempts: 1,
    });
    assert.deepEqual(listingPages, ["0", "1"]);
    assert.deepEqual(detailIds.sort(), ["101", "103"]);
    assert.deepEqual(jobs.map((job) => job.externalId), ["101", "103"]);
    assert.equal(jobs[0].descriptionText, "Overview Complete job description 101. Salary $120,000 - $140,000 per year.");
    assert.equal(jobs[0].salaryText, "$120,000 - $140,000");
    assert.equal(jobs[0].postedAt, "2026-08-01T00:00:00.000Z");
    assert.equal(jobs[0].location, "Austin, TX, US");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("iCIMS throws descriptive error if JobPosting detail description is missing", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (_req.url?.includes("/jobs/501/")) {
      res.end(`<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "JobPosting",
        title: "No Desc Job",
        description: "",
      })}</script>`);
      return;
    }
    res.end(page(1, 1, card("501", "No Desc Job", "Denver, CO, US")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await assert.rejects(
      () => fetchIcimsJobs("careers-nodesc.icims.com", {
        hostOverride: `http://127.0.0.1:${port}`,
        usOnly: false,
        maxJobs: 1,
        maxAttempts: 1,
      }),
      /iCIMS job 501 has no full JobPosting description/
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("shared real-job validation correctly filters iCIMS jobs and pseudo-jobs", () => {
  const realJob: NormalizedJob = {
    externalId: "4879",
    title: "Platform Engineer",
    location: "New York, NY, US",
    department: "Engineering",
    url: "https://uscareers-msci.icims.com/jobs/4879/platform-engineer/job",
    descriptionHtml: "<p>We are seeking a Platform Engineer...</p>",
    descriptionText: "We are seeking a Platform Engineer to manage Kubernetes and Linux systems.",
    employmentType: "FULL_TIME",
    workplaceType: null,
    salaryText: "$91,000 - $118,000 / year",
    postedAt: "2026-04-03T04:00:00.000Z",
    raw: null,
  };

  assert.equal(isRealJobPosting(realJob), true);
  const realVal = validateNormalizedJob(realJob);
  assert.equal(realVal.valid, true);

  const pseudoCommunity: NormalizedJob = {
    ...realJob,
    externalId: "9901",
    title: "Join Our Talent Community",
    url: "https://careers-example.icims.com/jobs/9901/join-our-talent-community/job",
  };
  assert.equal(isRealJobPosting(pseudoCommunity), false);
  const pseudoVal = validateNormalizedJob(pseudoCommunity);
  assert.equal(pseudoVal.valid, false);
  assert.equal(pseudoVal.negativeSignals.includes("pseudo_job_title:talent_community"), true);

  const pseudoSearch: NormalizedJob = {
    ...realJob,
    externalId: "9902",
    title: "Search Jobs",
    url: "https://careers-example.icims.com/jobs/search",
  };
  assert.equal(isRealJobPosting(pseudoSearch), false);

  const pseudoFuture: NormalizedJob = {
    ...realJob,
    externalId: "9903",
    title: "Future Opportunities at Fast Enterprises",
  };
  assert.equal(isRealJobPosting(pseudoFuture), false);

  const legitimateTalentRole: NormalizedJob = {
    ...realJob,
    externalId: "41780",
    title: "Talent Acquisition Partner",
  };
  assert.equal(isRealJobPosting(legitimateTalentRole), true);

  const legitimateCommunityRole: NormalizedJob = {
    ...realJob,
    externalId: "41781",
    title: "Community Manager",
  };
  assert.equal(isRealJobPosting(legitimateCommunityRole), true);
});
