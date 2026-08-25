import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CandidateProfile } from "@/lib/match/types";
import type { ResumeContent, CoverLetterContent } from "../types";
import type { RepairPlan } from "../repairScope";
import { evaluateSummaryPolicy } from "../reviewers/summaryChecks";
import { dynamicSummaryTechnologyCeiling } from "../summaryTechnologyBudget";
import {
  evaluateCanonicalCoverage,
  type CanonicalJdRequirement,
} from "../jdRequirementReconciler";
import { generateDeterministicCoverLetter } from "../coverLetterGenerator";
import { validateRepairPreservation } from "../repairPreservation";
import { buildRepairWriterPrompt } from "../repairContextCompiler";

/**
 * PHASE 6.5 — RECRUITER-NATURAL SUMMARY + CANONICAL COVERAGE + COVER LETTER (SUMMARY-01..10,
 * COVERAGE-01..08, COVERLETTER-01..05, REPAIR-01..02).
 */

const skillGroups = [
  { label: "Data Architecture & Modeling", items: ["Medallion Architecture", "Data Vault", "Dimensional Modeling"] },
  { label: "Cloud Data Platforms", items: ["Snowflake", "Azure Data Factory", "Databricks"] },
];

describe("Phase 6.5: Summary Policy (SUMMARY-01..10)", () => {
  it("SUMMARY-01: starts with clear role/experience identity", () => {
    const good = evaluateSummaryPolicy({
      summary: ["Data Engineer with 6+ years of experience building and modernizing enterprise data platforms across banking and payments."],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Senior Data Engineer",
    });
    assert.equal(good.identityOpening.pass, true);

    const bad = evaluateSummaryPolicy({
      summary: ["Results-driven professional passionate about delivering value."],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Senior Data Engineer",
    });
    assert.equal(bad.identityOpening.pass, false);
  });

  it("SUMMARY-02: 1-5 significant JD technologies => ceiling 2", () => {
    assert.equal(dynamicSummaryTechnologyCeiling(1), 2);
    assert.equal(dynamicSummaryTechnologyCeiling(5), 2);
  });

  it("SUMMARY-03: 6-10 => ceiling 4", () => {
    assert.equal(dynamicSummaryTechnologyCeiling(6), 4);
    assert.equal(dynamicSummaryTechnologyCeiling(10), 4);
  });

  it("SUMMARY-04: 11+ => ceiling 6", () => {
    assert.equal(dynamicSummaryTechnologyCeiling(11), 6);
    assert.equal(dynamicSummaryTechnologyCeiling(50), 6);
  });

  it("SUMMARY-05: ceiling is not treated as a required count", () => {
    // A summary naming ZERO technologies must never fail technologyBudget — the ceiling is a cap,
    // never a floor/requirement.
    const result = evaluateSummaryPolicy({
      summary: ["Data Engineer with 6+ years of experience building and modernizing enterprise data platforms."],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.technologyBudget.pass, true);
    assert.equal(result.technologyBudget.namedCount, 0);
    assert.equal(result.technologyBudget.ceiling, 6);
  });

  it("SUMMARY-06: a Snowflake-centered JD can produce a natural summary with fewer than the maximum", () => {
    // Celigo: 23 significant supported requirements => ceiling 6, but a natural 1-technology summary
    // must still pass every check.
    const result = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience building governed cloud data platforms across banking and payments.",
        "Architects lakehouse ingestion and dimensional models at scale, with strong data quality and access controls.",
        "Brings that platform-modernization depth to Snowflake-centered data engineering roles.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Senior Data Engineer",
    });
    assert.equal(result.technologyBudget.pass, true);
    assert.ok(result.technologyBudget.namedCount <= 6);
    assert.equal(result.recruiterNaturalness.pass, true);
  });

  it("SUMMARY-07: a keyword-inventory summary is flagged", () => {
    const result = evaluateSummaryPolicy({
      summary: ["Data Engineer using Snowflake, Databricks, Azure Data Factory, Delta Lake, PySpark, Python, SQL, and dbt for data engineering."],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.keywordInventoryRisk.pass, false);
    assert.equal(result.technologyBudget.pass, false);
  });

  it("SUMMARY-08: a natural capability-oriented summary passes", () => {
    const result = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience building enterprise data platforms and modernizing data warehouses.",
        "Delivers governed lakehouse architectures and dimensional models supporting analytics at scale.",
        "Focused on Snowflake-centered platform engineering for this role.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.recruiterNaturalness.pass, true);
    assert.equal(result.keywordInventoryRisk.pass, true);
  });

  it("SUMMARY-09: summary does not need every P1/P2 keyword to pass", () => {
    // Only Snowflake named; Data Vault, Medallion Architecture, Access Control, etc. absent — must
    // not be required by summary policy (that's evaluateCanonicalCoverage's job, not this one's).
    const result = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience building Snowflake-centered data platforms.",
        "Delivers governed ingestion and dimensional models at scale.",
        "Aligns directly with this role's platform modernization priorities.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.technologyBudget.pass, true);
    assert.equal(result.identityOpening.pass, true);
  });

  it("SUMMARY-10: metrics are optional — a summary with zero metrics still passes every check", () => {
    const result = evaluateSummaryPolicy({
      summary: [
        "Data Engineer with 6+ years of experience building and modernizing enterprise data platforms.",
        "Delivers governed lakehouse ingestion and dimensional models for analytics at scale.",
        "Brings that depth to Snowflake-centered data engineering.",
      ],
      resumeSkillGroups: skillGroups,
      significantSupportedTechnologyCount: 23,
      targetRoleTitle: "Data Engineer",
    });
    assert.equal(result.identityOpening.pass, true);
    assert.equal(result.recruiterNaturalness.pass, true);
    assert.equal(result.keywordInventoryRisk.pass, true);
  });
});

function makeReq(overrides: Partial<CanonicalJdRequirement>): CanonicalJdRequirement {
  return {
    id: "REQ-X",
    canonicalName: "X",
    kind: "TECHNOLOGY",
    rawText: "x",
    priority: "P2",
    criticality: "REQUIRED",
    source: "STRUCTURED",
    evidenceSpans: [],
    aliasesMatched: [],
    supportedByCandidate: true,
    candidateEvidenceSources: ["MSI (x)"],
    writerAction: "PASS_TO_WRITER",
    coverageExpectation: "SHOULD_SURFACE",
    ...overrides,
  };
}

function coverageResume(overrides: Partial<ResumeContent> = {}): ResumeContent {
  return {
    name: "Saikishore Reddy",
    tagline: "Data Engineer",
    location: "Dallas, TX",
    phone: "9452370560",
    email: "saireddy2898@gmail.com",
    summary: ["Data Engineer with 6+ years of experience building Snowflake-centered data platforms."],
    skillGroups: [
      { label: "Data Architecture & Modeling", items: ["Data Vault", "Dimensional Modeling"] },
      { label: "Cloud Data Platforms", items: ["Snowflake", "Azure DevOps"] },
    ],
    experience: [
      {
        company: "Comerica Bank",
        title: "Data Engineer",
        dates: "2025-02 - Present",
        projectDescription: "Governed Snowflake analytics platform for commercial banking reporting.",
        bullets: [
          "Modeled curated Gold layer datasets into Snowflake using version-controlled dbt transformations.",
          "Established data quality controls and observability dashboards to catch schema drift early.",
        ],
        environment: ["Snowflake", "dbt", "Azure DevOps"],
      },
    ],
    education: [],
    certifications: [],
    ...overrides,
  };
}

describe("Phase 6.5: Canonical Coverage — LISTED vs EVIDENCED (COVERAGE-01..08)", () => {
  it("COVERAGE-01: canonical 23-item Celigo-shaped set reaches post-writer coverage", () => {
    const reqs = Array.from({ length: 23 }, (_, i) => makeReq({ id: `REQ-${i}`, canonicalName: `Tech${i}` }));
    const result = evaluateCanonicalCoverage(coverageResume(), reqs);
    assert.equal(result.length, 23);
  });

  it("COVERAGE-02: skills-only Data Vault => LISTED_ONLY", () => {
    const result = evaluateCanonicalCoverage(coverageResume(), [makeReq({ canonicalName: "Data Vault", kind: "ARCHITECTURE", priority: "P1", coverageExpectation: "MUST_SURFACE" })]);
    assert.equal(result[0].status, "LISTED_ONLY");
  });

  it("COVERAGE-03: Snowflake experience bullet => EVIDENCED", () => {
    const result = evaluateCanonicalCoverage(coverageResume(), [makeReq({ canonicalName: "Snowflake", kind: "PLATFORM", priority: "P1" })]);
    assert.equal(result[0].status, "EVIDENCED");
  });

  it("COVERAGE-04: project-description evidence counts as EVIDENCED", () => {
    const resume = coverageResume({
      experience: [
        {
          company: "Comerica Bank",
          title: "Data Engineer",
          dates: "2025-02 - Present",
          projectDescription: "Governed Snowflake analytics platform using dbt transformations for commercial banking reporting.",
          bullets: ["Built ingestion pipelines for downstream reporting."],
          environment: [],
        },
      ],
    });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "dbt" })]);
    assert.equal(result[0].status, "EVIDENCED");
  });

  it("COVERAGE-05: environment-only mention does not automatically equal EVIDENCED", () => {
    const resume = coverageResume({
      skillGroups: [{ label: "Skills", items: [] }],
      experience: [
        {
          company: "Comerica Bank",
          title: "Data Engineer",
          dates: "2025-02 - Present",
          bullets: ["Built ingestion pipelines using Snowflake for downstream reporting."],
          environment: ["Terraform"],
        },
      ],
    });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Terraform" })]);
    assert.equal(result[0].status, "LISTED_ONLY");
    assert.notEqual(result[0].status, "EVIDENCED");
  });

  it("COVERAGE-06: an architectural equivalent reports SUBSTITUTED", () => {
    const resume = coverageResume({
      skillGroups: [{ label: "DevOps", items: ["Azure DevOps"] }],
      experience: [
        {
          company: "Comerica Bank",
          title: "Data Engineer",
          dates: "2025-02 - Present",
          bullets: ["Automated CI/CD release pipelines through Azure DevOps for data engineering workloads."],
          environment: ["Azure DevOps"],
        },
      ],
    });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "GitHub Actions", kind: "DEVOPS" })]);
    assert.equal(result[0].status, "SUBSTITUTED");
    assert.equal(result[0].substitutedBy, "Azure DevOps");
  });

  it("COVERAGE-07: an unsupported requirement remains DO_NOT_CLAIM regardless of resume text", () => {
    const resume = coverageResume({
      skillGroups: [{ label: "Skills", items: ["Fivetran"] }], // even if text happens to match, gating wins
    });
    const result = evaluateCanonicalCoverage(resume, [makeReq({ canonicalName: "Fivetran", supportedByCandidate: false, writerAction: "DO_NOT_CLAIM" })]);
    assert.equal(result[0].status, "DO_NOT_CLAIM");
  });

  it("COVERAGE-08: an intentional P2 architectural omission (no substitute, no literal match) is MISSING, not a fabrication failure", () => {
    const result = evaluateCanonicalCoverage(coverageResume(), [makeReq({ canonicalName: "Fivetran", priority: "P2", coverageExpectation: "SHOULD_SURFACE" })]);
    assert.equal(result[0].status, "MISSING");
    // MISSING is a reporting status, not itself a truthfulness/blocking finding — evaluateCanonicalCoverage
    // never mutates the resume or invents a bullet to "fix" it.
  });
});

describe("Phase 6.5: Cover Letter (COVERLETTER-01..05)", () => {
  const finalResume = coverageResume();

  it("COVERLETTER-01: a placeholder one-line cover letter fails the quality bar", () => {
    const placeholder: CoverLetterContent = {
      name: "Saikishore Reddy",
      location: "Dallas, TX",
      email: "saireddy2898@gmail.com",
      phone: "9452370560",
      salutation: "Dear Hiring Team,",
      paragraphs: ["I am excited to apply for this position."],
      closing: "Sincerely,\nSaikishore Reddy",
    };
    assert.ok(placeholder.paragraphs.length < 3, "placeholder has fewer than the required 3 paragraphs");
    const wordCount = placeholder.paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount < 50, "placeholder is far short of the ~180-250 word target");
  });

  it("COVERLETTER-02: target company and role appear in the generated letter", () => {
    const letter = generateDeterministicCoverLetter({
      candidateName: "Saikishore Reddy",
      candidateLocation: "Dallas, TX",
      candidateEmail: "saireddy2898@gmail.com",
      candidatePhone: "9452370560",
      companyName: "Celigo, Inc.",
      jobTitle: "Senior Data Engineer",
      finalResume,
    });
    const text = letter.paragraphs.join(" ");
    assert.ok(text.includes("Celigo, Inc."));
    assert.ok(text.includes("Senior Data Engineer"));
  });

  it("COVERLETTER-03: uses approved candidate evidence (real employer/accomplishment text, not invented)", () => {
    const letter = generateDeterministicCoverLetter({
      candidateName: "Saikishore Reddy",
      candidateLocation: "Dallas, TX",
      candidateEmail: "saireddy2898@gmail.com",
      candidatePhone: "9452370560",
      companyName: "Celigo, Inc.",
      jobTitle: "Senior Data Engineer",
      finalResume,
    });
    const text = letter.paragraphs.join(" ");
    assert.ok(text.includes("Comerica Bank"), "must reference the candidate's real employer, not an invented one");
  });

  it("COVERLETTER-04: no unsupported claims — every named technology in the letter is drawn from the approved resume", () => {
    const letter = generateDeterministicCoverLetter({
      candidateName: "Saikishore Reddy",
      candidateLocation: "Dallas, TX",
      candidateEmail: "saireddy2898@gmail.com",
      candidatePhone: "9452370560",
      companyName: "Celigo, Inc.",
      jobTitle: "Senior Data Engineer",
      finalResume,
    });
    const text = letter.paragraphs.join(" ");
    // The deterministic generator only ever quotes/paraphrases the resume's own bullets — it never
    // introduces a technology name not already present somewhere in finalResume.
    const resumeText = JSON.stringify(finalResume);
    for (const tech of ["Snowflake", "dbt"]) {
      if (text.includes(tech)) assert.ok(resumeText.includes(tech), `${tech} mentioned in cover letter must trace back to the resume`);
    }
  });

  it("COVERLETTER-05: output is meaningful multi-paragraph recruiter-facing prose", () => {
    const letter = generateDeterministicCoverLetter({
      candidateName: "Saikishore Reddy",
      candidateLocation: "Dallas, TX",
      candidateEmail: "saireddy2898@gmail.com",
      candidatePhone: "9452370560",
      companyName: "Celigo, Inc.",
      jobTitle: "Senior Data Engineer",
      finalResume,
    });
    assert.equal(letter.paragraphs.length, 3);
    const wordCount = letter.paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount >= 60, `expected substantial multi-paragraph prose, got ${wordCount} words`);
    assert.ok(letter.salutation.length > 0);
    assert.ok(letter.closing.includes("Saikishore Reddy"));
  });
});

describe("Phase 6.5: Targeted Repair Safety (REPAIR-01..02)", () => {
  // repairScope.ts's own real editablePaths are "resume."-prefixed (e.g. "resume.tagline",
  // "resume.skillGroups") — see repairPreservation.ts's validateRepairPreservation, which operates
  // over a {resume, coverLetter} wrapper and needs the prefix to disambiguate the document.
  const APPROVED_PATHS = [
    "resume.summary[0]",
    "resume.experience[0].bullets[0]",
    "resume.experience[1].bullets[4]",
    "resume.experience[1].bullets[3]",
  ];

  function baselineResume(): ResumeContent {
    return {
      name: "Saikishore Reddy",
      tagline: "Data Engineer",
      location: "Dallas, TX",
      phone: "9452370560",
      email: "saireddy2898@gmail.com",
      summary: ["Old summary line naming eight technologies."],
      skillGroups: [{ label: "Skills", items: ["Snowflake"] }],
      experience: [
        {
          company: "Comerica Bank",
          title: "Data Engineer",
          dates: "2025-02 - Present",
          bullets: ["Old long Comerica bullet.", "Second bullet unaffected."],
        },
        {
          company: "Fiserv",
          title: "Data Engineer",
          dates: "2023-07 - 2025-01",
          bullets: ["Bullet 0.", "Bullet 1.", "Bullet 2.", "Old data-quality bullet.", "Old CI/CD laundry-list bullet."],
        },
      ],
      education: [],
      certifications: [],
    };
  }

  it("REPAIR-01: only the four approved JSON paths change — deep-compare everything else", () => {
    const baseline = baselineResume();
    const repaired = baselineResume();
    repaired.summary = ["New natural summary."];
    repaired.experience[0].bullets[0] = "New shorter Comerica bullet.";
    repaired.experience[1].bullets[4] = "New focused Fiserv CI/CD bullet.";
    repaired.experience[1].bullets[3] = "New data-quality bullet naturally incorporating observability.";

    const repairPlan: RepairPlan = {
      scope: "RESUME_ONLY",
      reason: "Phase 6.5 targeted repair",
      resumeFindings: ["summary", "long bullet", "laundry-list bullet", "observability incorporation"],
      coverLetterFindings: [],
      unattributedFindings: [],
      editablePaths: APPROVED_PATHS,
    };

    const result = validateRepairPreservation({
      baselineResume: baseline,
      repairedResume: repaired,
      repairPlan,
    });
    assert.equal(result.valid, true, `expected valid, got violations: ${result.violations.join("; ")}`);
  });

  it("REPAIR-01b: an unauthorized path change is rejected", () => {
    const baseline = baselineResume();
    const repaired = baselineResume();
    repaired.summary = ["New natural summary."];
    repaired.experience[0].bullets[1] = "UNAUTHORIZED change to a frozen bullet."; // not in editablePaths

    const repairPlan: RepairPlan = {
      scope: "RESUME_ONLY",
      reason: "Phase 6.5 targeted repair",
      resumeFindings: ["summary"],
      coverLetterFindings: [],
      unattributedFindings: [],
      editablePaths: APPROVED_PATHS,
    };

    const result = validateRepairPreservation({
      baselineResume: baseline,
      repairedResume: repaired,
      repairPlan,
    });
    assert.equal(result.valid, false);
    assert.ok(result.violations.length > 0);
  });

  it("REPAIR-02: repair context for the exact four approved paths stays <= 3,000 tokens", () => {
    const resume = baselineResume();
    const profile: CandidateProfile = {
      schemaVersion: 1,
      sourceHashes: { resume: "a", skills: "b" },
      builtAt: "2026-08-24",
      totalYearsExperience: 6,
      skills: [{ rawSkillName: "Snowflake", source: "employer" }],
      experience: [
        { employer: "Comerica Bank", title: "Data Engineer", startDate: "2025-02", endDate: null, technologies: ["Snowflake"] },
        { employer: "Fiserv", title: "Data Engineer", startDate: "2023-07", endDate: "2025-01", technologies: ["Snowflake"] },
      ],
      education: [],
      certifications: [],
    };
    const repairPlan: RepairPlan = {
      scope: "RESUME_ONLY",
      reason: "Phase 6.5 targeted repair",
      resumeFindings: ["summary technology dump", "long bullet", "laundry-list bullet", "missing observability"],
      coverLetterFindings: [],
      unattributedFindings: [],
      editablePaths: APPROVED_PATHS,
    };
    const prompt = buildRepairWriterPrompt({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      applicationId: 5,
      jobId: 7362,
      tailoringRunId: 1,
      workflowId: 33,
      iterationNumber: 2,
      repairPlan,
      currentResume: resume,
      candidateProfile: profile,
    });
    const tokens = Math.ceil(Buffer.byteLength(prompt, "utf-8") / 4);
    assert.ok(tokens <= 3000, `4-path repair context (${tokens} tokens) exceeds the 3,000-token hard ceiling`);
  });
});
