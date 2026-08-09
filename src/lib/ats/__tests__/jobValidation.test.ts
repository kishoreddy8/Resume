import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJsonLdJobPostings, validateJobCandidate } from "@/lib/ats/jobValidation";

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
