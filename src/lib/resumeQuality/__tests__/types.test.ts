import assert from "node:assert/strict";
import { test } from "node:test";
import {
  structuredResumeReviewSchema,
  type ResumeReviewerAgent,
  type ResumeReviewerInput,
  type ResumeWriterAgent,
  type ResumeWriterInput,
  type StructuredResumeReview,
} from "../types";

function validReview(overrides: Partial<StructuredResumeReview> = {}): StructuredResumeReview {
  return {
    overallScore: 90,
    atsScore: 88,
    keywordAlignmentScore: 85,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 90,
    formattingScore: 100,
    missingRequiredSkills: [],
    incorrectTechnologyUsage: [],
    genericBullets: [],
    missingImpactEvidence: [],
    summaryIssues: [],
    skillsOrderingIssues: [],
    truthfulnessIssues: [],
    blockingIssues: [],
    requiredCorrections: [{ priority: "MEDIUM", description: "Tighten the summary." }],
    ...overrides,
  };
}

test("structuredResumeReviewSchema accepts a well-formed review", () => {
  const result = structuredResumeReviewSchema.safeParse(validReview());
  assert.equal(result.success, true);
});

test("review-score range validation: every score must be within 0-100", () => {
  for (const field of ["overallScore", "atsScore", "keywordAlignmentScore", "recruiterReadabilityScore", "formattingScore"] as const) {
    assert.equal(structuredResumeReviewSchema.safeParse(validReview({ [field]: -1 })).success, false, `${field} = -1 must be rejected`);
    assert.equal(structuredResumeReviewSchema.safeParse(validReview({ [field]: 101 })).success, false, `${field} = 101 must be rejected`);
    assert.equal(structuredResumeReviewSchema.safeParse(validReview({ [field]: 0 })).success, true, `${field} = 0 must be accepted (boundary)`);
    assert.equal(structuredResumeReviewSchema.safeParse(validReview({ [field]: 100 })).success, true, `${field} = 100 must be accepted (boundary)`);
  }
});

test("truthfulness score validation: out-of-range values are rejected, in-range values (including non-100) are accepted by the schema", () => {
  assert.equal(structuredResumeReviewSchema.safeParse(validReview({ truthfulnessScore: -0.01 })).success, false);
  assert.equal(structuredResumeReviewSchema.safeParse(validReview({ truthfulnessScore: 100.01 })).success, false);
  // The schema only validates RANGE — the "must be exactly 100 to pass the gate" rule lives in
  // qualityGate.ts, not here, so a value like 87 is schema-valid even though it would never reach READY.
  assert.equal(structuredResumeReviewSchema.safeParse(validReview({ truthfulnessScore: 87 })).success, true);
});

test("blocking issue structure: blockingIssues must be an array of strings", () => {
  assert.equal(structuredResumeReviewSchema.safeParse(validReview({ blockingIssues: ["Claims AWS with zero supporting evidence"] })).success, true);
  assert.equal(
    structuredResumeReviewSchema.safeParse({ ...validReview(), blockingIssues: [{ not: "a string" }] }).success,
    false
  );
});

test("correction priority validation: only CRITICAL/HIGH/MEDIUM/LOW are accepted", () => {
  for (const priority of ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const) {
    const review = validReview({ requiredCorrections: [{ priority, description: "x" }] });
    assert.equal(structuredResumeReviewSchema.safeParse(review).success, true, `${priority} must be accepted`);
  }
  const invalid = { ...validReview(), requiredCorrections: [{ priority: "URGENT", description: "x" }] };
  assert.equal(structuredResumeReviewSchema.safeParse(invalid).success, false);
});

test("a required correction without a description is rejected", () => {
  const invalid = { ...validReview(), requiredCorrections: [{ priority: "HIGH", description: "" }] };
  assert.equal(structuredResumeReviewSchema.safeParse(invalid).success, false);
});

test("unknown extra fields are rejected (strict schema)", () => {
  const withExtra = { ...validReview(), somethingUnexpected: true };
  assert.equal(structuredResumeReviewSchema.safeParse(withExtra).success, false);
});

// --- Provider-independent agent interfaces "compile" check --------------------------------------
//
// No AI provider SDK, no network call, no API key anywhere below — these are deterministic, local,
// in-memory implementations that exist purely to prove ResumeWriterAgent/ResumeReviewerAgent are
// genuinely usable shapes (matching the Stage 7 spec's own "LocalResumeWriter"/"LocalResumeReviewer"
// example), not implemented by Stage 7 as real functionality.

class LocalResumeWriter implements ResumeWriterAgent {
  async generate(input: ResumeWriterInput) {
    return {
      resume: {
        name: "Test Candidate",
        tagline: "Engineer",
        location: "Remote",
        phone: "555-0100",
        email: "test@example.com",
        summary: [`Generated for application ${input.applicationId}`],
        skillGroups: [],
        experience: [],
        education: [],
      },
      coverLetter: {
        name: "Test Candidate",
        location: "Remote",
        phone: "555-0100",
        email: "test@example.com",
        salutation: "Dear Hiring Team,",
        paragraphs: ["Placeholder."],
        closing: "Best,",
      },
    };
  }
}

class LocalResumeReviewer implements ResumeReviewerAgent {
  async review(input: ResumeReviewerInput) {
    return {
      review: validReview({
        summaryIssues: input.resume.summary.length === 0 ? ["Summary is empty"] : [],
      }),
    };
  }
}

test("ResumeWriterAgent is implementable without any AI provider — a local deterministic implementation satisfies the interface", async () => {
  const writer = new LocalResumeWriter();
  const output = await writer.generate({
    applicationId: 1,
    candidateId: 1,
    tailoringRunId: 1,
    workflowId: 1,
    jobDescriptionPath: "/tmp/jd.md",
    extractedJobRequirementsPath: null,
    masterResumePath: "/tmp/resume.docx",
    masterSkillsInventoryPath: "/tmp/skills.md",
    tailoringInstructionsPath: "/tmp/instructions.md",
    selectedTrack: null,
    priorIteration: null,
  });
  assert.equal(output.resume.name, "Test Candidate");
  assert.ok(output.resume.summary[0].includes("1"));
});

test("ResumeReviewerAgent is implementable without any AI provider — a local deterministic implementation satisfies the interface", async () => {
  const reviewer = new LocalResumeReviewer();
  const output = await reviewer.review({
    applicationId: 1,
    candidateId: 1,
    workflowId: 1,
    iterationNumber: 1,
    resumePath: "/tmp/Resume.docx",
    jobDescriptionPath: "/tmp/jd.md",
    resume: {
      name: "Test",
      tagline: "x",
      location: "x",
      phone: "x",
      email: "x",
      summary: [],
      skillGroups: [],
      experience: [],
      education: [],
    },
  });
  const parsed = structuredResumeReviewSchema.safeParse(output.review);
  assert.equal(parsed.success, true, "a real reviewer's output must satisfy the structured review schema");
  assert.deepEqual(output.review.summaryIssues, ["Summary is empty"]);
});
