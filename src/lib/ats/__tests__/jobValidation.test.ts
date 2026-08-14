import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractJsonLdJobPostings,
  filterRealJobs,
  isRealJobPosting,
  validateJobCandidate,
  validateNormalizedJob,
} from "@/lib/ats/jobValidation";
import type { NormalizedJob } from "@/types";

// --- The exact real-world false positives this module exists to fix (AGENTS.md §15) -------------

const KNOWN_NAV_FALSE_POSITIVES = ["Jobs By Business Area", "MyDisneyCareer", "French", "Privacy", "Benefits", "Locations", "Talent Network"];

test("validateJobCandidate: real-world navigation clutter is rejected as a plain nav link with no positive evidence", () => {
  for (const text of KNOWN_NAV_FALSE_POSITIVES) {
    const result = validateJobCandidate({ url: "https://example.com/careers/section", text });
    assert.equal(result.valid, false, `"${text}" should be rejected`);
  }
});

test("validateJobCandidate: an exact nav-phrase match is rejected even alongside a requisition-shaped URL", () => {
  const result = validateJobCandidate({ url: "https://example.com/careers/jobs/12345", text: "Careers" });
  assert.equal(result.valid, false);
  assert.ok(result.negativeSignals.includes("nav_text_exact_match"));
});

// --- Positive evidence: requisition-ID-shaped URL -------------------------------------------------

test("validateJobCandidate: a requisition-ID-shaped URL is accepted even with generic link text", () => {
  const result = validateJobCandidate({ url: "https://example.com/careers/jobs/software-engineer-482913", text: "Learn More" });
  assert.equal(result.valid, true);
  assert.ok(result.positiveSignals.includes("requisition_id_shaped_url"));
});

test("validateJobCandidate: a gh_jid query-param URL is accepted", () => {
  const result = validateJobCandidate({ url: "https://example.com/careers?gh_jid=7182934", text: "Details" });
  assert.equal(result.valid, true);
  assert.ok(result.positiveSignals.includes("requisition_id_shaped_url"));
});

test("validateJobCandidate: a Workday-style requisition number (R1559) in the URL is accepted", () => {
  const result = validateJobCandidate({ url: "https://example.com/job/Skokie-IL/Data-Engineer_R1559", text: "Data Engineer" });
  assert.equal(result.valid, true);
  assert.ok(result.positiveSignals.includes("requisition_id_shaped_url"));
});

test("validateJobCandidate: a plain marketing URL with no requisition shape gets no URL-based signal", () => {
  const result = validateJobCandidate({ url: "https://example.com/about-our-mission", text: "Our Mission" });
  assert.ok(!result.positiveSignals.includes("requisition_id_shaped_url"));
});

// --- Positive evidence: title + location (+ apply) combination -----------------------------------

test("validateJobCandidate: title + location + apply combo is accepted without a requisition-shaped URL", () => {
  const result = validateJobCandidate({
    url: "https://example.com/careers/listing/482913",
    text: "Senior Data Engineer",
    contextText: "New York, NY · Apply Now",
  });
  assert.equal(result.valid, true);
  assert.ok(result.positiveSignals.includes("title_location_apply_combo"));
});

test("validateJobCandidate: title + location without an apply word is still accepted (weaker combo)", () => {
  const result = validateJobCandidate({
    url: "https://example.com/careers/listing/482913",
    text: "Senior Data Engineer",
    contextText: "Remote",
  });
  assert.equal(result.valid, true);
  assert.ok(result.positiveSignals.includes("title_location_combo"));
});

test("validateJobCandidate: title-shaped text with NO location/apply/requisition-url context is rejected — uncertainty means no ingestion", () => {
  const result = validateJobCandidate({ url: "https://example.com/section/overview", text: "Company Overview Section" });
  assert.equal(result.valid, false);
  assert.ok(result.negativeSignals.includes("no_supporting_context"));
});

test("validateJobCandidate: a single bare word is never title-shaped even with location context", () => {
  const result = validateJobCandidate({ url: "https://example.com/x", text: "French", contextText: "Remote" });
  assert.equal(result.valid, false);
});

test("validateJobCandidate: reason string explains acceptance and rejection", () => {
  const accepted = validateJobCandidate({ url: "https://example.com/jobs/12345", text: "Anything" });
  assert.match(accepted.reason, /Accepted/);
  const rejected = validateJobCandidate({ url: "https://example.com/x", text: "Home" });
  assert.match(rejected.reason, /Rejected/);
});

// --- Shared Normalized Job Real-Job Validation Across ATS Adapters -------------------------------

function makeBaseNormalizedJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "12345",
    title: "Senior Software Engineer",
    location: "Austin, TX, USA",
    department: "Engineering",
    url: "https://recruiting.paylocity.com/Recruiting/Jobs/Details/12345",
    descriptionHtml: "<p>We are looking for a Senior Software Engineer with 5+ years TypeScript experience.</p>",
    descriptionText: "We are looking for a Senior Software Engineer with 5+ years TypeScript experience.",
    employmentType: "Full-Time",
    workplaceType: "Hybrid",
    salaryText: "$130,000 - $160,000",
    postedAt: "2026-08-01",
    raw: {},
    ...overrides,
  };
}

test("validateNormalizedJob: 1. 'Careers' is rejected as a non-job generic heading", () => {
  const job = makeBaseNormalizedJob({ title: "Careers" });
  const result = validateNormalizedJob(job);
  assert.equal(result.valid, false);
  assert.equal(isRealJobPosting(job), false);
  assert.match(result.reason, /generic_portal_heading/);
});

test("validateNormalizedJob: 2. 'Search Jobs' is rejected as a non-job search action", () => {
  const job = makeBaseNormalizedJob({ title: "Search Jobs" });
  const result = validateNormalizedJob(job);
  assert.equal(result.valid, false);
  assert.match(result.reason, /job_alerts_search/);
});

test("validateNormalizedJob: 3. 'Join Our Talent Community' is rejected as a pseudo-job", () => {
  const job = makeBaseNormalizedJob({ title: "Join Our Talent Community" });
  const result = validateNormalizedJob(job);
  assert.equal(result.valid, false);
  assert.match(result.reason, /talent_community/);
});

test("validateNormalizedJob: 4. 'Talent Community' and 'Lumitex Talent Community' are rejected", () => {
  const job1 = makeBaseNormalizedJob({ title: "Talent Community" });
  const job2 = makeBaseNormalizedJob({
    title: "Lumitex Talent Community",
    location: "Strongsville, OH, USA",
    externalId: "341533",
    url: "https://recruiting.paylocity.com/Recruiting/Jobs/Details/341533",
  });
  assert.equal(isRealJobPosting(job1), false);
  assert.equal(isRealJobPosting(job2), false);
  assert.match(validateNormalizedJob(job2).reason, /talent_community/);
});

test("validateNormalizedJob: 5. 'General Application' / 'General Consideration' are rejected", () => {
  const job1 = makeBaseNormalizedJob({ title: "General Application" });
  const job2 = makeBaseNormalizedJob({ title: "General Consideration" });
  const job3 = makeBaseNormalizedJob({ title: "General Interest" });
  const job4 = makeBaseNormalizedJob({ title: "Open Application" });
  assert.equal(isRealJobPosting(job1), false);
  assert.equal(isRealJobPosting(job2), false);
  assert.equal(isRealJobPosting(job3), false);
  assert.equal(isRealJobPosting(job4), false);
  assert.match(validateNormalizedJob(job1).reason, /general_application/);
});

test("validateNormalizedJob: 6. 'Future Opportunities' / 'Future Openings' are rejected", () => {
  const job1 = makeBaseNormalizedJob({ title: "Future Opportunities" });
  const job2 = makeBaseNormalizedJob({ title: "Future Opportunities at Haus" });
  const job3 = makeBaseNormalizedJob({ title: "Future Openings at TopQuadrant" });
  assert.equal(isRealJobPosting(job1), false);
  assert.equal(isRealJobPosting(job2), false);
  assert.equal(isRealJobPosting(job3), false);
  assert.match(validateNormalizedJob(job1).reason, /future_opportunities/);
});

test("validateNormalizedJob: 7. 'Job Alerts' / 'Email Alerts' are rejected", () => {
  const job1 = makeBaseNormalizedJob({ title: "Job Alerts" });
  const job2 = makeBaseNormalizedJob({ title: "Get Job Alerts" });
  assert.equal(isRealJobPosting(job1), false);
  assert.equal(isRealJobPosting(job2), false);
  assert.match(validateNormalizedJob(job1).reason, /job_alerts_search/);
});

test("validateNormalizedJob: 8. 'Talent Acquisition Partner' is accepted (real job false-positive protection)", () => {
  const job = makeBaseNormalizedJob({ title: "Talent Acquisition Partner" });
  const result = validateNormalizedJob(job);
  assert.equal(result.valid, true);
  assert.equal(isRealJobPosting(job), true);
});

test("validateNormalizedJob: 9. 'Community Manager' is accepted (real job false-positive protection)", () => {
  const job = makeBaseNormalizedJob({ title: "Community Manager" });
  const result = validateNormalizedJob(job);
  assert.equal(result.valid, true);
  assert.equal(isRealJobPosting(job), true);
});

test("validateNormalizedJob: 10. Genuine technical & professional jobs are accepted", () => {
  const jobs = [
    makeBaseNormalizedJob({ title: "Data Scientist - AI Solutions" }),
    makeBaseNormalizedJob({ title: "SQL Server DBA" }),
    makeBaseNormalizedJob({ title: "General Counsel" }),
    makeBaseNormalizedJob({ title: "General Manager" }),
    makeBaseNormalizedJob({ title: "HR Generalist" }),
    makeBaseNormalizedJob({ title: "Career Development Manager" }),
    makeBaseNormalizedJob({ title: "Staff Accountant" }),
  ];
  for (const job of jobs) {
    const result = validateNormalizedJob(job);
    assert.equal(result.valid, true, `"${job.title}" should be accepted`);
  }
});

test("validateNormalizedJob: 11. Missing/empty/whitespace-only title is rejected", () => {
  const job1 = makeBaseNormalizedJob({ title: "" });
  const job2 = makeBaseNormalizedJob({ title: "   " });
  const job3 = makeBaseNormalizedJob({ title: "A" });
  assert.equal(isRealJobPosting(job1), false);
  assert.equal(isRealJobPosting(job2), false);
  assert.equal(isRealJobPosting(job3), false);
});

test("validateNormalizedJob: 12. Obvious navigation-only description is rejected", () => {
  const job = makeBaseNormalizedJob({
    descriptionText: "Home About Us Privacy Terms Careers Contact",
    descriptionHtml: "<div>Home About Us Privacy Terms Careers Contact</div>",
  });
  const result = validateNormalizedJob(job);
  assert.equal(result.valid, false);
  assert.match(result.reason, /navigation_only_description/);
});

test("validateNormalizedJob: 13. Careers-root URL without posting identity is rejected", () => {
  const job1 = makeBaseNormalizedJob({ url: "https://example.com/careers" });
  const job2 = makeBaseNormalizedJob({ url: "https://example.com/jobs/" });
  const job3 = makeBaseNormalizedJob({ url: "https://example.com/" });
  assert.equal(isRealJobPosting(job1), false);
  assert.equal(isRealJobPosting(job2), false);
  assert.equal(isRealJobPosting(job3), false);
  assert.match(validateNormalizedJob(job1).reason, /careers_root_url_without_posting_identity/);
});

test("validateNormalizedJob: 14. Legitimate structured postings across different ATS adapters are accepted", () => {
  const greenhouseJob = makeBaseNormalizedJob({
    externalId: "4013947",
    title: "Senior Product Manager",
    url: "https://job-boards.greenhouse.io/acme/jobs/4013947",
  });
  const leverJob = makeBaseNormalizedJob({
    externalId: "00233828-cc45-49b5-855c-2aba5bc68f37",
    title: "Customer Support Specialist",
    url: "https://jobs.lever.co/acme/00233828-cc45-49b5-855c-2aba5bc68f37",
  });
  const ashbyJob = makeBaseNormalizedJob({
    externalId: "7263f6a6-7b05-4f75-a83f-c330882e1098",
    title: "Staff Infrastructure Engineer",
    url: "https://jobs.ashbyhq.com/acme/7263f6a6-7b05-4f75-a83f-c330882e1098",
  });
  const workdayJob = makeBaseNormalizedJob({
    externalId: "R-10294",
    title: "Financial Analyst",
    url: "https://acme.wd5.myworkdayjobs.com/Careers/job/Austin-TX/Financial-Analyst_R-10294",
  });
  const smartRecruitersJob = makeBaseNormalizedJob({
    externalId: "743999912345678",
    title: "Cloud Solutions Architect",
    url: "https://jobs.smartrecruiters.com/Acme/743999912345678-cloud-solutions-architect",
  });
  const paylocityJob = makeBaseNormalizedJob({
    externalId: "4408236",
    title: "Part-time Weekend SQL Server DBA",
    url: "https://recruiting.paylocity.com/Recruiting/Jobs/Details/4408236",
  });

  const jobs = [greenhouseJob, leverJob, ashbyJob, workdayJob, smartRecruitersJob, paylocityJob];
  for (const job of jobs) {
    assert.equal(isRealJobPosting(job), true);
  }
  const filtered = filterRealJobs([...jobs, makeBaseNormalizedJob({ title: "Join Our Talent Community" })]);
  assert.equal(filtered.length, jobs.length);
});

// --- JSON-LD JobPosting extraction ----------------------------------------------------------------

test("extractJsonLdJobPostings: a single JobPosting object is extracted with title/url/location/date", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org/","@type":"JobPosting","title":"Data Engineer","url":"https://example.com/jobs/1",
     "datePosted":"2026-08-01","jobLocation":{"address":{"addressLocality":"New York","addressRegion":"NY"}}}
  </script></head><body></body></html>`;
  const jobs = extractJsonLdJobPostings(html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "Data Engineer");
  assert.equal(jobs[0].url, "https://example.com/jobs/1");
  assert.equal(jobs[0].location, "New York, NY");
  assert.equal(jobs[0].datePosted, "2026-08-01");
});

test("extractJsonLdJobPostings: an array of JobPostings (listing page) is extracted in full", () => {
  const html = `<script type="application/ld+json">
    [{"@type":"JobPosting","title":"Engineer A","url":"https://example.com/a"},
     {"@type":"JobPosting","title":"Engineer B","url":"https://example.com/b"}]
  </script>`;
  const jobs = extractJsonLdJobPostings(html);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.title), ["Engineer A", "Engineer B"]);
});

test("extractJsonLdJobPostings: JobPostings nested under @graph are found", () => {
  const html = `<script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme"},{"@type":"JobPosting","title":"Engineer","url":"https://example.com/e"}]}
  </script>`;
  const jobs = extractJsonLdJobPostings(html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "Engineer");
});

test("extractJsonLdJobPostings: entries missing a url are dropped — an unlinkable job is never ingested", () => {
  const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"No URL Here"}</script>`;
  const jobs = extractJsonLdJobPostings(html);
  assert.equal(jobs.length, 0);
});

test("extractJsonLdJobPostings: malformed JSON in a script tag is skipped, not thrown", () => {
  const html = `<script type="application/ld+json">{ not valid json </script>`;
  assert.doesNotThrow(() => extractJsonLdJobPostings(html));
  assert.equal(extractJsonLdJobPostings(html).length, 0);
});

test("extractJsonLdJobPostings: non-JobPosting structured data (Organization, WebSite) is ignored", () => {
  const html = `<script type="application/ld+json">{"@type":"Organization","name":"Acme Corp","url":"https://example.com"}</script>`;
  assert.equal(extractJsonLdJobPostings(html).length, 0);
});

test("extractJsonLdJobPostings: no ld+json scripts on the page returns an empty array", () => {
  assert.deepEqual(extractJsonLdJobPostings("<html><body>plain page</body></html>"), []);
});
