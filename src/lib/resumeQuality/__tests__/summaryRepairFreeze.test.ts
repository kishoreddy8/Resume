import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";
import { planRepairScope } from "../repairScope";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES } from "../types";
import type { ComplianceStatus, InstructionComplianceChecks, ResumeContent, StructuredResumeReview } from "../types";

/**
 * SUMMARY QUALITY V2 (2026-08-23) — TARGETED_REPAIR RULE regression coverage.
 *
 * The "opportunistic rewrite" concern in the ticket ("a passing summary must not be rewritten by an
 * unrelated later repair") turned out, on inspection of repairScope.ts, to already be correctly
 * enforced by the existing architecture: a summary only becomes an editable path when a root finding
 * whose description matches /summary/i exists (operationKind() -> FIX_SUMMARY_SENTENCE). What was
 * actually missing was upstream of repairScope entirely — summaryChecks.ts's real quality findings
 * (abstract framing, target-role clarity, keyword stuffing, secondary-differentiator dominance,
 * missing JD-dominant technology) never became a compliance FAIL, so they never became a root
 * finding, so a genuinely weak summary was frozen right alongside a genuinely strong one — the
 * freeze mechanism worked, but nothing weak ever got a chance to be unfrozen.
 *
 * These two tests prove both halves of the fix directly against repairScope.ts's real logic (no
 * summaryChecks.ts call in this file — that module's own tests already cover which findings fire):
 *  1. A clean summary + an UNRELATED bullet-level finding must produce zero resume.summary[*]
 *     editable paths (still frozen — no regression from this session's wiring change).
 *  2. A summary carrying the new bannedLanguage checkNotes (exactly what
 *     deterministicReviewer.ts now populates from summary.styleIssuesFound) must produce
 *     resume.summary[*] editable paths (now genuinely unfrozen when it deserves to be).
 */

function allChecks(status: ComplianceStatus = "PASS"): InstructionComplianceChecks {
  const checks = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) checks[name] = status;
  return checks;
}

function resume(): ResumeContent {
  return {
    name: "Sai Reddy",
    tagline: "Senior Data Engineer",
    location: "Dallas, TX",
    phone: "5551112222",
    email: "sai@example.com",
    summary: [
      "Senior Data Engineer with 6 years building Azure data platforms across banking and healthcare.",
      "Hands-on experience with Azure Data Factory and Databricks pipelines across batch and real-time workloads.",
    ],
    skillGroups: [{ label: "Cloud & Data Platforms", items: ["Azure Databricks", "Delta Lake"] }],
    experience: [
      {
        title: "Data Engineer",
        company: "Comerica Bank",
        dates: "2022 - Present",
        projectDescription: "Built supported Azure data platforms for regulated banking workloads.",
        bullets: [
          "Engineered supported PySpark pipelines on Azure Databricks.",
          "Containerized services with Docker, orchestrated deployment through Azure DevOps + Jenkins pipelines.",
        ],
      },
    ],
    education: ["MS, Example University - 2022"],
    certifications: ["Azure Fundamentals"],
  };
}

function baseReview(overrides: Partial<StructuredResumeReview> = {}): StructuredResumeReview {
  return {
    overallScore: 82,
    atsScore: 94,
    keywordAlignmentScore: 94,
    truthfulnessScore: 100,
    architectureConsistencyScore: 100,
    recruiterReadabilityScore: 100,
    formattingScore: 100,
    missingRequiredSkills: [],
    incorrectTechnologyUsage: [],
    genericBullets: [],
    missingImpactEvidence: [],
    summaryIssues: [],
    skillsOrderingIssues: [],
    truthfulnessIssues: [],
    blockingIssues: ['Comerica Bank: "Azure DevOps + Jenkins" (competing CI/CD platforms) in one bullet with no migration/integration framing.'],
    requiredCorrections: [],
    blockingFailures: [],
    instructionCompliance: {
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      checks: allChecks(),
      notes: [],
    },
    ...overrides,
  } as StructuredResumeReview;
}

test("a clean, passing summary is frozen when only an unrelated bullet-level finding exists", () => {
  const review = baseReview();
  const plan = planRepairScope(review, { resume: resume() });
  assert.ok(plan.editablePaths, "plan must reach the surgical-scope branch");
  assert.equal(
    plan.editablePaths!.some((p) => p.startsWith("resume.summary")),
    false,
    "an unrelated CI/CD contradiction bullet finding must never opportunistically make the summary editable"
  );
  assert.ok(
    plan.editablePaths!.some((p) => p.startsWith("resume.experience[0].bullets")),
    "the actual flagged bullet must be editable"
  );
});

test("a summary carrying a real bannedLanguage compliance finding (from summaryChecks.styleIssuesFound) becomes editable", () => {
  const checks = allChecks();
  checks.bannedLanguage = "FAIL";
  const review = baseReview({
    blockingIssues: [], // isolate: no unrelated bullet finding this time
    instructionCompliance: {
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      checks,
      notes: [
        "Summary uses abstract, subject-driven framing instead of concrete action verbs: platform design spans.",
      ],
      checkNotes: {
        bannedLanguage: [
          "Summary uses abstract, subject-driven framing instead of concrete action verbs: platform design spans.",
        ],
      },
    },
  });
  const plan = planRepairScope(review, { resume: resume() });
  assert.ok(plan.editablePaths, "plan must reach the surgical-scope branch");
  assert.ok(
    plan.editablePaths!.some((p) => p.startsWith("resume.summary")),
    "a genuine summary-quality finding must make the summary an editable path"
  );
  assert.equal(
    plan.editablePaths!.some((p) => p.startsWith("resume.experience[0].bullets")),
    false,
    "a summary-only finding must not opportunistically widen scope to unrelated bullets"
  );
});
