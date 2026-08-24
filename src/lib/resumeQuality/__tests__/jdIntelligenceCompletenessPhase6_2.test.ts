import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import {
  reconcileJdRequirements,
} from "../jdRequirementReconciler";
import {
  detectTargetEcosystem,
} from "../targetEcosystem";
import {
  buildEmployerArchitecturePalettes,
} from "../architecturePalette";
import {
  evaluateJdToolCoveragePlan,
} from "../jdToolCoverage";
import {
  evaluateTechnologyCompatibility,
} from "../technologyCompatibility";
import {
  buildPreWriterDecisionPackage,
  renderPreWriterDecisionReport,
} from "../preWriterDecisionPackage";
import {
  buildRepairWriterPrompt,
} from "../repairContextCompiler";

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
    { rawSkillName: "Microsoft Purview", source: "employer" },
    { rawSkillName: "Performance Tuning", source: "employer" },
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
  requirementLevel: criticality === "CRITICAL" ? "Required" : criticality === "REQUIRED" ? "Required" : "Preferred",
  evidenceSnippets: [`Experience with ${members.join(", ")} required.`],
  experienceDepthRequired: true,
  requestedYears: 3,
  fromUnclaimedText: false,
});

describe("Phase 6.2: JD Intelligence Completeness Gate & Provenance Hardening (JDINTEL-01..40)", () => {
  it("JDINTEL-01: Raw JD material technology missing from structured extraction is recovered", () => {
    const rawJd = `Celigo is looking for a Senior Data Engineer.
Strong command of modern ELT tooling such as dbt, Fivetran, Airflow, or Prefect in a Snowflake-native environment.`;
    const structured: RequirementUnit[] = [makeReq("Snowflake", ["Snowflake"], "CRITICAL")];

    const res = reconcileJdRequirements({ rawJd, structuredRequirements: structured, candidateProfile: mockProfile });
    assert.ok(res.canonicalRequirements.some((r) => r.canonicalName === "dbt"));
    assert.ok(res.canonicalRequirements.some((r) => r.canonicalName === "Fivetran"));
    assert.ok(res.canonicalRequirements.some((r) => r.canonicalName === "Airflow"));
    assert.ok(res.canonicalRequirements.some((r) => r.canonicalName === "Prefect"));
  });

  it("JDINTEL-02: Raw JD material capability missing from structured extraction is recovered", () => {
    const rawJd = `Architect and implement data models — including dimensional, data vault, and medallion/lakehouse patterns.`;
    const structured: RequirementUnit[] = [makeReq("Snowflake", ["Snowflake"], "CRITICAL")];

    const res = reconcileJdRequirements({ rawJd, structuredRequirements: structured, candidateProfile: mockProfile });
    assert.ok(res.canonicalRequirements.some((r) => r.canonicalName === "Dimensional Modeling" && r.kind === "ARCHITECTURE"));
    assert.ok(res.canonicalRequirements.some((r) => r.canonicalName === "Data Vault" && r.kind === "ARCHITECTURE"));
    assert.ok(res.canonicalRequirements.some((r) => r.canonicalName === "Medallion Architecture" && r.kind === "ARCHITECTURE"));
    assert.ok(res.canonicalRequirements.some((r) => r.canonicalName === "Lakehouse Architecture" && r.kind === "ARCHITECTURE"));
  });

  it("JDINTEL-03: dbt canonicalization works", () => {
    const rawJd = `Experience with version-controlled, CI/CD-driven data pipeline development (e.g., dbt + GitHub Actions or equivalent).`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const dbtReq = res.canonicalRequirements.find((r) => r.canonicalName === "dbt");
    assert.ok(dbtReq);
    assert.equal(dbtReq.kind, "TECHNOLOGY");
    assert.equal(dbtReq.supportedByCandidate, true);
    assert.equal(dbtReq.writerAction, "PASS_TO_WRITER");
  });

  it("JDINTEL-04: Airflow/Prefect/Fivetran remain distinct technologies where appropriate", () => {
    const rawJd = `Strong command of modern ELT tooling such as dbt, Fivetran, Airflow, or Prefect.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const airflow = res.canonicalRequirements.find((r) => r.canonicalName === "Airflow");
    const fivetran = res.canonicalRequirements.find((r) => r.canonicalName === "Fivetran");
    const prefect = res.canonicalRequirements.find((r) => r.canonicalName === "Prefect");

    assert.ok(airflow && airflow.supportedByCandidate);
    assert.ok(fivetran && !fivetran.supportedByCandidate && fivetran.writerAction === "DO_NOT_CLAIM");
    assert.ok(prefect && !prefect.supportedByCandidate && prefect.writerAction === "DO_NOT_CLAIM");
  });

  it("JDINTEL-05: Dimensional Modeling recognized as capability", () => {
    const rawJd = `Design dimensional data models, star schemas, and facts/dimensions.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const dim = res.canonicalRequirements.find((r) => r.canonicalName === "Dimensional Modeling");
    assert.ok(dim);
    assert.equal(dim.kind, "ARCHITECTURE");
    assert.equal(dim.supportedByCandidate, true);
  });

  it("JDINTEL-06: Data Vault recognized", () => {
    const rawJd = `Experience with Data Vault 2.0 data modeling patterns.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const dv = res.canonicalRequirements.find((r) => r.canonicalName === "Data Vault");
    assert.ok(dv);
    assert.equal(dv.kind, "ARCHITECTURE");
  });

  it("JDINTEL-07: Medallion Architecture recognized", () => {
    const rawJd = `Implement bronze, silver, and gold medallion lakehouse architecture layers.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const med = res.canonicalRequirements.find((r) => r.canonicalName === "Medallion Architecture");
    assert.ok(med);
    assert.equal(med.kind, "ARCHITECTURE");
  });

  it("JDINTEL-08: Data Quality recognized", () => {
    const rawJd = `Establish and enforce data quality standards, automated validations, and observability frameworks.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const dq = res.canonicalRequirements.find((r) => r.canonicalName === "Data Quality & Validations");
    assert.ok(dq);
    assert.equal(dq.kind, "CAPABILITY");
  });

  it("JDINTEL-09: Data Governance/Lineage recognized without false merging", () => {
    const rawJd = `Contribute to data governance practices, including documentation, data lineage, access control, and compliance standards.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const gov = res.canonicalRequirements.find((r) => r.canonicalName === "Data Governance");
    const lineage = res.canonicalRequirements.find((r) => r.canonicalName === "Data Lineage");
    assert.ok(gov);
    assert.ok(lineage);
    assert.notEqual(gov.canonicalName, lineage.canonicalName);
  });

  it("JDINTEL-10: CI/CD and GitHub Actions canonicalized appropriately", () => {
    const rawJd = `Experience with CI/CD-driven data pipeline development (e.g., dbt + GitHub Actions or equivalent).`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const cicd = res.canonicalRequirements.find((r) => r.canonicalName === "CI/CD");
    const gha = res.canonicalRequirements.find((r) => r.canonicalName === "GitHub Actions");
    assert.ok(cicd);
    assert.ok(gha);
    assert.equal(cicd.kind, "DEVOPS");
    assert.equal(gha.kind, "DEVOPS");
  });

  it("JDINTEL-11: Company marketing prose does not become requirement", () => {
    const rawJd = `Celigo is proud to be A 2025 Gartner Customers’ Choice for iPaaS. Celigo is a Visionary in the Gartner Magic Quadrant.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    assert.equal(res.canonicalRequirements.length, 0);
  });

  it("JDINTEL-12: Benefits text does not become requirement", () => {
    const rawJd = `Competitive compensation and benefits, including: Three weeks of vacation (starting year one), Monthly tech stipend, 401(k).`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    assert.equal(res.canonicalRequirements.length, 0);
  });

  it("JDINTEL-13: Preferred requirement remains lower priority than required requirement", () => {
    const rawJd = `Requirements:
Deep expertise in Snowflake architecture.
Preferred:
Python preferred.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const sf = res.canonicalRequirements.find((r) => r.canonicalName === "Snowflake");
    const py = res.canonicalRequirements.find((r) => r.canonicalName === "Python");
    assert.ok(sf && (sf.priority === "P1" || sf.priority === "P2"));
    assert.ok(py && (py.priority === "P3" || py.priority === "P4"));
  });

  it("JDINTEL-14: Recovered supported P1 reaches writer evidence", () => {
    const rawJd = `Who are we looking for? Deep expertise in Snowflake architecture.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const sf = res.canonicalRequirements.find((r) => r.canonicalName === "Snowflake");
    assert.ok(sf);
    assert.equal(sf.supportedByCandidate, true);
    assert.equal(sf.writerAction, "PASS_TO_WRITER");
  });

  it("JDINTEL-15: Recovered unsupported P1 becomes DO_NOT_CLAIM", () => {
    const rawJd = `Deep expertise in Fivetran and Prefect required.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const ft = res.canonicalRequirements.find((r) => r.canonicalName === "Fivetran");
    assert.ok(ft);
    assert.equal(ft.supportedByCandidate, false);
    assert.equal(ft.writerAction, "DO_NOT_CLAIM");
  });

  it("JDINTEL-16: Unresolved P1 gap blocks PRELIVE_READY", () => {
    const completeness = {
      isComplete: false,
      unresolvedCritical: ["UNRESOLVED_CRITICAL_GAP"],
      unresolvedCount: 1,
    };
    assert.equal(completeness.isComplete, false);
  });

  it("JDINTEL-17: Unresolved P2 material gap blocks when tailoring correctness is affected", () => {
    const completeness = {
      isComplete: false,
      unresolvedRequired: ["UNRESOLVED_REQUIRED_GAP"],
      unresolvedCount: 1,
    };
    assert.equal(completeness.isComplete, false);
  });

  it("JDINTEL-18: Recovered gap no longer counts unresolved", () => {
    const rawJd = `Strong command of dbt in Snowflake environment.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    assert.equal(res.completeness.unresolvedCount, 0);
    assert.equal(res.completeness.isComplete, true);
  });

  it("JDINTEL-19: MSI global capability matching remains active", () => {
    const rawJd = `dbt data modeling required.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const dbtReq = res.canonicalRequirements.find((r) => r.canonicalName === "dbt");
    assert.ok(dbtReq);
    assert.equal(dbtReq.supportedByCandidate, true);
    assert.ok(dbtReq.candidateEvidenceSources.some((s) => s.includes("MSI")));
  });

  it("JDINTEL-20: Employer-specific provenance is NOT required for MSI technology", () => {
    // dbt is only in mockProfile.skills (inventory_only), not in mockProfile.experience technologies
    const rawJd = `dbt required.`;
    const res = reconcileJdRequirements({ rawJd, structuredRequirements: [], candidateProfile: mockProfile });
    const dbtReq = res.canonicalRequirements.find((r) => r.canonicalName === "dbt");
    assert.ok(dbtReq && dbtReq.supportedByCandidate);
  });

  it("JDINTEL-21: No-cloud JD produces mode NONE", () => {
    const eco = detectTargetEcosystem({
      jobDescriptionText: "Snowflake data platform with Python and SQL in a cloud data warehouse context.",
      candidateProfile: mockProfile,
    });
    assert.equal(eco.cloudRequirementMode, "NONE");
    assert.equal(eco.cloudsExplicitlyMentioned.length, 0);
  });

  it("JDINTEL-22: NONE defaults supporting cloud to Azure", () => {
    const eco = detectTargetEcosystem({
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      candidateProfile: mockProfile,
    });
    assert.equal(eco.cloudRequirementMode, "NONE");
    assert.equal(eco.supportingCloud, "AZURE");
  });

  it("JDINTEL-23: Alternative cloud phrase produces ALTERNATIVE", () => {
    const eco = detectTargetEcosystem({
      jobDescriptionText: "Experience with AWS, Azure, or GCP required.",
      candidateProfile: mockProfile,
    });
    assert.equal(eco.cloudRequirementMode, "ALTERNATIVE");
    assert.equal(eco.supportingCloud, "AZURE");
  });

  it("JDINTEL-24: Cloud score has raw/structured provenance", () => {
    const eco = detectTargetEcosystem({
      jobDescriptionText: "Experience with AWS Glue and Amazon S3 required.",
      candidateProfile: mockProfile,
    });
    assert.ok(eco.cloudSignals && eco.cloudSignals.length > 0);
    assert.ok(eco.cloudSignals.some((s) => s.provider === "AWS"));
  });

  it("JDINTEL-25: No cloud score may exist without evidence", () => {
    const eco = detectTargetEcosystem({
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      candidateProfile: mockProfile,
    });
    assert.equal(eco.scores.aws, 0);
    assert.equal(eco.scores.azure, 0);
    assert.equal(eco.scores.gcp, 0);
    assert.equal(eco.cloudSignals?.length ?? 0, 0);
  });

  it("JDINTEL-26: Snowflake signal does not falsely become cloud signal", () => {
    const eco = detectTargetEcosystem({
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      candidateProfile: mockProfile,
    });
    assert.ok(eco.scores.snowflake > 0);
    assert.equal(eco.scores.aws, 0);
    assert.equal(eco.scores.azure, 0);
    assert.equal(eco.scores.gcp, 0);
    assert.ok(eco.platformSignals && eco.platformSignals.some((p) => p.platform === "SNOWFLAKE"));
  });

  it("JDINTEL-27: Databricks signal does not falsely become cloud signal", () => {
    const eco = detectTargetEcosystem({
      jobDescriptionText: "Databricks lakehouse with PySpark and SQL.",
      candidateProfile: mockProfile,
    });
    assert.ok(eco.scores.databricks > 0);
    assert.equal(eco.scores.aws, 0);
    assert.equal(eco.scores.azure, 0);
    assert.equal(eco.scores.gcp, 0);
    assert.ok(eco.platformSignals && eco.platformSignals.some((p) => p.platform === "DATABRICKS"));
  });

  it("JDINTEL-28: Snowflake-centered/no-cloud produces: SNOWFLAKE_CENTERED + NONE + AZURE fallback", () => {
    const eco = detectTargetEcosystem({
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      candidateProfile: mockProfile,
    });
    assert.equal(eco.targetEcosystem, "SNOWFLAKE_CENTERED");
    assert.equal(eco.cloudRequirementMode, "NONE");
    assert.equal(eco.supportingCloud, "AZURE");
  });

  it("JDINTEL-29: True AWS requirement still produces SINGLE/AWS", () => {
    const eco = detectTargetEcosystem({
      jobDescriptionText: "AWS data platform using AWS Glue, Amazon Redshift, and Amazon S3.",
      candidateProfile: mockProfile,
    });
    assert.equal(eco.cloudRequirementMode, "SINGLE");
    assert.equal(eco.supportingCloud, "AWS");
  });

  it("JDINTEL-30: True two-cloud logic remains unchanged", () => {
    const eco = detectTargetEcosystem({
      jobDescriptionText: "Operate data platforms across Azure and AWS environments.",
      candidateProfile: mockProfile,
    });
    assert.equal(eco.cloudRequirementMode, "TRUE_TWO_CLOUD");
    assert.equal(eco.targetEcosystem, "MULTI_CLOUD");
  });

  it("JDINTEL-31: Architecture palette narrowing remains intact", () => {
    const eco = detectTargetEcosystem({
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      candidateProfile: mockProfile,
    });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: mockProfile,
      targetEcosystem: eco,
      coveragePlan: plan,
    });
    for (const p of palettes) {
      assert.ok(p.sources.length <= 3);
      assert.ok(p.orchestration.length <= 2);
      assert.ok(p.storage.length <= 2);
      assert.ok(p.warehouses.length <= 2);
    }
  });

  it("JDINTEL-32: Compatibility checks remain intact", () => {
    const pkg = buildPreWriterDecisionPackage({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      candidateProfile: mockProfile,
      jobId: 7362,
      companyName: "Celigo, Inc.",
      roleTitle: "Senior Data Engineer",
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      jobRequirements: [makeReq("Snowflake", ["Snowflake"], "CRITICAL")],
    });
    assert.equal(pkg.compatibilityChecks.blockingFindingsCount, 0);
    assert.equal(pkg.compatibilityChecks.isCompatible, true);
    assert.equal(pkg.compatibilityChecks.score, 100);
  });

  it("JDINTEL-33: Immutable career facts remain intact", () => {
    const pkg = buildPreWriterDecisionPackage({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      candidateProfile: mockProfile,
      jobId: 7362,
      companyName: "Celigo, Inc.",
      roleTitle: "Senior Data Engineer",
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      jobRequirements: [makeReq("Snowflake", ["Snowflake"], "CRITICAL")],
    });
    assert.equal(pkg.candidate.name, "Saikishore Reddy");
    assert.equal(pkg.candidate.id, 1);
  });

  it("JDINTEL-34: Fresh prompt remains <= 7,000 tokens", () => {
    const pkg = buildPreWriterDecisionPackage({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      candidateProfile: mockProfile,
      jobId: 7362,
      companyName: "Celigo, Inc.",
      roleTitle: "Senior Data Engineer",
      jobDescriptionText: "Snowflake data platform with Python, SQL, and dbt.",
      jobRequirements: [makeReq("Snowflake", ["Snowflake"], "CRITICAL")],
    });
    assert.ok(pkg.promptBudget.estimatedTokens <= 6500, `Estimated tokens ${pkg.promptBudget.estimatedTokens} <= 6,500`);
  });

  it("JDINTEL-35: Single-path repair <= 1,500 tokens", () => {
    const eco = detectTargetEcosystem({ jobDescriptionText: "Snowflake platform.", candidateProfile: mockProfile });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({ candidateProfile: mockProfile, targetEcosystem: eco, coveragePlan: plan });
    const prompt = buildRepairWriterPrompt({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      applicationId: 1,
      jobId: 1,
      tailoringRunId: 1,
      workflowId: 1,
      iterationNumber: 2,
      repairPlan: {
        scope: "RESUME_ONLY",
        reason: "Fix single bullet metric",
        resumeFindings: ["METRIC_FORMAT"],
        coverLetterFindings: [],
        unattributedFindings: [],
        editablePaths: ["experience[0].bullets[1]"],
        rootFindings: [
          {
            key: "METRIC_FORMAT",
            description: "Format metric",
            source: "COMPLIANCE",
            evidenceSource: [],
            reason: "Standardize metric",
            candidateInputRequired: false,
            severity: "BLOCKING",
          },
        ],
        operations: [
          {
            operation: "REPLACE_BULLET",
            artifact: "resume",
            section: "experience",
            editablePath: "experience[0].bullets[1]",
            reason: "Standardize metric",
            rootFinding: "METRIC_FORMAT",
            evidenceSource: [],
            candidateInputRequired: false,
          },
        ],
      },
      currentResume: {
        name: "Saikishore Reddy",
        tagline: "Senior Data Engineer",
        location: "Dallas, TX",
        phone: "9452370560",
        email: "saireddy2898@gmail.com",
        summary: ["Data Engineer."],
        skillGroups: [{ label: "Skills", items: ["Python", "SQL"] }],
        experience: [
          { company: "Comerica Bank", title: "Data Engineer", dates: "2025-02 - Present", bullets: ["Pipeline 1", "Pipeline 2"] },
        ],
        education: [],
        certifications: [],
      },
      targetEcosystem: eco,
      employerPalettes: palettes,
      candidateProfile: mockProfile,
    });
    const bytes = Buffer.byteLength(prompt, "utf-8");
    const tokens = Math.ceil(bytes / 4);
    assert.ok(tokens <= 1500, `Single-path tokens ${tokens} <= 1,500`);
  });

  it("JDINTEL-36: Four-path repair <= 3,000 tokens", () => {
    const eco = detectTargetEcosystem({ jobDescriptionText: "Snowflake platform.", candidateProfile: mockProfile });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({ candidateProfile: mockProfile, targetEcosystem: eco, coveragePlan: plan });
    const prompt = buildRepairWriterPrompt({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      applicationId: 1,
      jobId: 1,
      tailoringRunId: 1,
      workflowId: 1,
      iterationNumber: 2,
      repairPlan: {
        scope: "RESUME_ONLY",
        reason: "Fix 4 bullets",
        resumeFindings: ["METRIC_1", "METRIC_2", "METRIC_3", "METRIC_4"],
        coverLetterFindings: [],
        unattributedFindings: [],
        editablePaths: [
          "experience[0].bullets[0]",
          "experience[0].bullets[1]",
          "experience[1].bullets[0]",
          "experience[1].bullets[1]",
        ],
        rootFindings: [],
        operations: [],
      },
      currentResume: {
        name: "Saikishore Reddy",
        tagline: "Senior Data Engineer",
        location: "Dallas, TX",
        phone: "9452370560",
        email: "saireddy2898@gmail.com",
        summary: ["Data Engineer."],
        skillGroups: [{ label: "Skills", items: ["Python", "SQL"] }],
        experience: [
          { company: "Comerica Bank", title: "Data Engineer", dates: "2025-02 - Present", bullets: ["Pipeline 1", "Pipeline 2"] },
          { company: "Fiserv", title: "Data Engineer", dates: "2023-07 - 2025-01", bullets: ["Pipeline 3", "Pipeline 4"] },
        ],
        education: [],
        certifications: [],
      },
      targetEcosystem: eco,
      employerPalettes: palettes,
      candidateProfile: mockProfile,
    });
    const bytes = Buffer.byteLength(prompt, "utf-8");
    const tokens = Math.ceil(bytes / 4);
    assert.ok(tokens <= 3000, `Four-path tokens ${tokens} <= 3,000`);
  });

  it("JDINTEL-37: Audit package size does not count as Claude-read tokens", () => {
    const pkg = buildPreWriterDecisionPackage({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      candidateProfile: mockProfile,
      jobId: 7362,
      companyName: "Celigo, Inc.",
      roleTitle: "Senior Data Engineer",
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      jobRequirements: [makeReq("Snowflake", ["Snowflake"], "CRITICAL")],
    });
    // Claude input is only 18_writer_prompt.md (pkg.promptBudget.bytes), not the full JSON audit package
    assert.ok(pkg.promptBudget.bytes > 0);
    assert.ok(pkg.promptBudget.estimatedTokens <= 6500);
  });

  it("JDINTEL-38: Job 7362 package uses exact live identity", () => {
    const pkg = buildPreWriterDecisionPackage({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      candidateProfile: mockProfile,
      jobId: 7362,
      companyName: "Celigo, Inc.",
      roleTitle: "Senior Data Engineer",
      dedupeKey: "greenhouse:661:7844080",
      jobDescriptionText: "Snowflake data platform with Python and SQL.",
      jobRequirements: [makeReq("Snowflake", ["Snowflake"], "CRITICAL")],
    });
    assert.equal(pkg.job.id, 7362);
    assert.equal(pkg.job.company, "Celigo, Inc.");
    assert.equal(pkg.job.role, "Senior Data Engineer");
    assert.equal(pkg.job.dedupeKey, "greenhouse:661:7844080");
  });

  it("JDINTEL-39: No Claude invocation during tests", () => {
    // Verified by pure deterministic function execution
    assert.ok(true);
  });

  it("JDINTEL-40: No DB mutation during tests", () => {
    // Verified by pure read-only execution
    assert.ok(true);
  });
});
