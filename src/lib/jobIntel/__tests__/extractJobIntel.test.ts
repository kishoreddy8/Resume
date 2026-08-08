import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJobIntel, EXTRACTION_VERSION } from "../extractJobIntel";
import type { JobIntelInput } from "../types";

function baseInput(overrides: Partial<JobIntelInput> = {}): JobIntelInput {
  return {
    title: "Senior Data Engineer",
    descriptionText: null,
    descriptionHtml: null,
    employmentTypeNative: null,
    workplaceTypeNative: null,
    locationNative: null,
    salaryTextNative: null,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    ...overrides,
  };
}

const COMPLETE_JD_HTML = `
  <h2>Responsibilities</h2>
  <p>Build and own our data pipelines.</p>
  <h2>Required Qualifications</h2>
  <ul>
    <li>5+ years of experience with Python and SQL.</li>
    <li>Bachelor's degree in Computer Science or equivalent experience.</li>
    <li>Experience with AWS or Azure required.</li>
  </ul>
  <h2>Nice to Have</h2>
  <ul><li>Experience with Snowflake preferred.</li></ul>
  <h2>Benefits</h2>
  <p>Competitive pay, $140,000 - $170,000, plus equity.</p>
`;

test("complete JD: every extractor contributes a populated result", () => {
  const result = extractJobIntel(
    baseInput({
      descriptionHtml: COMPLETE_JD_HTML,
      descriptionText: COMPLETE_JD_HTML.replace(/<[^>]+>/g, " "),
      employmentTypeNative: "Full-time",
      workplaceTypeNative: "Hybrid",
      locationNative: "Austin, TX",
      salaryTextNative: "$140,000 - $170,000",
    })
  );

  assert.equal(result.seniority.level, "Senior");
  assert.equal(result.employmentType.type, "Full-Time");
  assert.equal(result.location.workplaceType, "Hybrid");
  assert.equal(result.experience.minYears, 5);
  assert.equal(result.education.level, "Bachelor's");
  assert.equal(result.education.equivalentExperienceAllowed, true);
  assert.equal(result.compensation.min, 140000);
  assert.equal(result.compensation.max, 170000);
  assert.ok(result.skills.some((s) => s.skillName === "Python" && s.requirementLevel === "Required"));
  assert.ok(result.skills.some((s) => s.skillName === "Snowflake" && s.requirementLevel === "Preferred"));
  assert.ok(result.sections.responsibilities);
  assert.ok(result.sections.requiredQualifications);
  assert.ok(result.sections.preferredQualifications);
  assert.equal(result.extractionVersion, EXTRACTION_VERSION);
});

test("sparse JD: mostly-empty result, nothing fabricated", () => {
  const result = extractJobIntel(baseInput({ title: "Engineer" }));
  assert.equal(result.seniority.level, "Unknown");
  assert.equal(result.employmentType.type, "Unknown");
  assert.equal(result.experience.minYears, null);
  assert.equal(result.education.level, null);
  assert.equal(result.compensation.min, null);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.certifications, []);
  assert.deepEqual(result.qualityFlags, []);
});

test("malformed JD: extraction never throws", () => {
  assert.doesNotThrow(() =>
    extractJobIntel(
      baseInput({
        descriptionHtml: "<div><p>Must have <b>Python<div>5+ years<li>Senior role required",
        descriptionText: "Must have Python 5+ years Senior role required",
      })
    )
  );
});

test("null/undefined description fields handled safely end-to-end", () => {
  const result = extractJobIntel(baseInput());
  assert.equal(result.location.workplaceType, "Unknown");
  assert.deepEqual(result.location.locations, []);
  assert.equal(result.clearance.required, "Unknown");
  assert.equal(result.domain.domain, null);
});

test("seniority falls back to JD body when the title carries no signal", () => {
  const result = extractJobIntel(
    baseInput({
      title: "Data Engineer",
      descriptionText: "Great opportunity for a recent graduate to join our team.",
    })
  );
  assert.equal(result.seniority.level, "Entry");
});

test("clearance stays fully separate from sponsorship — a negative sponsorship JD does not imply clearance, and vice versa", () => {
  const result = extractJobIntel(
    baseInput({
      descriptionText: "We do not offer visa sponsorship for this role.",
      sponsorshipPolarity: "negative",
    })
  );
  assert.equal(result.clearance.required, "Unknown");
  assert.ok(result.qualityFlags.includes("Sponsorship Restriction"));
  assert.ok(!result.qualityFlags.includes("Clearance Required"));
});

test("re-running extraction on identical input is deterministic (idempotent at the pure-function level)", () => {
  const input = baseInput({
    descriptionHtml: COMPLETE_JD_HTML,
    descriptionText: COMPLETE_JD_HTML.replace(/<[^>]+>/g, " "),
  });
  const first = extractJobIntel(input);
  const second = extractJobIntel(input);
  assert.deepEqual(first, second);
});
