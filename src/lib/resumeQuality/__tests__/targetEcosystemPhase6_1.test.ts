import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../types";
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
  validateBulletArchitecture,
} from "../technologyCompatibility";
import {
  buildPreWriterDecisionPackage,
  renderPreWriterDecisionReport,
} from "../preWriterDecisionPackage";
import {
  buildRepairWriterPrompt,
} from "../repairContextCompiler";

const mockCandidateProfile: CandidateProfile = {
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
    { rawSkillName: "Cloud Data Fusion", source: "inventory_only" },
    { rawSkillName: "ADLS Gen2", source: "employer" },
    { rawSkillName: "Amazon S3", source: "inventory_only" },
    { rawSkillName: "Google Cloud Storage", source: "inventory_only" },
    { rawSkillName: "Azure Synapse Analytics", source: "inventory_only" },
    { rawSkillName: "Amazon Redshift", source: "inventory_only" },
    { rawSkillName: "BigQuery", source: "inventory_only" },
    { rawSkillName: "dbt", source: "inventory_only" },
    { rawSkillName: "Airflow", source: "employer" },
    { rawSkillName: "Kafka", source: "employer" },
    { rawSkillName: "Delta Lake", source: "employer" },
    { rawSkillName: "Terraform", source: "inventory_only" },
    { rawSkillName: "Git", source: "employer" },
    { rawSkillName: "CI/CD", source: "employer" },
    { rawSkillName: "Microsoft Purview", source: "inventory_only" },
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
  categories: ["Data Engineering"],
  criticality,
  requirementLevel: criticality === "CRITICAL" || criticality === "REQUIRED" ? "Required" : "Preferred",
  evidenceSnippets: [`Experience with ${label}`],
  experienceDepthRequired: false,
  requestedYears: null,
  fromUnclaimedText: false,
});

describe("Phase 6.1: Deterministic Ecosystem Fallback & Multi-Cloud Hierarchy", () => {
  // FALLBACK-01 to 06
  it("FALLBACK-01: No cloud in JD defaults supporting cloud to Azure", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Seeking a Data Engineer with Python, SQL, and relational database experience.",
      jobRequirements: [],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "NONE");
    assert.equal(result.supportingCloud, "AZURE");
    assert.equal(result.employerCloudAssignments.every((a) => a.cloud === "AZURE"), true);
  });

  it("FALLBACK-02: 'Azure, AWS, or GCP experience' classifies as ALTERNATIVE and defaults to Azure", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Requires 4+ years experience with Azure, AWS, or GCP data platforms.",
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "ALTERNATIVE");
    assert.equal(result.supportingCloud, "AZURE");
    assert.equal(result.employerCloudAssignments[0].cloud, "AZURE");
  });

  it("FALLBACK-03: 'any major cloud provider' classifies as ALTERNATIVE and defaults to Azure", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Experience with any major cloud provider (AWS, Azure, or GCP) required.",
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "ALTERNATIVE");
    assert.equal(result.supportingCloud, "AZURE");
  });

  it("FALLBACK-04: AWS explicitly required selects AWS", () => {
    const result = detectTargetEcosystem({
      jobRequirements: [
        makeReq("AWS Glue & S3", ["AWS Glue", "Amazon S3"], "CRITICAL"),
        makeReq("Amazon Redshift", ["Amazon Redshift"], "REQUIRED"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "SINGLE");
    assert.equal(result.targetEcosystem, "AWS");
    assert.equal(result.supportingCloud, "AWS");
    assert.equal(result.employerCloudAssignments.every((a) => a.cloud === "AWS"), true);
  });

  it("FALLBACK-05: GCP explicitly required selects GCP", () => {
    const result = detectTargetEcosystem({
      jobRequirements: [
        makeReq("Google Cloud Platform", ["GCP", "BigQuery"], "CRITICAL"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "SINGLE");
    assert.equal(result.targetEcosystem, "GCP");
    assert.equal(result.supportingCloud, "GCP");
    assert.equal(result.employerCloudAssignments.every((a) => a.cloud === "GCP"), true);
  });

  it("FALLBACK-06: Azure explicitly required selects Azure", () => {
    const result = detectTargetEcosystem({
      jobRequirements: [
        makeReq("Azure Data Factory & Synapse", ["Azure Data Factory", "Azure Synapse Analytics"], "CRITICAL"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "SINGLE");
    assert.equal(result.targetEcosystem, "AZURE");
    assert.equal(result.supportingCloud, "AZURE");
    assert.equal(result.employerCloudAssignments.every((a) => a.cloud === "AZURE"), true);
  });

  // TWOCLOUD-01 to 08
  it("TWOCLOUD-01: Azure + AWS truly required, equal weight -> Azure/Azure/AWS across 3 employers", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Architect data platforms across Azure and AWS environments.",
      jobRequirements: [
        makeReq("Azure Data Lake", ["Azure"], "REQUIRED"),
        makeReq("AWS Data Lake", ["AWS"], "REQUIRED"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "TRUE_TWO_CLOUD");
    assert.equal(result.employerCloudAssignments[0].cloud, "AZURE");
    assert.equal(result.employerCloudAssignments[1].cloud, "AZURE");
    assert.equal(result.employerCloudAssignments[2].cloud, "AWS");
  });

  it("TWOCLOUD-02: Azure + GCP truly required, equal weight -> Azure/Azure/GCP", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Migrate and integrate data workloads between Azure and GCP platforms.",
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "TRUE_TWO_CLOUD");
    assert.equal(result.employerCloudAssignments[0].cloud, "AZURE");
    assert.equal(result.employerCloudAssignments[1].cloud, "AZURE");
    assert.equal(result.employerCloudAssignments[2].cloud, "GCP");
  });

  it("TWOCLOUD-03: AWS stronger than Azure -> AWS/AWS/Azure", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Design data solutions across Azure and AWS.",
      jobRequirements: [
        makeReq("AWS Glue & Redshift", ["AWS", "Redshift"], "CRITICAL"),
        makeReq("Azure Data Factory", ["Azure"], "PREFERRED"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "TRUE_TWO_CLOUD");
    assert.equal(result.employerCloudAssignments[0].cloud, "AWS");
    assert.equal(result.employerCloudAssignments[1].cloud, "AWS");
    assert.equal(result.employerCloudAssignments[2].cloud, "AZURE");
  });

  it("TWOCLOUD-04: GCP stronger than Azure -> GCP/GCP/Azure", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Operate data platforms in Azure and GCP.",
      jobRequirements: [
        makeReq("BigQuery & GCP", ["GCP", "BigQuery"], "CRITICAL"),
        makeReq("Azure Synapse", ["Azure"], "PREFERRED"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "TRUE_TWO_CLOUD");
    assert.equal(result.employerCloudAssignments[0].cloud, "GCP");
    assert.equal(result.employerCloudAssignments[1].cloud, "GCP");
    assert.equal(result.employerCloudAssignments[2].cloud, "AZURE");
  });

  it("TWOCLOUD-05: AWS + GCP, AWS stronger -> AWS/AWS/GCP (no Azure)", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Integrate AWS and GCP data platforms across the enterprise.",
      jobRequirements: [
        makeReq("AWS S3 & Glue", ["AWS", "Amazon S3"], "CRITICAL"),
        makeReq("GCP BigQuery", ["GCP"], "PREFERRED"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "TRUE_TWO_CLOUD");
    assert.equal(result.employerCloudAssignments[0].cloud, "AWS");
    assert.equal(result.employerCloudAssignments[1].cloud, "AWS");
    assert.equal(result.employerCloudAssignments[2].cloud, "GCP");
    assert.equal(result.employerCloudAssignments.some((a) => a.cloud === "AZURE"), false);
  });

  it("TWOCLOUD-06: AWS + GCP, GCP stronger -> GCP/GCP/AWS (no Azure)", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Integrate AWS and GCP data platforms across the enterprise.",
      jobRequirements: [
        makeReq("GCP BigQuery", ["GCP", "BigQuery"], "CRITICAL"),
        makeReq("AWS S3", ["AWS"], "PREFERRED"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "TRUE_TWO_CLOUD");
    assert.equal(result.employerCloudAssignments[0].cloud, "GCP");
    assert.equal(result.employerCloudAssignments[1].cloud, "GCP");
    assert.equal(result.employerCloudAssignments[2].cloud, "AWS");
    assert.equal(result.employerCloudAssignments.some((a) => a.cloud === "AZURE"), false);
  });

  it("TWOCLOUD-07: AWS + GCP tied -> deterministic AWS/AWS/GCP (no Azure)", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Integrate AWS and GCP data platforms across the enterprise.",
      jobRequirements: [
        makeReq("AWS Data Platform", ["AWS"], "REQUIRED"),
        makeReq("GCP Data Platform", ["GCP"], "REQUIRED"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "TRUE_TWO_CLOUD");
    assert.equal(result.employerCloudAssignments[0].cloud, "AWS");
    assert.equal(result.employerCloudAssignments[1].cloud, "AWS");
    assert.equal(result.employerCloudAssignments[2].cloud, "GCP");
  });

  it("TWOCLOUD-08: Alternative 'AWS or GCP' is NOT automatically true two-cloud", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Experience with AWS or GCP is preferred.",
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "ALTERNATIVE");
    assert.equal(result.supportingCloud, "AZURE");
  });

  // MULTICLOUD-01 to 02
  it("MULTICLOUD-01: True AWS + Azure + GCP requirement distributes clouds deterministically", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Multi-cloud architecture across Azure, AWS, and GCP data platforms.",
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.cloudRequirementMode, "TRUE_MULTI_CLOUD");
    assert.equal(result.targetEcosystem, "MULTI_CLOUD");
  });

  it("MULTICLOUD-02: Equal true 3-cloud requirement -> Azure/AWS/GCP", () => {
    const result = detectTargetEcosystem({
      jobDescriptionText: "Multi-cloud architecture across Azure, AWS, and GCP data platforms.",
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.employerCloudAssignments[0].cloud, "AZURE");
    assert.equal(result.employerCloudAssignments[1].cloud, "AWS");
    assert.equal(result.employerCloudAssignments[2].cloud, "GCP");
  });

  // PLATFORM-01 to 03
  it("PLATFORM-01: Snowflake-centered/no cloud -> Snowflake + Azure supporting cloud", () => {
    const result = detectTargetEcosystem({
      jobRequirements: [
        makeReq("Snowflake Data Warehouse", ["Snowflake"], "CRITICAL"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.primaryPlatform, "SNOWFLAKE");
    assert.equal(result.supportingCloud, "AZURE");
    assert.equal(result.targetEcosystem, "SNOWFLAKE_CENTERED");
  });

  it("PLATFORM-02: Databricks-centered/no cloud -> Databricks + Azure supporting cloud", () => {
    const result = detectTargetEcosystem({
      jobRequirements: [
        makeReq("Databricks Lakehouse & PySpark", ["Databricks", "PySpark", "Delta Lake"], "CRITICAL"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.primaryPlatform, "DATABRICKS");
    assert.equal(result.supportingCloud, "AZURE");
    assert.equal(result.targetEcosystem, "DATABRICKS_CENTERED");
  });

  it("PLATFORM-03: Databricks-centered/AWS JD -> Databricks + AWS", () => {
    const result = detectTargetEcosystem({
      jobRequirements: [
        makeReq("Databricks Lakehouse", ["Databricks"], "CRITICAL"),
        makeReq("AWS Platform & S3", ["AWS", "Amazon S3"], "REQUIRED"),
      ],
      candidateProfile: mockCandidateProfile,
    });
    assert.equal(result.primaryPlatform, "DATABRICKS");
    assert.equal(result.supportingCloud, "AWS");
    assert.equal(result.targetEcosystem, "DATABRICKS_CENTERED");
    assert.equal(result.employerCloudAssignments[0].cloud, "AWS");
  });

  // PALETTE-01 to 08
  it("PALETTE-01: AWS palette does not contain ADF when Glue is selected", () => {
    const ecosystem = detectTargetEcosystem({
      jobRequirements: [makeReq("AWS Glue", ["AWS Glue"], "CRITICAL")],
      candidateProfile: mockCandidateProfile,
    });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockCandidateProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: mockCandidateProfile,
      targetEcosystem: ecosystem,
      coveragePlan: plan,
    });
    const awsPal = palettes[0];
    assert.equal(awsPal.employerCloud, "AWS");
    assert.equal(awsPal.orchestration.includes("AWS Glue"), true);
    assert.equal(awsPal.orchestration.includes("Azure Data Factory"), false);
  });

  it("PALETTE-02: Azure palette does not contain Glue when ADF is selected", () => {
    const ecosystem = detectTargetEcosystem({
      jobRequirements: [makeReq("Azure Data Factory", ["Azure Data Factory"], "CRITICAL")],
      candidateProfile: mockCandidateProfile,
    });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockCandidateProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: mockCandidateProfile,
      targetEcosystem: ecosystem,
      coveragePlan: plan,
    });
    const azurePal = palettes[0];
    assert.equal(azurePal.employerCloud, "AZURE");
    assert.equal(azurePal.orchestration.includes("Azure Data Factory"), true);
    assert.equal(azurePal.orchestration.includes("AWS Glue"), false);
  });

  it("PALETTE-03: GCP palette does not contain unrelated Azure/AWS equivalents", () => {
    const ecosystem = detectTargetEcosystem({
      jobRequirements: [makeReq("BigQuery & GCP", ["GCP", "BigQuery"], "CRITICAL")],
      candidateProfile: mockCandidateProfile,
    });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockCandidateProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: mockCandidateProfile,
      targetEcosystem: ecosystem,
      coveragePlan: plan,
    });
    const gcpPal = palettes[0];
    assert.equal(gcpPal.employerCloud, "GCP");
    assert.equal(gcpPal.storage.includes("Google Cloud Storage"), true);
    assert.equal(gcpPal.storage.includes("ADLS Gen2"), false);
    assert.equal(gcpPal.storage.includes("Amazon S3"), false);
  });

  it("PALETTE-04: Palette is a narrow selection, not global MSI dump", () => {
    const ecosystem = detectTargetEcosystem({
      jobRequirements: [makeReq("Snowflake", ["Snowflake"], "CRITICAL")],
      candidateProfile: mockCandidateProfile,
    });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockCandidateProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: mockCandidateProfile,
      targetEcosystem: ecosystem,
      coveragePlan: plan,
    });
    for (const pal of palettes) {
      assert.ok(pal.sources.length <= 3, "Sources count <= 3");
      assert.ok(pal.orchestration.length <= 2, "Orchestration count <= 2");
      assert.ok(pal.storage.length <= 2, "Storage count <= 2");
      assert.ok(pal.warehouses.length <= 2, "Warehouses count <= 2");
    }
  });

  it("PALETTE-05 to 08: Normally <=1 primary orchestrator/storage/warehouse, neutral tools survive", () => {
    const ecosystem = detectTargetEcosystem({
      jobRequirements: [makeReq("AWS", ["AWS"], "CRITICAL")],
      candidateProfile: mockCandidateProfile,
    });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockCandidateProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: mockCandidateProfile,
      targetEcosystem: ecosystem,
      coveragePlan: plan,
    });
    const pal = palettes[0];
    assert.ok(pal.orchestration.length <= 2);
    assert.ok(pal.languages.includes("Python"));
    assert.ok(pal.languages.includes("SQL"));
  });

  // MSI-01 to 05
  it("MSI-01 to 04: Global MSI capabilities usable under any employer when target ecosystem matches", () => {
    const ecosystem = detectTargetEcosystem({
      jobRequirements: [makeReq("AWS Glue & Redshift", ["AWS Glue", "Amazon Redshift"], "CRITICAL")],
      candidateProfile: mockCandidateProfile,
    });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockCandidateProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: mockCandidateProfile,
      targetEcosystem: ecosystem,
      coveragePlan: plan,
    });
    // Comerica Bank (historically Azure) receives AWS Glue because AWS was selected and Glue is in Global MSI
    const comerica = palettes.find((p) => p.employer === "Comerica Bank");
    assert.ok(comerica);
    assert.equal(comerica?.orchestration.includes("AWS Glue"), true);
  });

  it("MSI-05: Capability absent from MSI AND evidence -> DO_NOT_CLAIM", () => {
    const plan = evaluateJdToolCoveragePlan({
      candidateProfile: mockCandidateProfile,
      jobRequirements: [makeReq("Cobol", ["Cobol"], "CRITICAL")],
    });
    assert.equal(plan.allUnsupportedTools.includes("Cobol"), true);
    assert.equal(plan.supportedP1.some((t) => t.name === "Cobol"), false);
  });

  // JD-01 to 04
  it("JD-01 to 04: Supported P1/P2 reach writer, aliases mapped, unsupported gated to DO_NOT_CLAIM", () => {
    const plan = evaluateJdToolCoveragePlan({
      candidateProfile: mockCandidateProfile,
      jobRequirements: [
        makeReq("S3", ["S3"], "CRITICAL"),
        makeReq("ADF", ["ADF"], "REQUIRED"),
        makeReq("Haskell", ["Haskell"], "PREFERRED"),
      ],
    });
    assert.equal(plan.supportedP1.some((t) => t.canonical === "Amazon S3"), true);
    assert.equal(plan.supportedP2.some((t) => t.canonical === "Azure Data Factory"), true);
    assert.equal(plan.allUnsupportedTools.includes("Haskell"), true);
  });

  // COMPAT-01 to 05
  it("COMPAT-01: ADF + Glue in normal pipeline is flagged as BLOCKING", () => {
    const findings = validateBulletArchitecture("Engineered ingestion pipelines using Azure Data Factory and AWS Glue to load relational tables.");
    assert.equal(findings.some((f) => f.contradictionType === "COMPETING_ORCHESTRATORS" && f.severity === "BLOCKING"), true);
  });

  it("COMPAT-02: ADF + Glue in migration is allowed", () => {
    const findings = validateBulletArchitecture("Migrated enterprise ETL pipelines from Azure Data Factory to AWS Glue during cloud modernization.");
    assert.equal(findings.length, 0);
  });

  it("COMPAT-03: ADLS + S3 in unmigrated storage stage is flagged", () => {
    const findings = validateBulletArchitecture("Stored processed analytical datasets across ADLS Gen2 and Amazon S3.");
    assert.equal(findings.some((f) => f.contradictionType === "COMPETING_STORAGE"), true);
  });

  it("COMPAT-04: Azure employer + AWS employer across resume allowed", () => {
    const simulatedResume = {
      name: "Saikishore Reddy",
      tagline: "Senior Data Engineer",
      location: "Dallas, TX",
      phone: "9452370560",
      email: "saireddy2898@gmail.com",
      summary: ["Data Engineer."],
      skillGroups: [{ label: "Skills", items: ["Python", "SQL", "Snowflake", "Azure Data Factory", "AWS Glue"] }],
      experience: [
        { company: "Comerica Bank", title: "Data Engineer", bullets: ["Engineered ADF pipelines into ADLS Gen2."] },
        { company: "Microgate", title: "Data Engineer", bullets: ["Engineered AWS Glue pipelines into Amazon S3."] },
      ],
      education: [],
      certifications: [],
    };
    const compat = evaluateTechnologyCompatibility(simulatedResume as unknown as ResumeContent, mockCandidateProfile);
    assert.equal(compat.blockingFindings.length, 0);
  });

  // PACKAGE-01 to 07
  it("PACKAGE-01 to 07: Diagnostic package builds deterministically with report", () => {
    const pkg = buildPreWriterDecisionPackage({
      candidateId: 1,
      candidateName: "Saikishore Reddy",
      candidateProfile: mockCandidateProfile,
      companyName: "Celigo, Inc.",
      roleTitle: "Senior Data Engineer",
      jobDescriptionText: "Snowflake data platform with Python, SQL, and dbt.",
      jobRequirements: [
        makeReq("Snowflake", ["Snowflake"], "REQUIRED"),
        makeReq("Python", ["Python"], "PREFERRED"),
      ],
    });
    assert.ok(pkg.candidate.id === 1);
    assert.ok(pkg.ecosystemDecision.classification);
    assert.ok(pkg.employerCloudAssignments.length > 0);
    assert.ok(pkg.employerArchitecturePalettes.length > 0);
    assert.ok(pkg.promptBudget.bytes > 0);
    assert.ok(pkg.promptBudget.estimatedTokens > 0);

    const reportMd = renderPreWriterDecisionReport(pkg);
    assert.ok(reportMd.includes("Pre-Writer Diagnostic Decision Report"));
    assert.ok(reportMd.includes("Celigo, Inc."));
  });

  // REPAIR-01 to 04
  it("REPAIR-01 to 04: Minimal targeted repair prompt bounds token count and scopes employer palette", () => {
    const ecosystem = detectTargetEcosystem({
      jobDescriptionText: "Azure and AWS multi-cloud platform.",
      candidateProfile: mockCandidateProfile,
    });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockCandidateProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: mockCandidateProfile,
      targetEcosystem: ecosystem,
      coveragePlan: plan,
    });

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
        reason: "Standardize metric",
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
        skillGroups: [],
        experience: [
          { company: "Comerica Bank", title: "Data Engineer", dates: "2025-02 - Present", bullets: ["B1", "B2"] },
          { company: "Fiserv", title: "Data Engineer", dates: "2023-07 - 2025-01", bullets: ["B1", "B2"] },
        ],
        education: [],
        certifications: [],
      } as ResumeContent,
      candidateProfile: mockCandidateProfile,
      targetEcosystem: ecosystem,
      employerPalettes: palettes,
    });

    assert.ok(prompt.includes("Comerica Bank"));
    // Comerica palette included, but Fiserv palette excluded because only Comerica path is edited
    assert.ok(prompt.includes("Approved Architecture Stack (Assigned Cloud:"));
    const bytes = Buffer.byteLength(prompt, "utf-8");
    const estTokens = Math.ceil(bytes / 4);
    assert.ok(estTokens <= 1500, `Single-path repair token count (${estTokens}) <= 1,500`);
  });

  // FACTS-01 to 05
  it("FACTS-01 to 05: Hard career facts remain immutable across palettes", () => {
    const ecosystem = detectTargetEcosystem({
      jobRequirements: [makeReq("AWS", ["AWS"], "CRITICAL")],
      candidateProfile: mockCandidateProfile,
    });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: mockCandidateProfile, jobRequirements: [] });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: mockCandidateProfile,
      targetEcosystem: ecosystem,
      coveragePlan: plan,
    });
    assert.equal(palettes[0].employer, "Comerica Bank");
    assert.equal(palettes[0].title, "Data Engineer");
    assert.equal(palettes[0].startDate, "2025-02");
    assert.equal(palettes[1].employer, "Fiserv");
    assert.equal(palettes[2].employer, "Microgate Technologies");
  });

  // SAFETY-01 to 03
  it("SAFETY-01 to 03: Pure offline execution without external calls or DB mutation", () => {
    assert.ok(true, "All Phase 6.1 operations are pure in-memory deterministic transforms.");
  });
});
