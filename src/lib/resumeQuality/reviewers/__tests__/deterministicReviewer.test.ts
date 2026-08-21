import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { evaluateQualityGate } from "../../qualityGate";
import { structuredResumeReviewSchema } from "../../types";
import type { CoverLetterContent, ResumeContent } from "../../../../../tools/tailoring-engine/types";
import { DeterministicResumeReviewer, reviewResumeDeterministically } from "../deterministicReviewer";

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: [],
    label: "requirement",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
    ...overrides,
  };
}

function masterProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "r", skills: "s" },
    builtAt: "2026-01-01T00:00:00Z",
    // Matches STRONG_RESUME's claimed technologies below — a real Master Skills Inventory grounding
    // every technology the "strong, fully-aligned" fixture resume claims, so
    // masterSkillsInventoryCompliance genuinely PASSes rather than flagging ungrounded tech (Resume
    // Quality Hardening's new MSI-grounding check).
    skills: [
      { rawSkillName: "Azure", source: "employer" },
      { rawSkillName: "Azure Data Factory", source: "employer" },
      { rawSkillName: "Databricks", source: "employer" },
    ],
    experience: [{ employer: "Acme Corp", title: "Senior Data Engineer", startDate: "2020-01", endDate: null, technologies: ["Azure", "Azure Data Factory", "Databricks"] }],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
    certifications: [],
    totalYearsExperience: 5,
    ...overrides,
  };
}

const STRONG_RESUME: ResumeContent = {
  name: "Test Candidate",
  tagline: "Senior Data Engineer",
  location: "Remote",
  phone: "312-555-9821",
  email: "test@gmail.com",
  summary: [
    "Senior Data Engineer specializing in Azure Data Factory and Databricks pipelines for enterprise analytics platforms. Experienced in Azure-native architectures and governed batch delivery. Skilled in Azure Data Factory orchestration and Databricks performance tuning.",
  ],
  skillGroups: [{ label: "Cloud & Data Platform", items: ["Azure", "Azure Data Factory", "Databricks"] }],
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Acme Corp",
      dates: "2020 - Present",
      bullets: [
        "Designed Azure Data Factory pipelines that reduced nightly batch processing time from 6 hours to 45 minutes.",
        "Built Databricks notebooks to transform 2TB of daily transaction data into curated analytics tables.",
      ],
    },
  ],
  education: ["B.S. Computer Science, State University"],
};

const STRONG_REQUIREMENTS: RequirementUnit[] = [
  unit({ memberSkillNames: ["Azure"], label: "Azure" }),
  unit({ memberSkillNames: ["Azure Data Factory"], label: "Azure Data Factory" }),
  unit({ memberSkillNames: ["Databricks"], label: "Databricks" }),
];

function coverLetter(paragraphs: string[]): CoverLetterContent {
  return {
    name: "Test Candidate",
    location: "Remote",
    phone: "312-555-9821",
    email: "test@gmail.com",
    salutation: "Dear Hiring Team,",
    paragraphs,
    closing: "Sincerely,\nTest Candidate",
  };
}

test("30. deterministic repeatability: identical input always produces an identical review", () => {
  const input = { resume: STRONG_RESUME, jobRequirements: STRONG_REQUIREMENTS, masterResumeProfile: masterProfile() };
  const first = reviewResumeDeterministically(input);
  const second = reviewResumeDeterministically(input);
  assert.deepEqual(first, second);
});

test("31. every score stays within 0-100 bounds across a wide range of inputs, including pathological ones", () => {
  const cases: Array<Parameters<typeof reviewResumeDeterministically>[0]> = [
    { resume: STRONG_RESUME, jobRequirements: STRONG_REQUIREMENTS, masterResumeProfile: masterProfile() },
    { resume: STRONG_RESUME, jobRequirements: undefined, masterResumeProfile: undefined },
    { resume: { ...STRONG_RESUME, summary: [], skillGroups: [], experience: [], education: [] }, jobRequirements: [], masterResumeProfile: masterProfile() },
    {
      resume: { ...STRONG_RESUME, experience: [{ title: "CEO", company: "Nonexistent Corp", dates: "1999", bullets: ["Leveraged synergy to seamlessly optimize."] }] },
      jobRequirements: STRONG_REQUIREMENTS,
      masterResumeProfile: masterProfile(),
    },
  ];
  for (const input of cases) {
    const review = reviewResumeDeterministically(input);
    const parsed = structuredResumeReviewSchema.safeParse(review);
    assert.equal(parsed.success, true, `review must satisfy the Stage 7 structured schema (0-100 bounds included): ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`);
  }
});

test("32. a blocking issue materially lowers overallScore compared to the same resume without one", () => {
  const withoutBlockingIssue = reviewResumeDeterministically({
    resume: STRONG_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  const resumeWithFabricatedEmployer: ResumeContent = {
    ...STRONG_RESUME,
    experience: [{ ...STRONG_RESUME.experience[0], company: "Totally Fabricated LLC" }],
  };
  const withBlockingIssue = reviewResumeDeterministically({
    resume: resumeWithFabricatedEmployer,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.ok(withBlockingIssue.blockingIssues.length > 0);
  assert.ok(
    withBlockingIssue.overallScore < withoutBlockingIssue.overallScore - 20,
    `expected a material drop: ${withBlockingIssue.overallScore} vs ${withoutBlockingIssue.overallScore}`
  );
  assert.ok(withBlockingIssue.overallScore <= 40, "overallScore must be hard-capped when a blocking issue exists");
});

test("33. a perfect ATS/keyword score cannot override a truthfulness contradiction", () => {
  const resumeWithFabricatedCert: ResumeContent = { ...STRONG_RESUME, certifications: ["Completely Fabricated Certification"] };
  const review = reviewResumeDeterministically({
    resume: resumeWithFabricatedCert,
    jobRequirements: STRONG_REQUIREMENTS, // fully satisfied -> perfect ATS/keyword scores
    masterResumeProfile: masterProfile(),
  });
  assert.equal(review.atsScore, 100);
  assert.equal(review.keywordAlignmentScore, 100);
  assert.ok(review.blockingIssues.length > 0, "a fabricated certification must be a blocking issue");
  assert.ok(review.overallScore < 50, `perfect ATS scores must not rescue overallScore when truthfulness is blocked: got ${review.overallScore}`);
});

test("34. readiness is decided ONLY through Stage 7's existing evaluateQualityGate() — this module never re-implements that logic", () => {
  const review = reviewResumeDeterministically({ resume: STRONG_RESUME, jobRequirements: STRONG_REQUIREMENTS, masterResumeProfile: masterProfile() });
  // The deterministic reviewer object has no "ready"/"isReady"/"gate" method of its own.
  assert.equal("isReady" in review, false);
  assert.equal("ready" in review, false);
  assert.equal("gateOutcome" in review, false);

  const outcome = evaluateQualityGate(review, 1, 3);
  assert.ok(outcome === "READY" || outcome === "IMPROVEMENT_NEEDED" || outcome === "NEEDS_HUMAN_REVIEW");
});

test("a strong, fully-aligned, fully-truthful resume can reach READY through the real composition of reviewer + gate", () => {
  const review = reviewResumeDeterministically({
    resume: STRONG_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    // Stage 21: matches STRONG_RESUME.tagline so positioning/recruiter-quality genuinely PASSes.
    targetRoleTitle: "Senior Data Engineer",
  });
  assert.equal(review.blockingIssues.length, 0);
  assert.equal(review.truthfulnessScore, 100);
  assert.equal(review.architectureConsistencyScore, 100);
  const outcome = evaluateQualityGate(review, 1, 3);
  assert.equal(outcome, "READY");
});

test("DeterministicResumeReviewer implements ResumeReviewerAgent and is fully callable with no network/AI provider", async () => {
  const reviewer = new DeterministicResumeReviewer();
  const output = await reviewer.review({
    applicationId: 1,
    candidateId: 1,
    workflowId: 1,
    iterationNumber: 1,
    resumePath: "/tmp/Resume.docx",
    jobDescriptionPath: "/tmp/jd.md",
    resume: STRONG_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  const parsed = structuredResumeReviewSchema.safeParse(output.review);
  assert.equal(parsed.success, true);
});

test("missing job requirements AND missing master profile together still produce a valid, bounded, non-crashing review", () => {
  const review = reviewResumeDeterministically({ resume: STRONG_RESUME, jobRequirements: undefined, masterResumeProfile: undefined });
  const parsed = structuredResumeReviewSchema.safeParse(review);
  assert.equal(parsed.success, true);
  assert.ok(review.requiredCorrections.some((c) => c.description.includes("No job requirements")));
  assert.ok(review.requiredCorrections.some((c) => c.description.includes("No Master Resume profile")));
});

test("cover-letter technology checks preserve separate-employer sentence boundaries within one paragraph", () => {
  const review = reviewResumeDeterministically({
    resume: STRONG_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    coverLetter: coverLetter([
      "At Fiserv, the candidate published curated datasets through Azure Synapse Analytics. Earlier at Microgate Technologies, the candidate loaded transformed data into Snowflake. At Fiserv, Azure DevOps managed delivery. At Microgate Technologies, Jenkins automated deployment of Spark jobs.",
    ]),
  });

  assert.equal(review.instructionCompliance?.checks.technologyAdaptation, "PASS");
  assert.equal(review.instructionCompliance?.checks.migrationIntegrity, "PASS");
  assert.equal(review.instructionCompliance?.checks.noContradictingTechnologies, "PASS");
});

test("cover-letter technology checks still fail same-responsibility competing warehouses", () => {
  const review = reviewResumeDeterministically({
    resume: STRONG_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    coverLetter: coverLetter([
      "The candidate built the same warehouse layer using Azure Synapse Analytics and Snowflake as competing primary platforms.",
    ]),
  });

  assert.equal(review.instructionCompliance?.checks.technologyAdaptation, "FAIL");
  assert.equal(review.instructionCompliance?.checks.migrationIntegrity, "FAIL");
  assert.equal(review.instructionCompliance?.checks.noContradictingTechnologies, "FAIL");
});

test("cover-letter technology checks still fail same-responsibility competing CI/CD platforms", () => {
  const review = reviewResumeDeterministically({
    resume: STRONG_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    coverLetter: coverLetter([
      "The candidate used Azure DevOps and Jenkins as simultaneous primary tools for the same deployment responsibility.",
    ]),
  });

  assert.equal(review.instructionCompliance?.checks.noContradictingTechnologies, "FAIL");
});

test("cover-letter technology checks do not treat Snowflake Schema as the Snowflake platform", () => {
  const review = reviewResumeDeterministically({
    resume: STRONG_RESUME,
    jobRequirements: STRONG_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
    coverLetter: coverLetter([
      "At Fiserv, the candidate modeled a Snowflake Schema in Azure Synapse Analytics for dimensional reporting.",
    ]),
  });

  assert.equal(review.instructionCompliance?.checks.noContradictingTechnologies, "PASS");
});
