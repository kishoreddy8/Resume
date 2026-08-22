import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";
import { evaluateApplicationReadiness } from "../applicationReadiness";
import { evaluateRecruiterQuality } from "../recruiterQualityGate";
import { validateRepairPreservation } from "../repairPreservation";
import { extractRootRepairFindings, planRepairScope, renderRepairPlanSection } from "../repairScope";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";
import type {
  ComplianceStatus,
  InstructionComplianceChecks,
  ResumeContent,
  StructuredResumeReview,
} from "../types";

const HEADLINE_FINDING =
  'Resume headline "Data Engineer" shares only the generic profession noun (engineer) with the target role "Cloud Engineer (Data Engineer)" — it does not communicate the specific role being applied for.';

function allChecks(status: ComplianceStatus = "PASS"): InstructionComplianceChecks {
  const checks = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) checks[name] = status;
  return checks;
}

function resume(): ResumeContent {
  return {
    name: "Sai Reddy",
    tagline: "Data Engineer",
    location: "Dallas, TX",
    phone: "5551112222",
    email: "sai@example.com",
    summary: ["Data Engineer building supported Azure lakehouse pipelines for banking teams."],
    skillGroups: [{ label: "Cloud & Data Platforms", items: ["Azure Databricks", "Delta Lake"] }],
    experience: [
      {
        title: "Data Engineer",
        company: "Comerica Bank",
        dates: "2022 - Present",
        projectDescription: "Built supported Azure data platforms for regulated banking workloads.",
        bullets: ["Engineered supported PySpark pipelines on Azure Databricks."],
      },
    ],
    education: ["MS, Example University - 2022"],
    certifications: ["Azure Fundamentals"],
  };
}

function review(overrides: Partial<StructuredResumeReview> = {}): StructuredResumeReview {
  return {
    overallScore: 98,
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
    requiredCorrections: [],
    blockingFailures: [],
    jdPriorityMatrix: {
      targetRoleTitle: "Cloud Engineer (Data Engineer)",
      requirements: [
        {
          requirement: "CloudWatch",
          priority: "P2",
          memberSkillNames: ["CloudWatch"],
          requiredOrPreferred: "REQUIRED",
          evidenceAvailable: false,
          evidenceStrength: "NONE",
          evidenceReferences: [],
        },
      ],
    },
    recruiterQualityAssessment: {
      status: "FAIL",
      score: 30,
      issues: [
        { dimension: "targetRoleClarity", severity: "BLOCKING", description: HEADLINE_FINDING },
        {
          dimension: "firstTenSecondFit",
          severity: "BLOCKING",
          description: "Positioning failures above mean a recruiter cannot establish role fit within the first ~10 seconds of reading.",
        },
      ],
    },
    instructionCompliance: {
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      checks: allChecks(),
      notes: [],
    },
    ...overrides,
  } as StructuredResumeReview;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("blocking recruiter headline becomes one tagline-only surgical repair", () => {
  const plan = planRepairScope(review(), { resume: resume() });
  assert.equal(plan.rootFindings?.length, 1, "firstTenSecondFit must remain a derived gate signal");
  assert.deepEqual(plan.rootFindings?.[0], {
    key: HEADLINE_FINDING.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    description: HEADLINE_FINDING,
    source: "RECRUITER_QUALITY",
    severity: "BLOCKING",
    artifact: "resume",
    section: "tagline",
    proposedCorrectionType: "REPAIR_TARGET_POSITIONING",
    automaticRepairSafe: true,
    evidenceSource: [
      "recruiterQualityAssessment.targetRoleClarity",
      "jdPriorityMatrix.targetRoleTitle",
      "candidate evidence",
    ],
    reason: HEADLINE_FINDING,
    candidateInputRequired: false,
  });
  assert.equal(plan.operations?.length, 1);
  assert.equal(plan.operations?.[0]?.operation, "REPAIR_TARGET_POSITIONING");
  assert.deepEqual(plan.editablePaths, ["resume.tagline"]);
  assert.match(renderRepairPlanSection(plan), /Do not blindly copy the JD title/);
});

test("advisory bullet ordering never enters repair extraction", () => {
  const roots = extractRootRepairFindings(
    review({
      recruiterQualityAssessment: {
        status: "PASS",
        score: 90,
        issues: [{ dimension: "topBulletRelevance", severity: "ADVISORY", description: "Consider reordering a later bullet." }],
      },
    })
  );
  assert.deepEqual(roots, []);
});

test("blocking and advisory recruiter findings produce only the blocking repair", () => {
  const input = review();
  input.recruiterQualityAssessment!.issues.push({
    dimension: "topBulletRelevance",
    severity: "ADVISORY",
    description: "Optional bullet ordering could be stronger.",
  });
  const plan = planRepairScope(input, { resume: resume() });
  assert.equal(plan.rootFindings?.length, 1);
  assert.deepEqual(plan.editablePaths, ["resume.tagline"]);
});

test("canonical and recruiter echoes deduplicate to one root repair", () => {
  const input = review({ blockingIssues: [HEADLINE_FINDING] });
  const plan = planRepairScope(input, { resume: resume() });
  assert.equal(plan.rootFindings?.length, 1);
  assert.equal(plan.operations?.length, 1);
  assert.deepEqual(plan.editablePaths, ["resume.tagline"]);
});

test("finalValidation remains excluded from recruiter content repairs", () => {
  const input = review();
  input.instructionCompliance!.checks.finalValidation = "FAIL";
  input.instructionCompliance!.checkNotes = { finalValidation: ["A derived meta failure."] };
  const plan = planRepairScope(input, { resume: resume() });
  assert.equal(plan.rootFindings?.length, 1);
  assert.doesNotMatch(JSON.stringify(plan), /derived meta failure|finalValidation/);
});

test("headline repair rejects a collateral summary rewrite", () => {
  const baseline = resume();
  const repaired = clone(baseline);
  repaired.tagline = "Cloud Data Engineer";
  repaired.summary[0] = "Collateral summary rewrite.";
  const result = validateRepairPreservation({
    baselineResume: baseline,
    repairedResume: repaired,
    repairPlan: planRepairScope(review(), { resume: baseline }),
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.includes("resume.summary[0]"));
});

test("headline repair rejects collateral bullet changes", () => {
  const baseline = resume();
  const repaired = clone(baseline);
  repaired.tagline = "Cloud Data Engineer";
  repaired.experience[0]!.bullets[0] = "Collateral bullet rewrite.";
  const result = validateRepairPreservation({
    baselineResume: baseline,
    repairedResume: repaired,
    repairPlan: planRepairScope(review(), { resume: baseline }),
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.includes("resume.experience[0].bullets[0]"));
});

test("unsupported CloudWatch is not authorized or introduced by headline repair", () => {
  const plan = planRepairScope(review(), { resume: resume() });
  const repairContract = JSON.stringify({ operations: plan.operations, editablePaths: plan.editablePaths });
  assert.doesNotMatch(repairContract, /CloudWatch/);
  assert.deepEqual(plan.editablePaths, ["resume.tagline"]);
});

test("resolved Data Governance and employer-attribution defects do not return in the repair plan", () => {
  const plan = planRepairScope(review(), { resume: resume() });
  assert.doesNotMatch(JSON.stringify(plan), /Data Governance|EMPLOYER_CONTRADICTION|Fiserv|Microgate/);
});

test("humanMaySend is recomputed by the complete existing gate after positioning clears", () => {
  const baseline = resume();
  assert.equal(evaluateApplicationReadiness(review(), 2, 2).humanMaySend, false);

  const repaired = clone(baseline);
  repaired.tagline = "Cloud Data Engineer";
  const recruiterQualityAssessment = evaluateRecruiterQuality({
    resume: repaired,
    matrix: review().jdPriorityMatrix!,
    candidateProfile: undefined,
    genericBulletsCount: 0,
    bannedLanguageCount: 0,
    duplicateBulletCount: 0,
    recruiterReadabilityScore: 100,
  });
  assert.equal(recruiterQualityAssessment.status, "PASS");

  const revalidated = review({ recruiterQualityAssessment });
  const readiness = evaluateApplicationReadiness(revalidated, 2, 2);
  assert.equal(readiness.readiness, "READY_FOR_HUMAN_APPLICATION");
  assert.equal(readiness.humanMaySend, true);
});
