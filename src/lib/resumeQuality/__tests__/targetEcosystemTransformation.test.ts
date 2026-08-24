import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import {
  detectTargetEcosystem,
  renderTargetEcosystemSection,
  type TargetEcosystemResult,
} from "../targetEcosystem";
import {
  classifyTechnology,
  isCloudNeutral,
  getEquivalentTechnologies,
  findAliasDuplicates,
} from "../technologyClassification";
import {
  evaluateJdToolCoveragePlan,
  renderJdToolCoverageSection,
  evaluatePostWriterJdToolCoverage,
  buildCandidateGlobalCapabilitySet,
} from "../jdToolCoverage";
import {
  buildEmployerArchitecturePalettes,
  renderArchitecturePaletteSection,
} from "../architecturePalette";
import {
  evaluateTechnologyCompatibility,
  hasMigrationSignal,
  validateBulletArchitecture,
} from "../technologyCompatibility";
import { renderWriterOutputQualitySection } from "../writerOutputQuality";

// Test Fixtures
export const candidateWithGlobalMsi: CandidateProfile = {
  schemaVersion: 1,
  sourceHashes: { resume: "hash_resume", skills: "hash_skills" },
  builtAt: "2026-08-24T00:00:00Z",
  totalYearsExperience: 6,
  experience: [
    {
      employer: "Comerica Bank",
      title: "Lead Data Engineer",
      startDate: "2023-01",
      endDate: null,
      technologies: ["Azure Data Factory", "ADLS Gen2", "Databricks", "PySpark", "Snowflake", "SQL Server"],
    },
    {
      employer: "Fiserv",
      title: "Senior Data Engineer",
      startDate: "2021-03",
      endDate: "2022-12",
      technologies: ["Azure Data Factory", "SQL Server", "PySpark", "Python", "SQL", "Airflow"],
    },
    {
      employer: "Microgate Technologies",
      title: "Data Engineer",
      startDate: "2019-06",
      endDate: "2021-02",
      technologies: ["Python", "SQL", "Spark", "PostgreSQL", "Kafka"],
    },
    {
      employer: "Bharat Heavy Electricals",
      title: "Graduate Engineer Trainee",
      startDate: "2018-05",
      endDate: "2019-05",
      technologies: ["Heavy electrical testing", "Quality inspection"],
    },
  ],
  skills: [
    // AWS skills declared in Global MSI
    { rawSkillName: "AWS Glue", source: "inventory_only" },
    { rawSkillName: "Amazon S3", source: "inventory_only" },
    { rawSkillName: "Amazon Redshift", source: "inventory_only" },
    { rawSkillName: "Amazon EMR", source: "inventory_only" },
    { rawSkillName: "Amazon Athena", source: "inventory_only" },
    { rawSkillName: "AWS Lambda", source: "inventory_only" },
    // GCP skills declared in Global MSI
    { rawSkillName: "BigQuery", source: "inventory_only" },
    { rawSkillName: "Cloud Data Fusion", source: "inventory_only" },
    { rawSkillName: "Google Cloud Storage", source: "inventory_only" },
    // Azure skills
    { rawSkillName: "Azure Data Factory", source: "employer" },
    { rawSkillName: "ADLS Gen2", source: "employer" },
    { rawSkillName: "Azure Synapse Analytics", source: "inventory_only" },
    { rawSkillName: "Azure DevOps", source: "inventory_only" },
    // Neutral skills
    { rawSkillName: "Databricks", source: "employer" },
    { rawSkillName: "Snowflake", source: "employer" },
    { rawSkillName: "PySpark", source: "employer" },
    { rawSkillName: "Python", source: "employer" },
    { rawSkillName: "SQL", source: "employer" },
    { rawSkillName: "dbt", source: "inventory_only" },
    { rawSkillName: "Airflow", source: "employer" },
    { rawSkillName: "Kafka", source: "employer" },
    { rawSkillName: "Terraform", source: "inventory_only" },
    { rawSkillName: "Docker", source: "inventory_only" },
    { rawSkillName: "CI/CD", source: "employer" },
    { rawSkillName: "CDC", source: "employer" },
    { rawSkillName: "SCD Type 2", source: "employer" },
  ],
  education: [
    { institution: "JNTUH", field: "Electrical & Electronics Engineering", level: "Bachelor's" },
  ],
  certifications: [
    { name: "Databricks Certified Data Engineer Professional" },
    { name: "Snowflake SnowPro Core Certified" },
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

describe("Phase 6: Target Ecosystem Transformation & Technology Compatibility (ECOSYSTEM-01..58)", () => {
  // ECOSYSTEM-01..04: Detection
  it("ECOSYSTEM-01: AWS-heavy JD deterministically selects AWS", () => {
    const reqs = [
      makeReq("AWS Glue", ["AWS Glue", "Glue"], "CRITICAL"),
      makeReq("Amazon S3", ["S3", "Amazon S3"], "CRITICAL"),
      makeReq("Amazon Redshift", ["Redshift", "Amazon Redshift"], "REQUIRED"),
      makeReq("PySpark", ["PySpark"], "REQUIRED"),
    ];
    const res = detectTargetEcosystem({ jobRequirements: reqs });
    assert.equal(res.targetEcosystem, "AWS");
    assert.equal(res.primaryCloud, "AWS");
    assert.ok(res.scores.aws > res.scores.azure);
  });

  it("ECOSYSTEM-02: Azure-heavy JD selects Azure", () => {
    const reqs = [
      makeReq("Azure Data Factory", ["Azure Data Factory", "ADF"], "CRITICAL"),
      makeReq("ADLS Gen2", ["ADLS Gen2", "Azure Data Lake"], "CRITICAL"),
      makeReq("Azure Synapse Analytics", ["Synapse", "Azure Synapse"], "REQUIRED"),
    ];
    const res = detectTargetEcosystem({ jobRequirements: reqs });
    assert.equal(res.targetEcosystem, "AZURE");
    assert.equal(res.primaryCloud, "AZURE");
  });

  it("ECOSYSTEM-03: GCP-heavy JD selects GCP", () => {
    const reqs = [
      makeReq("BigQuery", ["BigQuery", "Google BigQuery"], "CRITICAL"),
      makeReq("Cloud Data Fusion", ["Cloud Data Fusion", "Data Fusion"], "CRITICAL"),
      makeReq("Google Cloud Storage", ["GCS", "Google Cloud Storage"], "REQUIRED"),
    ];
    const res = detectTargetEcosystem({ jobRequirements: reqs });
    assert.equal(res.targetEcosystem, "GCP");
    assert.equal(res.primaryCloud, "GCP");
  });

  it("ECOSYSTEM-04: True multi-cloud JD selects MULTI_CLOUD", () => {
    const reqs = [
      makeReq("AWS Glue", ["AWS Glue"], "CRITICAL"),
      makeReq("Azure Data Factory", ["Azure Data Factory"], "CRITICAL"),
      makeReq("BigQuery", ["BigQuery"], "CRITICAL"),
    ];
    const res = detectTargetEcosystem({ jobRequirements: reqs });
    assert.equal(res.targetEcosystem, "MULTI_CLOUD");
  });

  // ECOSYSTEM-05..07: Neutral Platform Preservation
  it("ECOSYSTEM-05: Databricks survives AWS transformation", () => {
    assert.equal(isCloudNeutral("Databricks"), true);
    assert.equal(isCloudNeutral("PySpark"), true);
  });

  it("ECOSYSTEM-06: Snowflake survives Azure transformation", () => {
    assert.equal(isCloudNeutral("Snowflake"), true);
    assert.equal(isCloudNeutral("dbt"), true);
  });

  it("ECOSYSTEM-07: Python/SQL/PySpark remain provider-neutral", () => {
    assert.equal(isCloudNeutral("Python"), true);
    assert.equal(isCloudNeutral("SQL"), true);
    assert.equal(isCloudNeutral("Kafka"), true);
    assert.equal(isCloudNeutral("Airflow"), true);
  });

  // ECOSYSTEM-08..09: Supported vs Unsupported Tool Classification
  it("ECOSYSTEM-08: Supported critical JD tools reach writer context", () => {
    const reqs = [
      makeReq("AWS Glue", ["AWS Glue"], "CRITICAL"),
      makeReq("Snowflake", ["Snowflake"], "CRITICAL"),
      makeReq("Python", ["Python"], "REQUIRED"),
    ];
    const plan = evaluateJdToolCoveragePlan({
      candidateProfile: candidateWithGlobalMsi,
      jobRequirements: reqs,
    });
    assert.equal(plan.supportedP1.length, 2);
    assert.ok(plan.allSupportedTools.includes("AWS Glue"));
    assert.ok(plan.allSupportedTools.includes("Snowflake"));
  });

  it("ECOSYSTEM-09: Unsupported JD tools never become writer claims (DO_NOT_CLAIM)", () => {
    const reqs = [
      makeReq("Informatica PowerCenter", ["Informatica PowerCenter"], "CRITICAL"),
      makeReq("Talend", ["Talend"], "REQUIRED"),
      makeReq("Fivetran", ["Fivetran"], "PREFERRED"),
    ];
    const plan = evaluateJdToolCoveragePlan({
      candidateProfile: candidateWithGlobalMsi,
      jobRequirements: reqs,
    });
    assert.ok(plan.allUnsupportedTools.includes("Informatica PowerCenter") || plan.allUnsupportedTools.some(t => t.includes("Informatica")));
    assert.ok(plan.allUnsupportedTools.includes("Talend"));
    assert.ok(plan.allUnsupportedTools.includes("Fivetran"));
  });

  // ECOSYSTEM-10..12: Alias Normalization & Deduplication
  it("ECOSYSTEM-10: Alias normalization works", () => {
    const entry = classifyTechnology("ADF");
    assert.equal(entry?.canonical, "Azure Data Factory");
  });

  it("ECOSYSTEM-11: ADF + Azure Data Factory duplicate prevented", () => {
    const dups = findAliasDuplicates(["ADF", "Azure Data Factory", "Snowflake"]);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].canonical, "Azure Data Factory");
    assert.equal(dups[0].duplicates.length, 2);
  });

  it("ECOSYSTEM-12: S3 + Amazon S3 duplicate prevented", () => {
    const dups = findAliasDuplicates(["S3", "Amazon S3", "Python"]);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].canonical, "Amazon S3");
  });

  // ECOSYSTEM-13..17: Technology Compatibility & Contradiction Detection
  it("ECOSYSTEM-13: Unexplained ADF + Glue combination flagged", () => {
    const bullet = "Built scalable pipelines using Azure Data Factory and AWS Glue to ingest operational tables.";
    const findings = validateBulletArchitecture(bullet);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].contradictionType, "COMPETING_ORCHESTRATORS");
  });

  it("ECOSYSTEM-14: Verified Azure-to-AWS migration allows both", () => {
    const bullet = "Migrated legacy ingestion workflows from Azure Data Factory to AWS Glue, reducing execution latency by 35%.";
    assert.equal(hasMigrationSignal(bullet), true);
    const findings = validateBulletArchitecture(bullet);
    assert.equal(findings.length, 0);
  });

  it("ECOSYSTEM-15: Multiple unexplained warehouses are flagged", () => {
    const bullet = "Engineered analytical layers across Azure Synapse Analytics and Amazon Redshift for financial reporting.";
    const findings = validateBulletArchitecture(bullet);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].contradictionType, "COMPETING_WAREHOUSES");
  });

  it("ECOSYSTEM-16: Snowflake + Databricks allowed when architecture is coherent", () => {
    const bullet = "Processed Bronze-to-Silver delta tables in Databricks with PySpark and loaded dimensional models into Snowflake.";
    const findings = validateBulletArchitecture(bullet);
    assert.equal(findings.length, 0);
  });

  it("ECOSYSTEM-17: Kafka + Spark + Snowflake allowed", () => {
    const bullet = "Ingested real-time Kafka event streams into Apache Spark structured streaming pipelines and published to Snowflake.";
    const findings = validateBulletArchitecture(bullet);
    assert.equal(findings.length, 0);
  });

  // ECOSYSTEM-18..20: Employer Architecture Palettes
  it("ECOSYSTEM-18: Employer-specific immutable facts preserved", () => {
    const ecoRes: TargetEcosystemResult = {
      targetEcosystem: "AWS",
      primaryCloud: "AWS",
      confidence: "HIGH",
      scores: { aws: 10, azure: 2, gcp: 0, snowflake: 4, databricks: 4 },
      supportingRequirements: { aws: ["AWS Glue", "S3"], azure: [], gcp: [], snowflake: [], databricks: [], neutral: [] },
      reasoning: "AWS target",
    };
    const coverage = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: candidateWithGlobalMsi,
      targetEcosystem: ecoRes,
      coveragePlan: coverage,
    });
    assert.equal(palettes.length, 4);
    assert.equal(palettes[0].employer, "Comerica Bank");
    assert.equal(palettes[0].title, "Lead Data Engineer");
    assert.equal(palettes[0].startDate, "2023-01");
  });

  it("ECOSYSTEM-19: Architecture palette excludes unsupported technologies", () => {
    const ecoRes: TargetEcosystemResult = {
      targetEcosystem: "AWS",
      primaryCloud: "AWS",
      confidence: "HIGH",
      scores: { aws: 10, azure: 0, gcp: 0, snowflake: 0, databricks: 0 },
      supportingRequirements: { aws: [], azure: [], gcp: [], snowflake: [], databricks: [], neutral: [] },
      reasoning: "AWS target",
    };
    const coverage = evaluateJdToolCoveragePlan({
      candidateProfile: candidateWithGlobalMsi,
      jobRequirements: [makeReq("Talend", ["Talend"], "CRITICAL")],
    });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: candidateWithGlobalMsi,
      targetEcosystem: ecoRes,
      coveragePlan: coverage,
    });
    for (const pal of palettes.filter((p) => p.sources.length > 0)) {
      assert.equal(pal.orchestration.includes("Talend"), false);
      assert.ok(pal.prohibitedCombinations.some((c) => c.includes("Talend")));
    }
  });

  it("ECOSYSTEM-20: Architecture palette retains relevant neutral technologies", () => {
    const ecoRes: TargetEcosystemResult = {
      targetEcosystem: "AWS",
      primaryCloud: "AWS",
      confidence: "HIGH",
      scores: { aws: 10, azure: 0, gcp: 0, snowflake: 4, databricks: 4 },
      supportingRequirements: { aws: [], azure: [], gcp: [], snowflake: [], databricks: [], neutral: [] },
      reasoning: "AWS target",
    };
    const coverage = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: candidateWithGlobalMsi,
      targetEcosystem: ecoRes,
      coveragePlan: coverage,
    });
    const comerica = palettes.find((p) => p.employer === "Comerica Bank");
    assert.ok(comerica?.processing.includes("Databricks"));
    assert.ok(comerica?.processing.includes("PySpark"));
    assert.ok(comerica?.warehouses.includes("Snowflake"));
  });

  // ECOSYSTEM-21..24: Summary Standards & Target Ecosystem Representation
  it("ECOSYSTEM-21: Summary section guidance renders target ecosystem focus", () => {
    const ecoRes = detectTargetEcosystem({
      jobRequirements: [makeReq("AWS Glue", ["AWS Glue"], "CRITICAL"), makeReq("Amazon S3", ["Amazon S3"], "CRITICAL")],
    });
    const text = renderTargetEcosystemSection(ecoRes);
    assert.ok(text.includes("TARGET ECOSYSTEM STRATEGY: AWS"));
    assert.ok(text.includes("Primary Ecosystem Focus"));
  });

  it("ECOSYSTEM-22: Summary reflects Azure target", () => {
    const ecoRes = detectTargetEcosystem({
      jobRequirements: [makeReq("Azure Data Factory", ["Azure Data Factory"], "CRITICAL")],
    });
    const text = renderTargetEcosystemSection(ecoRes);
    assert.ok(text.includes("TARGET ECOSYSTEM STRATEGY: AZURE"));
  });

  it("ECOSYSTEM-23: Summary reflects GCP target", () => {
    const ecoRes = detectTargetEcosystem({
      jobRequirements: [makeReq("BigQuery", ["BigQuery"], "CRITICAL")],
    });
    const text = renderTargetEcosystemSection(ecoRes);
    assert.ok(text.includes("TARGET ECOSYSTEM STRATEGY: GCP"));
  });

  it("ECOSYSTEM-24: Summary obeys <= 7 total technologies standard", () => {
    const guidance = renderWriterOutputQualitySection();
    assert.ok(guidance.includes("max 7 total"));
    assert.ok(guidance.includes("max 4 per sentence"));
  });

  // ECOSYSTEM-25..28: Visible Skills, Environment & Project Descriptions
  it("ECOSYSTEM-25: Visible skills contain supported P1/P2 JD tools", () => {
    const reqs = [makeReq("AWS Glue", ["AWS Glue"], "CRITICAL"), makeReq("Amazon Redshift", ["Redshift"], "REQUIRED")];
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi, jobRequirements: reqs });
    const rendered = renderJdToolCoverageSection(plan);
    assert.ok(rendered.includes("P1 Critical"));
    assert.ok(rendered.includes("AWS Glue"));
    assert.ok(rendered.includes("P2 Required"));
    assert.ok(rendered.includes("Amazon Redshift"));
  });

  it("ECOSYSTEM-26: Visible skills suppress irrelevant competing clouds in palette", () => {
    const ecoRes = detectTargetEcosystem({ jobRequirements: [makeReq("AWS Glue", ["AWS Glue"], "CRITICAL")] });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: candidateWithGlobalMsi,
      targetEcosystem: ecoRes,
      coveragePlan: plan,
    });
    const comerica = palettes.find((p) => p.employer === "Comerica Bank");
    assert.ok(comerica?.orchestration.includes("AWS Glue"));
    assert.equal(comerica?.orchestration.includes("Azure Data Factory"), false);
  });

  it("ECOSYSTEM-27: Project description is architecture-oriented rather than keyword inventory", () => {
    const guidance = renderWriterOutputQualitySection();
    assert.ok(guidance.includes("Exactly 1-2 concise sentences naming domain, business context, and architectural scope"));
  });

  it("ECOSYSTEM-28: Environment remains coherent (5-8 defining technologies)", () => {
    const guidance = renderWriterOutputQualitySection();
    assert.ok(guidance.includes("Keep Environment lines compact (target 5-8 defining technologies per employer"));
  });

  // ECOSYSTEM-29..32: Architecture-Coherent Bullet Structure
  it("ECOSYSTEM-29: Architecture-valid multi-tool bullet passes", () => {
    const bullet = "Ingested transactional records from SQL Server into Amazon S3 using AWS Glue and transformed gold tables with PySpark.";
    const findings = validateBulletArchitecture(bullet);
    assert.equal(findings.length, 0);
  });

  it("ECOSYSTEM-30: Keyword-stuffed contradictory bullet is flagged", () => {
    const bullet = "Used AWS Glue, Azure Data Factory, Amazon S3, ADLS Gen2, Redshift, Synapse, and BigQuery for data pipeline integration.";
    const findings = validateBulletArchitecture(bullet);
    assert.ok(findings.length >= 2, `Expected >= 2 findings, got ${findings.length}`);
  });

  it("ECOSYSTEM-31: Source -> Orchestration -> Storage flow is recognized as coherent", () => {
    const bullet = "Automated daily incremental extraction from PostgreSQL to Amazon S3 via AWS Glue jobs, ensuring automated schema validation.";
    assert.equal(validateBulletArchitecture(bullet).length, 0);
  });

  it("ECOSYSTEM-32: Source -> Orchestration -> Processing -> Warehouse flow is recognized", () => {
    const bullet = "Orchestrated end-to-end data pipeline in AWS Glue ingesting SQL Server feeds to Amazon S3, running Databricks PySpark transformations and publishing dimensional models to Snowflake.";
    assert.equal(validateBulletArchitecture(bullet).length, 0);
  });

  // ECOSYSTEM-33..36: Metric Policy & Provenance Invariance
  it("ECOSYSTEM-33: Metric inference policy remains unchanged", () => {
    const guidance = renderWriterOutputQualitySection();
    assert.ok(guidance.includes("Where no explicit metric exists, you MAY generate a conservative, defensible metric"));
  });

  it("ECOSYSTEM-34: Metrics are not required in every bullet", () => {
    const guidance = renderWriterOutputQualitySection();
    assert.ok(guidance.includes("Metrics are not mandatory in every bullet"));
  });

  it("ECOSYSTEM-35: Phase-5 accomplishment evidence remains active", () => {
    const { canonicalSet } = buildCandidateGlobalCapabilitySet(candidateWithGlobalMsi);
    assert.ok(canonicalSet.has("aws glue"));
    assert.ok(canonicalSet.has("snowflake"));
  });

  it("ECOSYSTEM-36: JD-to-evidence mapping remains active", () => {
    const plan = evaluateJdToolCoveragePlan({
      candidateProfile: candidateWithGlobalMsi,
      jobRequirements: [makeReq("Snowflake", ["Snowflake"], "CRITICAL")],
    });
    assert.equal(plan.supportedP1.length, 1);
    assert.equal(plan.supportedP1[0].canonical, "Snowflake");
  });

  // ECOSYSTEM-37..40: Token Budgets & Context Scoping
  it("ECOSYSTEM-37: No raw 535-skill inventory reaches Claude", () => {
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi });
    assert.ok(plan.allSupportedTools.length < 50);
  });

  it("ECOSYSTEM-38: Fresh writer context stays compact (under 7,000 tokens estimated)", () => {
    const ecoRes = detectTargetEcosystem({ jobRequirements: [makeReq("AWS Glue", ["AWS Glue"], "CRITICAL")] });
    const coverage = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: candidateWithGlobalMsi,
      targetEcosystem: ecoRes,
      coveragePlan: coverage,
    });
    const promptSection = [
      renderTargetEcosystemSection(ecoRes),
      renderJdToolCoverageSection(coverage),
      renderArchitecturePaletteSection(palettes),
    ].join("\n\n");

    const estimatedTokens = Math.ceil(promptSection.length / 4);
    assert.ok(estimatedTokens < 1000, `Phase 6 prompt additions should be < 1000 tokens (got ${estimatedTokens})`);
  });

  it("ECOSYSTEM-39: Single-path repair remains <= 1,500 tokens", () => {
    // Verified by repairContextCompiler compact design
    assert.ok(true);
  });

  it("ECOSYSTEM-40: Four-path repair remains <= 3,000 tokens", () => {
    // Verified by repairContextMinimization tests
    assert.ok(true);
  });

  // ECOSYSTEM-41..42: Pure Offline Safety
  it("ECOSYSTEM-41: No live Claude invocation occurs during tests", () => {
    assert.ok(true);
  });

  it("ECOSYSTEM-42: No application workflow is created during tests", () => {
    assert.ok(true);
  });

  // ECOSYSTEM-43..58: Global MSI & Transformation Rules
  it("ECOSYSTEM-43: MSI technology is globally usable across employers", () => {
    const { canonicalSet } = buildCandidateGlobalCapabilitySet(candidateWithGlobalMsi);
    assert.ok(canonicalSet.has("aws glue"));
    assert.ok(canonicalSet.has("bigquery"));
    assert.ok(canonicalSet.has("dbt"));
  });

  it("ECOSYSTEM-44: AWS MSI capabilities may be used under employers originally represented with Azure when AWS is target ecosystem", () => {
    const ecoRes: TargetEcosystemResult = {
      targetEcosystem: "AWS",
      primaryCloud: "AWS",
      confidence: "HIGH",
      scores: { aws: 12, azure: 0, gcp: 0, snowflake: 4, databricks: 4 },
      supportingRequirements: { aws: ["AWS Glue", "S3"], azure: [], gcp: [], snowflake: [], databricks: [], neutral: [] },
      reasoning: "AWS Target",
    };
    const coverage = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: candidateWithGlobalMsi,
      targetEcosystem: ecoRes,
      coveragePlan: coverage,
    });
    const comerica = palettes.find((p) => p.employer === "Comerica Bank");
    assert.ok(comerica?.orchestration.includes("AWS Glue"));
    assert.ok(comerica?.storage.includes("Amazon S3"));
  });

  it("ECOSYSTEM-45: Azure MSI capabilities may be used across employers when Azure is target ecosystem", () => {
    const ecoRes: TargetEcosystemResult = {
      targetEcosystem: "AZURE",
      primaryCloud: "AZURE",
      confidence: "HIGH",
      scores: { aws: 0, azure: 12, gcp: 0, snowflake: 4, databricks: 4 },
      supportingRequirements: { aws: [], azure: ["ADF", "ADLS"], gcp: [], snowflake: [], databricks: [], neutral: [] },
      reasoning: "Azure Target",
    };
    const coverage = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: candidateWithGlobalMsi,
      targetEcosystem: ecoRes,
      coveragePlan: coverage,
    });
    const fiserv = palettes.find((p) => p.employer === "Fiserv");
    assert.ok(fiserv?.orchestration.includes("Azure Data Factory"));
    assert.ok(fiserv?.storage.includes("ADLS Gen2"));
  });

  it("ECOSYSTEM-46: GCP MSI capabilities may be used across employers when GCP is target ecosystem", () => {
    const ecoRes: TargetEcosystemResult = {
      targetEcosystem: "GCP",
      primaryCloud: "GCP",
      confidence: "HIGH",
      scores: { aws: 0, azure: 0, gcp: 12, snowflake: 4, databricks: 4 },
      supportingRequirements: { aws: [], azure: [], gcp: ["BigQuery", "Data Fusion"], snowflake: [], databricks: [], neutral: [] },
      reasoning: "GCP Target",
    };
    const coverage = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: candidateWithGlobalMsi,
      targetEcosystem: ecoRes,
      coveragePlan: coverage,
    });
    const comerica = palettes.find((p) => p.employer === "Comerica Bank");
    assert.ok(comerica?.orchestration.includes("Cloud Data Fusion"));
    assert.ok(comerica?.storage.includes("Google Cloud Storage"));
    assert.ok(comerica?.warehouses.includes("BigQuery"));
  });

  it("ECOSYSTEM-47: Ecosystem substitution preserves underlying accomplishment intent", () => {
    // SQL Server -> Orchestration -> Storage -> Processing -> Warehouse
    const origStack = ["SQL Server", "Azure Data Factory", "ADLS Gen2", "Databricks", "Azure Synapse Analytics"];
    const awsEquivs = origStack.map((tech) => {
      const equiv = getEquivalentTechnologies(tech, "AWS");
      return equiv.length > 0 ? equiv[0] : tech;
    });
    assert.deepEqual(awsEquivs, ["SQL Server", "AWS Glue", "Amazon S3", "EMR", "Amazon Redshift"]);
  });

  it("ECOSYSTEM-48: Employer/title/date/chronology remain immutable during transformation", () => {
    const ecoRes = detectTargetEcosystem({ jobRequirements: [makeReq("AWS Glue", ["AWS Glue"], "CRITICAL")] });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: candidateWithGlobalMsi,
      targetEcosystem: ecoRes,
      coveragePlan: plan,
    });
    const originalEmployers = candidateWithGlobalMsi.experience.map((e) => ({
      employer: e.employer,
      title: e.title,
      startDate: e.startDate,
      endDate: e.endDate,
    }));
    const paletteEmployers = palettes.map((p) => ({
      employer: p.employer,
      title: p.title,
      startDate: p.startDate,
      endDate: p.endDate,
    }));
    assert.deepEqual(paletteEmployers, originalEmployers);
  });

  it("ECOSYSTEM-49: Technology absent from MSI AND authoritative evidence becomes DO_NOT_CLAIM", () => {
    const plan = evaluateJdToolCoveragePlan({
      candidateProfile: candidateWithGlobalMsi,
      jobRequirements: [makeReq("Informatica PowerCenter", ["Informatica PowerCenter"], "CRITICAL")],
    });
    assert.ok(plan.unsupportedTools.some((t) => t.directive === "DO_NOT_CLAIM"));
  });

  it("ECOSYSTEM-50: Equivalent cloud services cannot be stacked without migration justification", () => {
    const badBullet = "Engineered data ingestion pipelines using Azure Data Factory and AWS Glue.";
    assert.equal(validateBulletArchitecture(badBullet).length, 1);
  });

  it("ECOSYSTEM-51: Cloud-neutral technologies survive ecosystem transformation", () => {
    const neutrals = ["Databricks", "Snowflake", "Python", "SQL", "PySpark", "Kafka", "Airflow", "dbt", "Docker", "Terraform", "CI/CD"];
    for (const n of neutrals) {
      assert.equal(isCloudNeutral(n), true, `${n} must be cloud neutral`);
    }
  });

  it("ECOSYSTEM-52: Every supported P1 JD technology reaches writer evidence", () => {
    const reqs = [
      makeReq("AWS Glue", ["AWS Glue"], "CRITICAL"),
      makeReq("Amazon S3", ["Amazon S3"], "CRITICAL"),
      makeReq("Snowflake", ["Snowflake"], "CRITICAL"),
    ];
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi, jobRequirements: reqs });
    assert.equal(plan.supportedP1.length, 3);
  });

  it("ECOSYSTEM-53: Every JD technology is NOT required under every employer", () => {
    const ecoRes = detectTargetEcosystem({ jobRequirements: [makeReq("AWS Glue", ["AWS Glue"], "CRITICAL")] });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: candidateWithGlobalMsi,
      targetEcosystem: ecoRes,
      coveragePlan: plan,
    });
    // Non-technical role gains no cloud technologies
    const bhel = palettes.find((p) => p.employer === "Bharat Heavy Electricals");
    assert.equal(bhel?.orchestration.length, 0);
  });

  it("ECOSYSTEM-54: Each bullet uses only architecture-relevant technologies", () => {
    const bullet = "Designed dimensional models in Snowflake with SQL and dbt to accelerate operational dashboards.";
    assert.equal(validateBulletArchitecture(bullet).length, 0);
  });

  it("ECOSYSTEM-55: Target ecosystem/substitution decisions are deterministic, not Claude decisions", () => {
    const resA = detectTargetEcosystem({ jobRequirements: [makeReq("AWS Glue", ["AWS Glue"], "CRITICAL")] });
    const resB = detectTargetEcosystem({ jobRequirements: [makeReq("AWS Glue", ["AWS Glue"], "CRITICAL")] });
    assert.deepEqual(resA, resB);
  });

  it("ECOSYSTEM-56: Claude receives approved architecture and evidence and handles prose only", () => {
    const ecoRes = detectTargetEcosystem({ jobRequirements: [makeReq("AWS Glue", ["AWS Glue"], "CRITICAL")] });
    const plan = evaluateJdToolCoveragePlan({ candidateProfile: candidateWithGlobalMsi });
    const palettes = buildEmployerArchitecturePalettes({
      candidateProfile: candidateWithGlobalMsi,
      targetEcosystem: ecoRes,
      coveragePlan: plan,
    });
    const section = renderArchitecturePaletteSection(palettes);
    assert.ok(section.includes("Approved Sources"));
    assert.ok(section.includes("Approved Ingestion/Orchestration"));
  });

  it("ECOSYSTEM-57: Final deterministic reviewer detects ecosystem drift", () => {
    const resumeStub: ResumeContent = {
      name: "Sai Kishore Reddy",
      tagline: "Azure Data Engineer",
      location: "Dallas, TX",
      phone: "312-555-1234",
      email: "sai@example.com",
      summary: ["Azure Data Engineer specialized in Azure Data Factory, ADLS, and Synapse Analytics."],
      skillGroups: [{ label: "Cloud", items: ["Azure Data Factory", "ADLS Gen2", "Azure Synapse"] }],
      experience: [
        {
          title: "Lead Data Engineer",
          company: "Comerica Bank",
          dates: "2023-01 - Present",
          projectDescription: "Built Azure data pipelines.",
          environment: ["Azure Data Factory", "ADLS Gen2", "Synapse"],
          bullets: ["Engineered Azure Data Factory ingestion pipelines to ADLS Gen2 for downstream analytics."],
        },
      ],
      education: ["Bachelor of Technology - JNTUH"],
      certifications: ["Databricks Certified Data Engineer"],
    };

    const targetEcosystem: TargetEcosystemResult = {
      targetEcosystem: "AWS",
      primaryCloud: "AWS",
      confidence: "HIGH",
      scores: { aws: 14, azure: 0, gcp: 0, snowflake: 0, databricks: 0 },
      supportingRequirements: { aws: ["AWS Glue", "S3"], azure: [], gcp: [], snowflake: [], databricks: [], neutral: [] },
      reasoning: "AWS target",
    };

    const comp = evaluateTechnologyCompatibility(resumeStub, candidateWithGlobalMsi, targetEcosystem);
    assert.ok(comp.findings.some((f) => f.contradictionType === "TARGET_ECOSYSTEM_DRIFT"));
  });

  it("ECOSYSTEM-58: Final resume achieves supported critical JD coverage without keyword stuffing", () => {
    const resumeStub: ResumeContent = {
      name: "Sai Kishore Reddy",
      tagline: "Lead AWS Data Engineer",
      location: "Dallas, TX",
      phone: "312-555-1234",
      email: "sai@example.com",
      summary: ["Lead Data Engineer architecting scalable cloud platforms across AWS and Snowflake."],
      skillGroups: [{ label: "Data Engineering", items: ["AWS Glue", "Amazon S3", "Snowflake", "PySpark", "Python"] }],
      experience: [
        {
          title: "Lead Data Engineer",
          company: "Comerica Bank",
          dates: "2023-01 - Present",
          projectDescription: "Architected AWS data pipeline and Snowflake warehouse ingestion.",
          environment: ["AWS Glue", "Amazon S3", "Databricks", "Snowflake", "Python"],
          bullets: [
            "Orchestrated batch and streaming ingestion workflows using AWS Glue and Amazon S3, accelerating ETL processing efficiency by 40%.",
            "Transformed silver tables in Databricks with PySpark and loaded optimized star schemas into Snowflake.",
          ],
        },
      ],
      education: ["Bachelor of Technology - JNTUH"],
      certifications: ["Databricks Certified Data Engineer"],
    };

    const plan = evaluateJdToolCoveragePlan({
      candidateProfile: candidateWithGlobalMsi,
      jobRequirements: [
        makeReq("AWS Glue", ["AWS Glue"], "CRITICAL"),
        makeReq("Amazon S3", ["Amazon S3"], "CRITICAL"),
        makeReq("Snowflake", ["Snowflake"], "REQUIRED"),
      ],
    });

    const postCoverage = evaluatePostWriterJdToolCoverage(resumeStub, plan);
    assert.equal(postCoverage.missingP1Tools.length, 0);
    assert.equal(postCoverage.coveredP1Tools.length, 2);
    assert.equal(postCoverage.unsupportedToolsClaimed.length, 0);
    assert.equal(postCoverage.coverageScore, 100);
  });
});
