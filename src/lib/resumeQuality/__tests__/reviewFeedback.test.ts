import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReviewFeedbackMarkdown } from "../reviewFeedback";
import type { StructuredResumeReview } from "../types";

function baseReview(overrides: Partial<StructuredResumeReview> = {}): StructuredResumeReview {
  return {
    overallScore: 82,
    atsScore: 80,
    keywordAlignmentScore: 78,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 85,
    formattingScore: 90,
    missingRequiredSkills: [],
    incorrectTechnologyUsage: [],
    genericBullets: [],
    missingImpactEvidence: [],
    summaryIssues: [],
    skillsOrderingIssues: [],
    truthfulnessIssues: [],
    blockingIssues: [],
    requiredCorrections: [],
    ...overrides,
  };
}

test("35. Markdown output contains every populated score and issue category", () => {
  const review = baseReview({
    missingRequiredSkills: ["Snowflake"],
    incorrectTechnologyUsage: ["Azure Data Factory + AWS Glue in one bullet"],
    genericBullets: ["Responsible for data pipelines."],
    missingImpactEvidence: ["Improved performance."],
    summaryIssues: ["Summary too generic."],
    skillsOrderingIssues: ["Snowflake buried in skill group #4."],
    truthfulnessIssues: ["Title mismatch at Acme."],
    blockingIssues: ["Employer 'Fabricated Inc' not in Master Resume."],
  });
  const md = renderReviewFeedbackMarkdown(review);

  assert.match(md, /Overall Quality Score.*82/);
  assert.match(md, /ATS Score.*80/);
  assert.match(md, /Keyword Alignment.*78/);
  assert.match(md, /Truthfulness.*100/);
  assert.match(md, /Architecture Consistency.*100/);
  assert.match(md, /Recruiter Readability.*85/);
  assert.match(md, /Formatting.*90/);

  assert.match(md, /Blocking Issues/);
  assert.match(md, /Fabricated Inc/);
  assert.match(md, /Missing Required Skills/);
  assert.match(md, /Snowflake/);
  assert.match(md, /Incorrect Technology Usage/);
  assert.match(md, /Generic Bullets/);
  assert.match(md, /Missing Impact Evidence/);
  assert.match(md, /Summary Issues/);
  assert.match(md, /Skills Ordering Issues/);
  assert.match(md, /Truthfulness Issues/);
});

test("35b. an empty category is never rendered as an empty/misleading heading", () => {
  const review = baseReview(); // everything empty except scores
  const md = renderReviewFeedbackMarkdown(review);
  assert.ok(!md.includes("Blocking Issues"), "an empty blockingIssues array must not render a heading with nothing under it");
  assert.ok(!md.includes("Missing Required Skills"));
});

test("36. correction priority order renders CRITICAL, then HIGH, then MEDIUM, then LOW", () => {
  const review = baseReview({
    requiredCorrections: [
      { priority: "LOW", description: "Minor formatting nit." },
      { priority: "CRITICAL", description: "Fabricated certification." },
      { priority: "MEDIUM", description: "Generic bullet." },
      { priority: "HIGH", description: "Missing required skill." },
    ],
  });
  const md = renderReviewFeedbackMarkdown(review);

  const criticalIndex = md.indexOf("### CRITICAL");
  const highIndex = md.indexOf("### HIGH");
  const mediumIndex = md.indexOf("### MEDIUM");
  const lowIndex = md.indexOf("### LOW");

  assert.ok(criticalIndex >= 0 && highIndex >= 0 && mediumIndex >= 0 && lowIndex >= 0);
  assert.ok(criticalIndex < highIndex);
  assert.ok(highIndex < mediumIndex);
  assert.ok(mediumIndex < lowIndex);
});

test("36b. a priority tier with no corrections is not rendered at all", () => {
  const review = baseReview({ requiredCorrections: [{ priority: "HIGH", description: "Missing required skill." }] });
  const md = renderReviewFeedbackMarkdown(review);
  assert.ok(md.includes("### HIGH"));
  assert.ok(!md.includes("### CRITICAL"));
  assert.ok(!md.includes("### MEDIUM"));
  assert.ok(!md.includes("### LOW"));
});

test("structured JSON remains authoritative — the renderer never mutates or is fed back into the review object", () => {
  const review = baseReview({ overallScore: 55 });
  const before = JSON.stringify(review);
  renderReviewFeedbackMarkdown(review);
  assert.equal(JSON.stringify(review), before, "rendering must be a pure read, never mutate the source review");
});
