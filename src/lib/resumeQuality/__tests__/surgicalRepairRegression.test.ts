import assert from "node:assert/strict";
import test from "node:test";
import type { CoverLetterContent, ResumeContent, StructuredResumeReview } from "../types";
import { buildCandidateRepairQuestions, planRepairScope } from "../repairScope";
import { validateRepairPreservation } from "../repairPreservation";

const resume: ResumeContent = {
  name: "Candidate",
  tagline: "Senior Data Engineer",
  location: "Dallas, TX",
  phone: "555-0101",
  email: "candidate@example.test",
  summary: ["Senior Data Engineer delivering supported cloud data platforms for banking teams."],
  skillGroups: [{ label: "Cloud & Data Platforms", items: ["Azure Synapse Analytics", "Snowflake", "Jenkins"] }],
  experience: [
    { company: "Comerica Bank", title: "Data Engineer", dates: "2025 - Present", projectDescription: "Azure lakehouse delivery.", bullets: Array.from({ length: 7 }, (_, i) => `Comerica supported bullet ${i + 1}.`) },
    { company: "Fiserv", title: "Data Engineer", dates: "2022 - 2025", projectDescription: "Synapse serving and dimensional modeling.", bullets: Array.from({ length: 6 }, (_, i) => `Fiserv supported bullet ${i + 1}.`) },
    { company: "Microgate Technologies", title: "Data Engineer", dates: "2020 - 2021", projectDescription: "AWS and Snowflake ETL delivery.", bullets: Array.from({ length: 5 }, (_, i) => `Microgate supported bullet ${i + 1}.`) },
  ],
  education: ["M.S. Computer Science"],
};

const coverLetter: CoverLetterContent = {
  name: "Candidate",
  location: "Dallas, TX",
  phone: "555-0101",
  email: "candidate@example.test",
  salutation: "Dear Hiring Team,",
  paragraphs: [
    "At Fiserv, I built Snowflake warehouse pipelines. At Microgate Technologies, I used Shell Scripting for deployment automation. These experiences prepared me for the role.",
  ],
  closing: "Sincerely,\nCandidate",
};

function attributionReview(ambiguous = false): StructuredResumeReview {
  const ambiguity = ambiguous ? " Employer-scoped evidence is unclear and cannot determine whether this was used there." : "";
  return {
    overallScore: 97,
    atsScore: 94,
    keywordAlignmentScore: 94,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 100,
    formattingScore: 100,
    missingRequiredSkills: ["CloudWatch"],
    incorrectTechnologyUsage: [],
    genericBullets: [],
    missingImpactEvidence: [],
    summaryIssues: [],
    skillsOrderingIssues: [],
    truthfulnessIssues: [],
    blockingIssues: [],
    requiredCorrections: [
      { priority: "CRITICAL", description: "Canonical instruction compliance — finalValidation: FAIL." },
    ],
    blockingFailures: [
      { type: "EMPLOYER_CONTRADICTION", description: `Cover letter attributes "Snowflake" to Fiserv.${ambiguity}` },
      { type: "EMPLOYER_CONTRADICTION", description: `Cover letter attributes "Shell Scripting" to Microgate Technologies.${ambiguity}` },
    ],
  } as StructuredResumeReview;
}

test("real regression: two attribution repairs preserve all 18 bullets and every unrelated section", () => {
  const plan = planRepairScope(attributionReview(), { resume, coverLetter });
  assert.deepEqual(plan.editablePaths, [
    "coverLetter.paragraphs[0].sentences[0]",
    "coverLetter.paragraphs[0].sentences[1]",
  ]);
  assert.equal(plan.rootFindings?.length, 2, "finalValidation is not a third writer task");
  assert.equal(plan.operations?.some((operation) => operation.reason.includes("CloudWatch")), false, "an unsupported JD gap is not candidate evidence or an automatic claim");

  const repairedCover = {
    ...coverLetter,
    paragraphs: [
      "At Fiserv, I built Azure Synapse Analytics serving pipelines. At Microgate Technologies, Jenkins automated deployment. These experiences prepared me for the role.",
    ],
  };
  const result = validateRepairPreservation({
    baselineResume: resume,
    baselineCoverLetter: coverLetter,
    repairedResume: JSON.parse(JSON.stringify(resume)) as ResumeContent,
    repairedCoverLetter: repairedCover,
    repairPlan: plan,
  });
  assert.equal(result.valid, true, result.violations.join(", "));
  assert.equal(resume.experience.reduce((count, role) => count + role.bullets.length, 0), 18);
});

test("repairing attribution cannot introduce Data Governance into a frozen summary", () => {
  const plan = planRepairScope(attributionReview(), { resume, coverLetter });
  const collateral = JSON.parse(JSON.stringify(resume)) as ResumeContent;
  collateral.summary[0] = `${collateral.summary[0]} Data Governance.`;
  const result = validateRepairPreservation({
    baselineResume: resume,
    baselineCoverLetter: coverLetter,
    repairedResume: collateral,
    repairedCoverLetter: coverLetter,
    repairPlan: plan,
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.includes("resume.summary[0]"));
});

test("candidate questions appear only for genuinely ambiguous evidence", () => {
  const deterministic = buildCandidateRepairQuestions(planRepairScope(attributionReview(), { resume, coverLetter }));
  const ambiguous = buildCandidateRepairQuestions(planRepairScope(attributionReview(true), { resume, coverLetter }));
  assert.deepEqual(deterministic, []);
  assert.equal(ambiguous.length, 2);
  assert.deepEqual(ambiguous[0]!.choices, ["Yes", "No", "Not sure"]);
});
