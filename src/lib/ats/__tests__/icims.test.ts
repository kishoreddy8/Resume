import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalIcimsUrl, fetchIcimsJobs, normalizeIcimsHost, parseIcimsListings } from "@/lib/ats/icims";

function card(id: string, title: string, location: string): string {
  return `<li class="iCIMS_JobCardItem">
    <a href="https://careers-example.icims.com/jobs/${id}/${title.toLowerCase().replace(/\s+/g, "-")}/job?in_iframe=1"><h3>${title}</h3></a>
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
  assert.equal(canonicalIcimsUrl("careers-example.icims.com"), "https://careers-example.icims.com/jobs/search");
  assert.throws(() => normalizeIcimsHost("www.icims.com"));
  assert.throws(() => normalizeIcimsHost("icims.com.evil.example"));
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
