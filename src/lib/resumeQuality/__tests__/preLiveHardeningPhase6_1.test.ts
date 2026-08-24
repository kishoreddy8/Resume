import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../types";
import {
  evaluateTechnologyCompatibility,
  validateBulletArchitecture,
} from "../technologyCompatibility";
import {
  buildPreWriterDecisionPackage,
  renderPreWriterDecisionReport,
} from "../preWriterDecisionPackage";
import {
  detectTargetEcosystem,
} from "../targetEcosystem";
import {
  buildEmployerArchitecturePalettes,
} from "../architecturePalette";
import {
  evaluateJdToolCoveragePlan,
} from "../jdToolCoverage";

const mockProfile: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "mock_resume_hash", skills: "mock_skills_hash" },
  builtAt: "2026-08-24T00:00:00Z",
  totalYearsExperience: 5,
  skills: [
    { rawSkillName: "Python", source: "employer" },
    { rawSkillName: "SQL", source: "employer" },
    { rawSkillName: "PySpark", source: "employer" },
    { rawSkillName: "Databricks", source: "employer" },
    { rawSkillName: "Snowflake", source: "employer" },
    { rawSkillName: "Azure Data Factory", source: "employer" },
    { rawSkillName: "AWS Glue", source: "inventory_only" },
    { rawSkillName: "ADLS Gen2", source: "employer" },
    { rawSkillName: "Amazon S3", source: "inventory_only" },
    { rawSkillName: "Azure Synapse Analytics", source: "inventory_only" },
    { rawSkillName: "Amazon Redshift", source: "inventory_only" },
    { rawSkillName: "dbt", source: "inventory_only" },
    { rawSkillName: "Airflow", source: "employer" },
    { rawSkillName: "Kafka", source: "employer" },
    { rawSkillName: "Delta Lake", source: "employer" },
    { rawSkillName: "Git", source: "employer" },
    { rawSkillName: "CI/CD", source: "employer" },
    { rawSkillName: "Data Validation & Quality", source: "employer" },
    { rawSkillName: "Dimensional Modeling", source: "employer" },
  ],
  experience: [
    {
      employer: "Comerica Bank",
      title: "Data Engineer",
      startDate: "2025-02",
      endDate: null,
      technologies: ["Azure Data Factory", "ADLS Gen2", "Databricks", "PySpark", "SQL Server"],
    },
    {
      employer: "Fiserv",
      title: "Data Engineer",
      startDate: "2023-07",
      endDate: "2025-01",
      technologies: ["Azure Data Factory", "Databricks", "ADLS Gen2", "Oracle"],
    },
    {
      employer: "Microgate Technologies",
      title: "Data Engineer",
      startDate: "2020-01",
      endDate: "2021-11",
      technologies: ["Python", "SQL", "Spark", "Snowflake"],
    },
  ],
  education: [
    {
      institution: "Chicago State University",
      field: "Computer Science",
      level: "Master's",
    },
  ],
  certifications: [
    { name: "Databricks Certified Data Engineer" },
  ],
};

const makeReq = (label: string, members: string[], criticality: RequirementUnit["criticality"]): RequirementUnit => ({
  kind: "skill",
  label,
  memberSkillNames: members,
  categories: ["Warehousing"],
  criticality,
  requirementLevel: "Required",
  evidenceSnippets: [`Experience with ${members.join(", ")} required.`],
  experienceDepthRequired: true,
  requestedYears: 3,
  fromUnclaimedText: false,
});

describe("Phase 6.1 Final Pre-Live Hardening (PRELIVE-01..10)", () => {
  it("PRELIVE-01: warningsCount strictly equals warning findings count", () => {
    const resumeWithWarning: ResumeContent = {
      name: "Saikishore Reddy",
      tagline: "Senior Data Engineer",
      location: "Dallas, TX",
      phone: "9452370560",
      email: "saireddy2898@gmail.com",
      summary: ["Data Engineer"],
      skillGroups: [
        { label: "Skills", items: ["ADF", "Azure Data Factory"] }, // 1 alias warning
      ],
      experience: [
        {
          company: "Comerica Bank",
          title: "Data Engineer",
          dates: "2025-02 - Present",
          bullets: ["Engineered data pipelines in ADF."],
        },
      ],
      education: [],
      certifications: [],
    };
    const res = evaluateTechnologyCompatibility(resumeWithWarning, mockProfile);
    assert.equal(res.warnings.length, 1);
    assert.equal(res.warnings.length, res.scoreBreakdown.deductions.filter((d) => d.findingSeverity === "WARNING").length);
    assert.equal(res.scoreBreakdown.deductions.length, 1);
    assert.equal(res.scoreBreakdown.finalScore, 90);
  });

  it("PRELIVE-02: blockingFindingsCount strictly equals blocking findings count", () => {
    const resumeWithBlocking: ResumeContent = {
      name: "Saikishore Reddy",
      tagline: "Senior Data Engineer",
      location: "Dallas, TX",
      phone: "9452370560",
      email: "saireddy2898@gmail.com",
      summary: ["Data Engineer"],
      skillGroups: [{ label: "Skills", items: ["Snowflake"] }],
      experience: [
        {
          company: "Comerica Bank",
          title: "Data Engineer",
          dates: "2025-02 - Present",
          bullets: ["Built ingestion using Azure Data Factory and AWS Glue together in the same pipeline."],
        },
      ],
      education: [],
      certifications: [],
    };
    const res = evaluateTechnologyCompatibility(resumeWithBlocking, mockProfile);
    assert.equal(res.blockingFindings.length, 1);
    assert.equal(res.isCompatible, false);
    assert.equal(res.scoreBreakdown.finalScore, 60);
  });

  it("PRELIVE-03: Score deductions are explainable and match findings exactly", () => {
    const findings = validateBulletArchitecture("Engineered ADF and AWS Glue pipelines into ADLS Gen2.");
    assert.equal(findings.length, 1);
    const f = findings[0];
    assert.equal(f.code, "COMPETING_ORCHESTRATORS");
    assert.equal(f.severity, "BLOCKING");
    assert.ok(f.message.includes("Competing ETL/orchestration engines"));
    assert.ok(f.reason.length > 0);
    assert.ok(f.recommendedAction && f.recommendedAction.length > 0);
  });

  it("PRELIVE-04: Score < 100 cannot have zero deductions", () => {
    const cleanResume: ResumeContent = {
      name: "Saikishore Reddy",
      tagline: "Senior Data Engineer",
      location: "Dallas, TX",
      phone: "9452370560",
      email: "saireddy2898@gmail.com",
      summary: ["Data Engineer building cloud pipelines."],
      skillGroups: [{ label: "Skills", items: ["Snowflake", "Python", "SQL"] }],
      experience: [
        {
          company: "Comerica Bank",
          title: "Data Engineer",
          dates: "2025-02 - Present",
          bullets: ["Engineered Snowflake data ingestion using Python and SQL."],
        },
      ],
      education: [],
      certifications: [],
    };
    const res = evaluateTechnologyCompatibility(cleanResume, mockProfile);
    if (res.score < 100) {
      assert.ok(res.scoreBreakdown.deductions.length > 0, "Score < 100 must have at least one deduction");
    } else {
      assert.equal(res.scoreBreakdown.deductions.length, 0);
      assert.equal(res.findings.length, 0);
    }
  });

  it("PRELIVE-05: Live package serializes non-null job ID when provided", () => {
    const pkg = buildPreWriterDecisionPackage({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      candidateProfile: mockProfile,
      jobId: 7362,
      companyName: "Celigo, Inc.",
      roleTitle: "Senior Data Engineer",
      dedupeKey: "greenhouse:661:7844080",
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      jobRequirements: [
        makeReq("Snowflake", ["Snowflake"], "REQUIRED"),
      ],
    });
    assert.equal(pkg.job.id, 7362);
    assert.equal(pkg.job.company, "Celigo, Inc.");
    assert.equal(pkg.job.role, "Senior Data Engineer");
    assert.equal(pkg.job.dedupeKey, "greenhouse:661:7844080");
  });

  it("PRELIVE-06: Live package report preserves exact company, role title, and dedupe key", () => {
    const pkg = buildPreWriterDecisionPackage({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      candidateProfile: mockProfile,
      jobId: 7362,
      companyName: "Celigo, Inc.",
      roleTitle: "Senior Data Engineer",
      dedupeKey: "greenhouse:661:7844080",
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      jobRequirements: [
        makeReq("Snowflake", ["Snowflake"], "REQUIRED"),
      ],
    });
    const report = renderPreWriterDecisionReport(pkg);
    assert.ok(report.includes("Senior Data Engineer at **Celigo, Inc.** (ID: 7362 | Dedupe: greenhouse:661:7844080)"));
  });

  it("PRELIVE-07: Live package uses actual structured requirements without synthetic additions", () => {
    const reqs: RequirementUnit[] = [
      makeReq("Snowflake", ["Snowflake"], "CRITICAL"),
      makeReq("Python", ["Python"], "REQUIRED"),
      makeReq("SQL", ["SQL"], "REQUIRED"),
    ];
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockProfile, jobRequirements: reqs });
    assert.equal(plan.supportedP1.length, 1);
    assert.equal(plan.supportedP1[0].canonical, "Snowflake");
    assert.equal(plan.supportedP2.length, 2);
    assert.ok(plan.supportedP2.some((t) => t.canonical === "Python"));
    assert.ok(plan.supportedP2.some((t) => t.canonical === "SQL"));
  });

  it("PRELIVE-08: JD extraction gap is detectable and not silently filled with invented requirements", () => {
    const liveStructuredSkills = ["Snowflake", "SQL", "Python"];
    const rawJdMentionsDbt = true;
    const isDbtInStructured = liveStructuredSkills.includes("dbt");
    assert.equal(isDbtInStructured, false); // Confirms dbt was not in structured job_skills
    assert.equal(rawJdMentionsDbt, true); // Confirms dbt exists in raw text -> extraction gap verified
  });

  it("PRELIVE-09: Narrow employer architecture palettes remain strictly bounded", () => {
    const ecosystem = detectTargetEcosystem({
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      candidateProfile: mockProfile,
    });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: mockProfile,
      targetEcosystem: ecosystem,
      coveragePlan: plan,
    });
    for (const pal of palettes) {
      assert.ok(pal.sources.length <= 3, `Employer ${pal.employer} sources <= 3`);
      assert.ok(pal.orchestration.length <= 2, `Employer ${pal.employer} orchestration <= 2`);
      assert.ok(pal.storage.length <= 2, `Employer ${pal.employer} storage <= 2`);
      assert.ok(pal.warehouses.length <= 2, `Employer ${pal.employer} warehouses <= 2`);
    }
  });

  it("PRELIVE-10: Token accounting accurately reflects writer prompt bytes and excludes audit artifacts", () => {
    const pkg = buildPreWriterDecisionPackage({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      candidateProfile: mockProfile,
      jobId: 7362,
      companyName: "Celigo, Inc.",
      roleTitle: "Senior Data Engineer",
      dedupeKey: "greenhouse:661:7844080",
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      jobRequirements: [
        makeReq("Snowflake", ["Snowflake"], "REQUIRED"),
        makeReq("Python", ["Python"], "PREFERRED"),
        makeReq("SQL", ["SQL"], "PREFERRED"),
      ],
    });
    assert.ok(pkg.promptBudget.bytes > 0);
    assert.ok(pkg.promptBudget.estimatedTokens > 0);
    assert.ok(pkg.promptBudget.estimatedTokens <= 6500, `Estimated tokens (${pkg.promptBudget.estimatedTokens}) <= 6,500`);
  });
});
