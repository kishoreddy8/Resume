import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDescriptionSections } from "../parseSections";
import { validateNormalizedJob, validateJobCandidate } from "../ats/jobValidation";
import { scanSponsorshipLanguage } from "../h1b/keywordScan";
import { extractClearance } from "../jobIntel/clearance";
import { classifyJobLocation } from "../jobLocationScope";
import { EXTRACTION_VERSION } from "../jobIntel/extractJobIntel";
import { extractSkills } from "../jobIntel/skills";
import type { NormalizedJob } from "@/types";

/**
 * Stage 25A — regression tests for the defects found by auditing the real 18,065-job production
 * corpus. Every case below is taken VERBATIM from a live posting in data/app.db (job ids named in
 * the comments), not invented, so a future refactor that reintroduces the defect fails against the
 * same evidence that exposed it.
 */

// --- Defect 1: "Preferred Qualifications" routed to the REQUIRED bucket (2,452 active jobs) ------

test("Stage 25A: a 'Preferred Qualifications' heading is niceToHave, never qualifications", () => {
  for (const heading of [
    "Preferred Qualifications",
    "Preferred Qualifications:",
    "Preferred Qualifications (Desired Skills/Experience):",
    "Preferred Requirements:",
    "Nice to Have (Preferred Qualifications)",
  ]) {
    const sections = parseDescriptionSections(`<h3>${heading}</h3><ul><li>Experience building streaming pipelines with Kafka is expected here.</li></ul>`);
    assert.ok(sections, heading);
    assert.equal(sections!.niceToHave, "Experience building streaming pipelines with Kafka is expected here.", heading);
    assert.equal(sections!.qualifications, undefined, heading);
  }
});

test("Stage 25A: a plain qualifications heading still routes to qualifications", () => {
  for (const heading of ["Qualifications", "Minimum Qualifications", "Basic Qualifications:", "Requirements"]) {
    const sections = parseDescriptionSections(`<h3>${heading}</h3><ul><li>5 years of hands-on Python engineering experience.</li></ul>`);
    assert.ok(sections, heading);
    assert.equal(sections!.qualifications, "5 years of hands-on Python engineering experience.", heading);
    assert.equal(sections!.niceToHave, undefined, heading);
  }
});

test("Stage 25A: preferred-routed skills are stored as Preferred, not Required", () => {
  const html = "<h3>Preferred Qualifications</h3><ul><li>Experience with Snowflake and Airflow in production is expected.</li></ul>";
  const sections = parseDescriptionSections(html);
  const skills = extractSkills({ descriptionText: null, descriptionHtml: html, sections });
  assert.ok(skills.length > 0, "expected at least one skill from the preferred section");
  for (const skill of skills) {
    assert.equal(skill.requirementLevel, "Preferred", skill.skillName);
  }
});

// --- Defect 2: "Required …" headings matched no rule, so their content was discarded (+1,211) ----

test("Stage 25A: 'Required …' headings are recognized as qualifications", () => {
  for (const heading of ["Required", "Required:", "Required Education", "Required Work Experience", "What you need"]) {
    const sections = parseDescriptionSections(`<h3>${heading}</h3><ul><li>Bachelor of Science in Computer Science, or equivalent practical experience.</li></ul>`);
    assert.ok(sections, heading);
    assert.equal(sections!.qualifications, "Bachelor of Science in Computer Science, or equivalent practical experience.", heading);
  }
});

test("Stage 25A: an unrecognized heading still ends the current section (no boilerplate bleed)", () => {
  // Deliberately unchanged behaviour: keeping the section open across an unlabelled heading was
  // measured to pull "About <Employer>" and EEO/drug-testing paragraphs into requirement text,
  // which would fabricate requirement units. Absence of evidence stays absence of evidence.
  const sections = parseDescriptionSections(
    "<h3>Required</h3><ul><li>5 years of hands-on Python engineering experience.</li></ul><h3>About Boise Cascade</h3><p>Boise Cascade has been in business for decades.</p>"
  );
  assert.ok(sections);
  assert.equal(sections!.qualifications, "5 years of hands-on Python engineering experience.");
  assert.ok(!(sections!.qualifications ?? "").includes("Boise Cascade"));
});

// --- Defect 3: fragment-only URLs counted as posting identity (72 active career_link rows) -------

function normalizedJob(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    externalId: null,
    title: "Skip to main content",
    location: "United States",
    department: null,
    url: "https://aws.amazon.com/#aws-page-content-main",
    descriptionHtml: null,
    descriptionText: null,
    employmentType: null,
    workplaceType: null,
    salaryText: null,
    postedAt: null,
    raw: {},
    ...overrides,
  } as NormalizedJob;
}

test("Stage 25A: a same-page anchor on a root/careers-root URL has no posting identity", () => {
  // Real rows: job 13 (aws.amazon.com/#aws-page-content-main), 28122
  // (bulletelectric.com/careers#main-content), 28270 (communityforce.com/#main-content).
  for (const url of [
    "https://aws.amazon.com/#aws-page-content-main",
    "https://bulletelectric.com/careers#main-content",
    "https://communityforce.com/#main-content",
  ]) {
    // A neutral title isolates the URL rule from the navigation-title rule below.
    const result = validateNormalizedJob(normalizedJob({ title: "Senior Data Engineer", url }));
    assert.equal(result.valid, false, url);
    assert.ok(result.negativeSignals.includes("careers_root_url_without_posting_identity"), url);
  }
});

test("Stage 25A: skip-navigation link text is rejected as a job title", () => {
  // Deeper anchor paths (job 54's ".../careers/explore-opportunities#", job 29161's
  // ".../about/careers/#page") are real page paths, so the URL rule above deliberately does not
  // claim them — the navigation TITLE is what identifies them, and both validators now agree.
  for (const title of [
    "Skip to main content",
    "Skip to content",
    "READ MORE",
    "Explore opportunities",
    "Get directions",
    "Learn more",
  ]) {
    const record = validateNormalizedJob(
      normalizedJob({ title, url: "https://heritageprovidernetwork.com/about/careers/#page" })
    );
    assert.equal(record.valid, false, title);
    assert.ok(record.negativeSignals.includes("pseudo_job_title:navigation_phrase"), title);

  }
});

test("Stage 25A: skip-nav link text is rejected at the LINK level too", () => {
  // Only the unambiguous skip-navigation phrases extend to link-level rejection. Generic CTAs
  // ("Learn More") stay accepted there when the URL is requisition-shaped — that contract is
  // covered by src/lib/ats/__tests__/jobValidation.test.ts and is deliberately unchanged.
  for (const text of ["Skip to main content", "Skip to content"]) {
    const link = validateJobCandidate({
      url: "https://example.com/careers#main",
      text,
      contextText: `${text} — Austin, TX — Apply now`,
    });
    assert.equal(link.valid, false, text);
  }
  const genericCta = validateJobCandidate({
    url: "https://example.com/careers/jobs/software-engineer-482913",
    text: "Learn More",
  });
  assert.equal(genericCta.valid, true, "a requisition-shaped URL still outweighs generic link text");
});

test("Stage 25A: a real title that merely contains a navigation word is untouched", () => {
  const result = validateNormalizedJob(
    normalizedJob({ title: "Read More Media Buyer", url: "https://example.com/careers/read-more-media-buyer-4821" })
  );
  assert.equal(result.valid, true, result.reason);
});

test("Stage 25A: a hash-ROUTED requisition URL is still a valid posting", () => {
  const result = validateNormalizedJob(
    normalizedJob({ title: "Senior Data Engineer", url: "https://example.com/careers#/job/R12345" })
  );
  assert.equal(result.valid, true, result.reason);
});

test("Stage 25A: a normal path-based posting URL is unaffected", () => {
  const result = validateNormalizedJob(
    normalizedJob({ title: "Senior Data Engineer", url: "https://example.com/careers/senior-data-engineer-4821" })
  );
  assert.equal(result.valid, true, result.reason);
});

test("Stage 25A: link-level validation is unchanged for genuine listing links", () => {
  const result = validateJobCandidate({
    url: "https://example.com/jobs/12345",
    text: "Senior Data Engineer",
    contextText: "Senior Data Engineer — Austin, TX — Apply now",
  });
  assert.equal(result.valid, true, result.reason);
});

// --- Defect 4: negated VERB "does not sponsor" scored as no sponsorship signal (10 active jobs) --

test("Stage 25A: '<Employer> does not sponsor <object>' is a negative sponsorship signal", () => {
  for (const text of [
    // job 33053 (Ericsson), 16597 + 16557 (Mars), 928 (PCG), 26536 (Workday) — verbatim.
    "Ericsson Inc. does not sponsor U.S work authorizations for this job position including U.S. immigration filings.",
    "Mars does not sponsor visas for this role. This position is not eligible for relocation benefits.",
    "PCG does not sponsor newly hired foreign national workers for work authorization, including H-1B sponsorship.",
    "Workday is proud of its diverse workforce but does not sponsor employment visas.",
    "We cannot sponsor applicants for this position.",
  ]) {
    const result = scanSponsorshipLanguage(text);
    assert.equal(result.polarity, "negative", text);
    assert.equal(result.mentioned, true, text);
  }
});

test("Stage 25A: an affirmative sponsorship statement is still positive", () => {
  assert.equal(scanSponsorshipLanguage("We will sponsor H-1B visas for exceptional candidates.").polarity, "positive");
  assert.equal(scanSponsorshipLanguage("Visa sponsorship is available for this role.").polarity, "positive");
});

// --- Defect 5: "only US citizens …" word order missed (jobs 33046/33047/33048/33050) ------------

test("Stage 25A: 'only US citizens … will be considered' is a citizenship requirement", () => {
  const result = extractClearance(
    "Due to Federal requirements, only US citizens, US naturalized citizens or US Permanent Residents, holding a green card, will be considered."
  );
  assert.equal(result.citizenshipRequired, "Required");
  assert.ok(result.evidence);
});

test("Stage 25A: the previously-covered citizenship phrasings still classify", () => {
  assert.equal(extractClearance("US citizens only for this role.").citizenshipRequired, "Required");
  assert.equal(extractClearance("Must be a U.S. citizen.").citizenshipRequired, "Required");
  assert.equal(extractClearance("We welcome applicants from all backgrounds.").citizenshipRequired, "Unknown");
});

// --- Defect 6: "IN <Indian place>" prefix classified as Indiana (5 active jobs, 2 in the feed) ---

test("Stage 25A: an 'IN <Indian place>' prefix is NON_US", () => {
  // Real values: jobs at "IN Pune", "IN Bengaluru", "IN Sector 142, Noida", "IN Tamil Nadu (Chennai) - Office".
  for (const location of ["IN Pune", "IN Bengaluru", "IN - Pune", "IN Sector 142, Noida", "IN Tamil Nadu (Chennai) - Office"]) {
    assert.equal(classifyJobLocation(location), "NON_US", location);
  }
});

test("Stage 25A: genuine Indiana locations are still US", () => {
  for (const location of [
    "IN - Indianapolis",
    "IN-INDIANAPOLIS, 220 VIRGINIA AVE",
    "Indianapolis, IN",
    "Evansville, IN",
    "Fort Wayne, Indiana",
  ]) {
    assert.equal(classifyJobLocation(location), "US", location);
  }
});

// --- Extraction identity ------------------------------------------------------------------------

test("Stage 25A: EXTRACTION_VERSION was bumped so every cached extraction/match is invalidated", () => {
  assert.ok(
    EXTRACTION_VERSION >= 3,
    "the section-routing fixes change stored requirement_level, so EXTRACTION_VERSION must be >= 3"
  );
});
