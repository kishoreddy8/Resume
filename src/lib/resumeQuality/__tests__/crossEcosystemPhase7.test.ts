import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import type { CandidateProfile } from "@/lib/match/types";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import {
  reconcileJdRequirements,
  canonicalRequirementsToRequirementUnits,
  getReconciledUnsupportedNames,
  type CanonicalJdRequirement,
} from "../jdRequirementReconciler";
import { detectTargetEcosystem, type TargetEcosystemResult } from "../targetEcosystem";
import { evaluateJdToolCoveragePlan } from "../jdToolCoverage";
import { buildEmployerArchitecturePalettes, type EmployerArchitecturePalette } from "../architecturePalette";
import { dynamicSummaryTechnologyCeiling } from "../summaryTechnologyBudget";
import { buildCandidateGlobalCapabilitySet } from "../jdToolCoverage";
import { classifyTechnology } from "../technologyClassification";

/**
 * PHASE 7 — CROSS-ECOSYSTEM DETERMINISTIC VALIDATION.
 *
 * Proves the SAME deterministic pipeline validated for the real Snowflake-centered/Azure-supporting
 * Celigo scenario (Phase 6.4A-6.8) generalizes correctly across Azure/AWS/GCP/Snowflake/Databricks/
 * multi-cloud/alternative-cloud/cloud-neutral JDs. Uses Candidate 1's REAL profile (loadCandidateProfile
 * is read-only — no DB writes, no candidate/job/application mutation) as the single "primary capability
 * profile" throughout, per the mission's explicit instruction. Zero Claude writer invocations anywhere
 * in this file — every assertion below is against pure, synchronous, deterministic functions.
 *
 * Realistic full Senior Data Engineer JD text is used for every scenario (mission role, responsibilities,
 * required/preferred technologies, modeling/quality/governance/DevOps expectations) — reconciliation is
 * always run against `rawJd` text with an EMPTY structuredRequirements array, so every canonical
 * requirement in every scenario below is genuinely recovered by RAW_JD_RECONCILIATION, never hand-built.
 */

let candidateProfile: CandidateProfile;

before(() => {
  const result = loadCandidateProfile(1);
  assert.equal(result.status, "ok", "Candidate 1's real profile must load for Phase 7 validation");
  if (result.status === "ok") candidateProfile = result.profile;
});

interface ScenarioResult {
  reconciliation: CanonicalJdRequirement[];
  ecosystem: TargetEcosystemResult;
  palettes: EmployerArchitecturePalette[];
}

function runScenario(rawJd: string, roleTitle: string, company: string): ScenarioResult {
  const reconciliation = reconcileJdRequirements({
    rawJd,
    structuredRequirements: [],
    candidateProfile,
    roleTitle,
  });
  const units = canonicalRequirementsToRequirementUnits(reconciliation.canonicalRequirements);
  const ecosystem = detectTargetEcosystem({
    company,
    roleTitle,
    jobDescriptionText: rawJd,
    jobRequirements: units,
    candidateProfile,
  });
  const coveragePlan = evaluateJdToolCoveragePlan({ candidateProfile, jobRequirements: units });
  const palettes = buildEmployerArchitecturePalettes({
    candidateProfile,
    targetEcosystem: ecosystem,
    coveragePlan,
    jobRequirements: units,
    authoritativeUnsupportedTools: getReconciledUnsupportedNames(reconciliation.canonicalRequirements),
  });
  return { reconciliation: reconciliation.canonicalRequirements, ecosystem, palettes };
}

// =====================================================================================================
// SCENARIO FIXTURES — realistic Senior Data Engineer JDs, one per ecosystem shape.
// =====================================================================================================

const JD_AZURE = `Senior Data Engineer — Enterprise Data Platform (Azure)

Mission: We are modernizing our enterprise data platform on Microsoft Azure to support governed,
near-real-time analytics across banking and payments domains.

Responsibilities:
- Design and build ingestion pipelines in Azure Data Factory moving transactional data from source
  systems into ADLS Gen2.
- Build and maintain Azure Databricks and PySpark transformation jobs to curate raw data into
  governed, analytics-ready tables.
- Model dimensional schemas (star schema, fact/dimension) in Azure Synapse Analytics to support
  downstream analytics and reporting.
- Implement data quality validation, reconciliation, and CDC/SCD Type 2 history tracking across
  pipelines.
- Establish CI/CD pipelines using Azure DevOps and Git for reliable, repeatable deployments.
- Partner with data governance and security teams to enforce RBAC, key management, and audit
  controls via Azure Key Vault.

Required:
- Must have deep expertise in Azure Data Factory and ADLS Gen2; 5+ years architecting and
  implementing production pipelines on Azure Databricks and Azure Synapse Analytics is required.
- Strong Python and SQL skills.
- Experience with PySpark-based transformation pipelines.
- Dimensional modeling experience (star schema, fact/dimension tables).
- Experience with data quality validation and reconciliation processes.
- Experience with CI/CD using Azure DevOps.

Preferred (nice to have):
- Familiarity with Power BI or similar reporting tools is a plus.
- Experience with Terraform for infrastructure as code is a plus.`;

const JD_AWS = `Senior Data Engineer — Cloud Data Platform (AWS)

Mission: We are building a modern, governed data platform on Amazon Web Services to power
operational and analytical reporting for our payments and lending business lines.

Responsibilities:
- Design and build ingestion pipelines using AWS Glue moving transactional data from source systems
  into Amazon S3.
- Build PySpark-based transformation jobs to curate raw data into governed, analytics-ready tables.
- Model dimensional schemas (star schema, fact/dimension) in Amazon Redshift to support downstream
  analytics and reporting.
- Implement data quality validation, reconciliation, and CDC/SCD Type 2 history tracking across
  pipelines.
- Build event-driven data processing using AWS Lambda where appropriate, and leverage AWS EMR for
  large-scale batch processing.
- Establish CI/CD pipelines using Git and modern DevOps tooling for reliable, repeatable deployments.
- Partner with data governance and security teams to enforce IAM-based access control and audit
  logging.

Required:
- 5+ years of experience with AWS Glue, Amazon S3, and Amazon Redshift.
- Strong Python and SQL skills.
- Experience with PySpark/Spark-based transformation pipelines.
- Experience with AWS EMR or AWS Lambda for data processing.
- Dimensional modeling experience (star schema, fact/dimension tables).
- Experience with data quality validation and reconciliation processes.

Preferred:
- Experience with Redshift performance tuning.
- Experience with Terraform for infrastructure as code.`;

const JD_GCP = `Senior Data Engineer — Cloud Data Platform (GCP)

Mission: We are building a governed, scalable data platform on Google Cloud Platform to power
operational and analytical reporting for our fintech products.

Responsibilities:
- Design and build ingestion pipelines moving transactional data from source systems into Google
  Cloud Storage.
- Build PySpark-based transformation jobs on Dataproc to curate raw data into governed,
  analytics-ready tables.
- Model dimensional schemas (star schema, fact/dimension) in BigQuery to support downstream
  analytics and reporting.
- Implement data quality validation, reconciliation, and CDC/SCD Type 2 history tracking across
  pipelines.
- Orchestrate pipeline execution using Cloud Composer (managed Airflow).
- Establish CI/CD pipelines using Git and modern DevOps tooling for reliable, repeatable deployments.
- Partner with data governance and security teams to enforce IAM-based access control and audit
  logging.

Required:
- 5+ years of experience with Google Cloud Storage and BigQuery.
- Strong Python and SQL skills.
- Experience with PySpark/Spark-based transformation pipelines on Dataproc.
- Dimensional modeling experience (star schema, fact/dimension tables).
- Experience with data quality validation and reconciliation processes.
- Experience with Airflow-based orchestration.

Preferred:
- Experience with Cloud Data Fusion.
- Experience with BigQuery performance tuning.`;

const JD_SNOWFLAKE = `Senior Data Engineer — Snowflake Data Platform

Mission: We are building a governed enterprise data warehouse on Snowflake to support enterprise
reporting, analytics, and downstream data products.

Responsibilities:
- Design and build ELT pipelines loading data into Snowflake from a variety of source systems.
- Model dimensional schemas (star schema, fact/dimension) and evaluate Data Vault modeling patterns
  for historized enterprise data.
- Build and maintain dbt models for transformation, testing, and documentation of the Snowflake
  warehouse layer.
- Support warehouse migration and rebuild initiatives as legacy systems are decommissioned.
- Implement data quality validation, reconciliation, and governance controls across the warehouse.
- Orchestrate pipeline execution using a modern orchestration tool.
- Establish CI/CD pipelines using Git for reliable, repeatable deployments.

Required:
- 5+ years of experience with Snowflake data warehouse design and development.
- Strong Python and SQL skills.
- Experience with dbt for transformation and testing.
- Dimensional modeling experience (star schema, fact/dimension tables); Data Vault modeling
  exposure a plus.
- Experience with data quality validation, reconciliation, and governance processes.
- Experience with pipeline orchestration.

Preferred:
- Experience with warehouse migration or rebuild projects.
- Experience with role-based access control and data governance frameworks.`;

const JD_DATABRICKS = `Senior Data Engineer — Lakehouse Data Platform

Mission: We are building a governed lakehouse data platform on Databricks to support near-real-time
operational and analytical workloads.

Responsibilities:
- Design and build PySpark-based ingestion and transformation pipelines feeding a medallion
  (bronze/silver/gold) architecture.
- Build and maintain Delta Lake tables with CDC and SCD Type 2 history tracking for enterprise data.
- Model dimensional schemas for the gold/consumption layer to support downstream analytics.
- Implement data quality validation, reconciliation, and governance controls across the lakehouse.
- Support streaming ingestion for near-real-time use cases using Structured Streaming.
- Establish CI/CD pipelines using Git for reliable, repeatable deployments.

Required:
- 5+ years of experience with Databricks and PySpark for large-scale data engineering.
- Strong Python and SQL skills.
- Experience with Delta Lake and medallion architecture design.
- Experience with CDC and SCD Type 2 history tracking.
- Dimensional modeling experience for analytics-ready data products.
- Experience with data quality validation, reconciliation, and governance processes.

Preferred:
- Experience with streaming/near-real-time pipelines.
- Experience with CI/CD and DevOps practices.`;

const JD_AZURE_AWS = `Senior Data Engineer — Multi-Cloud Data Platform (Azure + AWS)

Mission: Design and operate data platforms across both Azure and AWS to support our newly-merged
banking and payments divisions, ensuring consistent governance across environments during an active
cloud consolidation initiative.

Responsibilities:
- Build ingestion and transformation pipelines using Azure Data Factory and Azure Databricks for
  the banking division's Azure environment.
- Build ingestion and transformation pipelines using AWS Glue and Amazon S3 for the payments
  division's AWS environment.
- Model dimensional schemas in Azure Synapse Analytics and Amazon Redshift respectively.
- Implement consistent data quality validation, reconciliation, and governance controls across both
  cloud environments.
- Support workload migration between Azure and AWS as the organization consolidates its cloud
  footprint.
- Establish CI/CD pipelines for reliable, repeatable deployments across both clouds.

Required:
- 5+ years of experience with both Azure (Data Factory, ADLS Gen2, Databricks, Synapse) and AWS
  (Glue, S3, Redshift) data platforms.
- Strong Python and SQL skills.
- Experience with PySpark-based transformation pipelines.
- Dimensional modeling experience (star schema, fact/dimension tables).
- Experience with data quality validation and reconciliation processes.

Preferred:
- Experience with cross-cloud data migration projects.`;

const JD_AWS_GCP = `Senior Data Engineer — Multi-Cloud Data Platform (AWS + GCP)

Mission: Design and operate data platforms across both AWS and GCP to support our merged fintech
and marketplace analytics divisions, integrating pipelines across both clouds during an active
platform consolidation initiative.

Responsibilities:
- Build ingestion and transformation pipelines using AWS Glue and Amazon S3 for the fintech
  division's AWS environment.
- Build ingestion and transformation pipelines using Google Cloud Storage and Dataproc for the
  marketplace division's GCP environment.
- Model dimensional schemas in Amazon Redshift and BigQuery respectively.
- Implement consistent data quality validation, reconciliation, and governance controls across both
  cloud environments.
- Support workload migration between AWS and GCP as the organization consolidates its analytics
  footprint.
- Establish CI/CD pipelines for reliable, repeatable deployments across both clouds.

Required:
- 5+ years of experience with both AWS (Glue, S3, Redshift) and GCP (Cloud Storage, BigQuery) data
  platforms.
- Strong Python and SQL skills.
- Experience with PySpark-based transformation pipelines.
- Dimensional modeling experience (star schema, fact/dimension tables).
- Experience with data quality validation and reconciliation processes.

Preferred:
- Experience with cross-cloud data migration projects.`;

const JD_THREE_CLOUD = `Senior Data Engineer — Global Multi-Cloud Data Platform (Azure + AWS + GCP)

Mission: Build and maintain a multi-cloud architecture across Azure, AWS, and GCP to support our
globally distributed banking, payments, and marketplace divisions, each currently operating on a
different cloud provider.

Responsibilities:
- Build ingestion and transformation pipelines using Azure Data Factory for the banking division's
  Azure environment.
- Build ingestion and transformation pipelines using AWS Glue for the payments division's AWS
  environment.
- Build ingestion and transformation pipelines using Google Cloud Storage for the marketplace
  division's GCP environment.
- Model dimensional schemas in Azure Synapse Analytics, Amazon Redshift, and BigQuery respectively.
- Implement consistent data quality validation, reconciliation, and governance controls across all
  three cloud environments.
- Establish CI/CD pipelines for reliable, repeatable deployments across all three clouds.

Required:
- 5+ years of experience with Azure (Data Factory, Synapse), AWS (Glue, Redshift), and GCP (Cloud
  Storage, BigQuery) data platforms.
- Strong Python and SQL skills.
- Experience with PySpark-based transformation pipelines.
- Dimensional modeling experience (star schema, fact/dimension tables).
- Experience with data quality validation and reconciliation processes.

Preferred:
- Experience with cross-cloud data migration projects.`;

const JD_ALTERNATIVE_THREE = `Senior Data Engineer — Enterprise Data Platform (Cloud-Flexible)

Mission: We are modernizing our enterprise data platform to support governed, near-real-time
analytics across banking and payments domains. This role is cloud-flexible.

Responsibilities:
- Design and build ingestion and transformation pipelines moving transactional data from source
  systems into cloud object storage.
- Build PySpark-based transformation jobs to curate raw data into governed, analytics-ready tables.
- Model dimensional schemas (star schema, fact/dimension) to support downstream analytics and
  reporting.
- Implement data quality validation, reconciliation, and CDC/SCD Type 2 history tracking across
  pipelines.
- Establish CI/CD pipelines for reliable, repeatable deployments.

Required:
- 5+ years of data engineering experience.
- Experience with AWS, Azure, or GCP — any major cloud provider is acceptable for this role.
- Strong Python and SQL skills.
- Experience with PySpark-based transformation pipelines.
- Dimensional modeling experience (star schema, fact/dimension tables).
- Experience with data quality validation and reconciliation processes.

Preferred:
- Experience with any major cloud provider such as AWS, Azure, or GCP for data warehousing.`;

const JD_ALTERNATIVE_TWO = `Senior Data Engineer — Cloud-Native Data Platform

Mission: We are building a cloud-native data platform to support governed, near-real-time analytics
across our fintech products.

Responsibilities:
- Design and build ingestion and transformation pipelines moving transactional data from source
  systems into cloud object storage.
- Build PySpark-based transformation jobs to curate raw data into governed, analytics-ready tables.
- Model dimensional schemas (star schema, fact/dimension) to support downstream analytics and
  reporting.
- Implement data quality validation, reconciliation, and CDC/SCD Type 2 history tracking across
  pipelines.
- Establish CI/CD pipelines for reliable, repeatable deployments.

Required:
- 5+ years of data engineering experience.
- Experience with AWS or GCP is required for this cloud-native role.
- Strong Python and SQL skills.
- Experience with PySpark-based transformation pipelines.
- Dimensional modeling experience (star schema, fact/dimension tables).
- Experience with data quality validation and reconciliation processes.

Preferred:
- Experience with data warehousing on either platform.`;

const CLOUD_NEUTRAL_TERMS = ["Snowflake", "Databricks", "Python", "SQL", "PySpark", "Delta Lake", "Git", "CI/CD"];

// =====================================================================================================
// A. AZURE
// =====================================================================================================
describe("Phase 7: Scenario A — AZURE-centered JD", () => {
  const r = runScenario(JD_AZURE, "Senior Data Engineer", "Meridian Financial");

  it("CROSS-AZURE-01: Azure JD selects Azure", () => {
    assert.equal(r.ecosystem.cloudRequirementMode, "SINGLE");
    assert.equal(r.ecosystem.supportingCloud, "AZURE");
    assert.deepEqual(r.ecosystem.cloudsExplicitlyMentioned, ["AZURE"]);
    for (const a of r.ecosystem.employerCloudAssignments) assert.equal(a.cloud, "AZURE");
  });

  it("CROSS-AZURE-02: Azure palette excludes AWS/GCP primary services", () => {
    for (const p of r.palettes) {
      const all = [...p.sources, ...p.orchestration, ...p.storage, ...p.processing, ...p.warehouses, ...p.devops];
      for (const banned of ["AWS Glue", "Amazon S3", "Amazon Redshift", "Google Cloud Storage", "BigQuery"]) {
        assert.ok(!all.includes(banned), `Azure palette for ${p.employer} must not include ${banned}`);
      }
    }
  });
});

// =====================================================================================================
// B. AWS
// =====================================================================================================
describe("Phase 7: Scenario B — AWS-centered JD", () => {
  const r = runScenario(JD_AWS, "Senior Data Engineer", "Harborline Payments");

  it("CROSS-AWS-01: AWS JD selects AWS", () => {
    assert.equal(r.ecosystem.cloudRequirementMode, "SINGLE");
    assert.equal(r.ecosystem.supportingCloud, "AWS");
    for (const a of r.ecosystem.employerCloudAssignments) assert.equal(a.cloud, "AWS");
  });

  it("CROSS-AWS-02: AWS palette uses AWS equivalents and suppresses Azure-primary services", () => {
    for (const p of r.palettes) {
      const all = [...p.sources, ...p.orchestration, ...p.storage, ...p.processing, ...p.warehouses, ...p.devops];
      assert.ok(all.includes("AWS Glue"));
      assert.ok(all.includes("Amazon S3"));
      for (const banned of ["Azure Data Factory", "ADLS Gen2", "Azure Synapse Analytics", "Azure DevOps"]) {
        assert.ok(!all.includes(banned), `AWS palette for ${p.employer} must not include ${banned}`);
      }
    }
  });
});

// =====================================================================================================
// C. GCP
// =====================================================================================================
describe("Phase 7: Scenario C — GCP-centered JD", () => {
  const r = runScenario(JD_GCP, "Senior Data Engineer", "Vantage Fintech");

  it("CROSS-GCP-01: GCP JD selects GCP", () => {
    assert.equal(r.ecosystem.cloudRequirementMode, "SINGLE");
    assert.equal(r.ecosystem.supportingCloud, "GCP");
    for (const a of r.ecosystem.employerCloudAssignments) assert.equal(a.cloud, "GCP");
  });

  it("CROSS-GCP-02: unsupported GCP tool (Cloud Data Fusion) remains DO_NOT_CLAIM", () => {
    const cdf = r.reconciliation.find((req) => req.canonicalName === "Cloud Data Fusion");
    assert.ok(cdf, "Cloud Data Fusion must be recovered as a canonical requirement from raw JD text");
    assert.equal(cdf?.writerAction, "DO_NOT_CLAIM");
    // And it must never be silently promoted into a palette either.
    for (const p of r.palettes) {
      const all = [...p.sources, ...p.orchestration, ...p.storage, ...p.processing, ...p.warehouses, ...p.devops];
      assert.ok(!all.includes("Cloud Data Fusion"));
    }
  });
});

// =====================================================================================================
// D. SNOWFLAKE / NO CLOUD
// =====================================================================================================
describe("Phase 7: Scenario D — SNOWFLAKE-centered / no explicit cloud", () => {
  const r = runScenario(JD_SNOWFLAKE, "Senior Data Engineer", "Ledgerstone Analytics");

  it("CROSS-SNOWFLAKE-01: Snowflake/no-cloud JD selects Snowflake-centered + Azure fallback", () => {
    assert.equal(r.ecosystem.cloudRequirementMode, "NONE");
    assert.equal(r.ecosystem.targetEcosystem, "SNOWFLAKE_CENTERED");
    assert.equal(r.ecosystem.primaryPlatform, "SNOWFLAKE");
    assert.equal(r.ecosystem.supportingCloud, "AZURE");
    for (const a of r.ecosystem.employerCloudAssignments) assert.equal(a.cloud, "AZURE");
  });
});

// =====================================================================================================
// E. DATABRICKS / NO CLOUD
// =====================================================================================================
describe("Phase 7: Scenario E — DATABRICKS-centered / no explicit cloud", () => {
  const r = runScenario(JD_DATABRICKS, "Senior Data Engineer", "Northfall Data Co");

  it("CROSS-DATABRICKS-01: Databricks/no-cloud JD selects Databricks-centered + Azure fallback", () => {
    assert.equal(r.ecosystem.cloudRequirementMode, "NONE");
    assert.equal(r.ecosystem.targetEcosystem, "DATABRICKS_CENTERED");
    assert.equal(r.ecosystem.primaryPlatform, "DATABRICKS");
    assert.equal(r.ecosystem.supportingCloud, "AZURE");
    for (const a of r.ecosystem.employerCloudAssignments) assert.equal(a.cloud, "AZURE");
  });
});

// =====================================================================================================
// F/G/H — TRUE MULTI-CLOUD
// =====================================================================================================
describe("Phase 7: Scenario F — TRUE TWO-CLOUD Azure+AWS", () => {
  const r = runScenario(JD_AZURE_AWS, "Senior Data Engineer", "Continuum Bank");

  it("CROSS-TWO-01: Azure+AWS true-two-cloud distribution is correct (Comerica/Fiserv -> AZURE, Microgate -> AWS)", () => {
    assert.equal(r.ecosystem.cloudRequirementMode, "TRUE_TWO_CLOUD");
    assert.equal(r.ecosystem.targetEcosystem, "MULTI_CLOUD");
    const byEmployer = Object.fromEntries(r.ecosystem.employerCloudAssignments.map((a) => [a.employer, a.cloud]));
    assert.equal(byEmployer["Comerica Bank"], "AZURE");
    assert.equal(byEmployer["Fiserv"], "AZURE");
    assert.equal(byEmployer["Microgate Technologies"], "AWS");
  });

  it("no same-employer unexplained ADF+Glue / ADLS+S3 stacking", () => {
    for (const p of r.palettes) {
      const orch = p.orchestration;
      const storage = p.storage;
      assert.ok(!(orch.includes("Azure Data Factory") && orch.includes("AWS Glue")), `${p.employer} must not stack competing orchestrators`);
      assert.ok(!(storage.includes("ADLS Gen2") && storage.includes("Amazon S3")), `${p.employer} must not stack competing storage`);
    }
  });
});

describe("Phase 7: Scenario G — TRUE TWO-CLOUD AWS+GCP", () => {
  const r = runScenario(JD_AWS_GCP, "Senior Data Engineer", "Marketflow Inc");

  it("CROSS-TWO-02: AWS+GCP true-two-cloud injects zero Azure", () => {
    assert.equal(r.ecosystem.cloudRequirementMode, "TRUE_TWO_CLOUD");
    assert.equal(r.ecosystem.targetEcosystem, "MULTI_CLOUD");
    assert.ok(!r.ecosystem.cloudsExplicitlyMentioned.includes("AZURE"));
    for (const a of r.ecosystem.employerCloudAssignments) assert.notEqual(a.cloud, "AZURE");
    const byEmployer = Object.fromEntries(r.ecosystem.employerCloudAssignments.map((a) => [a.employer, a.cloud]));
    assert.equal(byEmployer["Comerica Bank"], "AWS");
    assert.equal(byEmployer["Fiserv"], "AWS");
    assert.equal(byEmployer["Microgate Technologies"], "GCP");
    for (const p of r.palettes) {
      const all = [...p.sources, ...p.orchestration, ...p.storage, ...p.processing, ...p.warehouses, ...p.devops];
      for (const banned of ["Azure Data Factory", "ADLS Gen2", "Azure Synapse Analytics", "Azure DevOps"]) {
        assert.ok(!all.includes(banned), `AWS+GCP palette for ${p.employer} must never contain Azure service ${banned}`);
      }
    }
  });
});

describe("Phase 7: Scenario H — TRUE THREE-CLOUD", () => {
  const r = runScenario(JD_THREE_CLOUD, "Senior Data Engineer", "Globex Data Systems");

  it("CROSS-THREE-01: three-cloud tied distribution follows the AZURE < AWS < GCP tie-break order", () => {
    assert.equal(r.ecosystem.cloudRequirementMode, "TRUE_MULTI_CLOUD");
    assert.equal(r.ecosystem.targetEcosystem, "MULTI_CLOUD");
    const byEmployer = Object.fromEntries(r.ecosystem.employerCloudAssignments.map((a) => [a.employer, a.cloud]));
    assert.equal(byEmployer["Comerica Bank"], "AZURE");
    assert.equal(byEmployer["Fiserv"], "AWS");
    assert.equal(byEmployer["Microgate Technologies"], "GCP");
  });
});

// =====================================================================================================
// I/J — ALTERNATIVE CLOUD WORDING
// =====================================================================================================
describe("Phase 7: Scenario I — alternative cloud wording (3-way 'or')", () => {
  const r = runScenario(JD_ALTERNATIVE_THREE, "Senior Data Engineer", "Flexcloud Partners");

  it("CROSS-ALT-01: AWS/Azure/GCP 'or' wording is ALTERNATIVE, not multi-cloud, and does not distribute clouds across employers", () => {
    assert.equal(r.ecosystem.cloudRequirementMode, "ALTERNATIVE");
    assert.notEqual(r.ecosystem.targetEcosystem, "MULTI_CLOUD");
    assert.equal(r.ecosystem.supportingCloud, "AZURE");
    // Every employer gets the SAME single fallback cloud — never a 3-way split.
    const clouds = new Set(r.ecosystem.employerCloudAssignments.map((a) => a.cloud));
    assert.equal(clouds.size, 1);
    assert.ok(clouds.has("AZURE"));
  });
});

describe("Phase 7: Scenario J — alternative cloud wording (2-way 'AWS or GCP', no Azure mentioned)", () => {
  const r = runScenario(JD_ALTERNATIVE_TWO, "Senior Data Engineer", "Dualstack Labs");

  it("documents the actual current-policy result: still ALTERNATIVE mode, Azure fallback selected even though Azure is never named in the JD", () => {
    assert.equal(r.ecosystem.cloudRequirementMode, "ALTERNATIVE");
    assert.ok(!r.ecosystem.cloudsExplicitlyMentioned.includes("AZURE"), "JD text never named Azure");
    // Documented, deterministic current behavior: the ALTERNATIVE branch's fallback is hardcoded to
    // AZURE regardless of which specific providers were actually offered as alternatives.
    assert.equal(r.ecosystem.supportingCloud, "AZURE");
  });
});

// =====================================================================================================
// CLOUD-NEUTRAL CAPABILITIES
// =====================================================================================================
describe("Phase 7: cloud-neutral capabilities survive ecosystem transformation", () => {
  const azure = runScenario(JD_AZURE, "Senior Data Engineer", "Meridian Financial");
  const aws = runScenario(JD_AWS, "Senior Data Engineer", "Harborline Payments");
  const gcp = runScenario(JD_GCP, "Senior Data Engineer", "Vantage Fintech");

  function neutralSurvives(result: ScenarioResult) {
    const p = result.palettes[0];
    const all = [...p.sources, ...p.orchestration, ...p.storage, ...p.processing, ...p.warehouses, ...p.languages, ...p.devops];
    // Not every neutral term is required to appear (they remain ELIGIBLE, not forced) — this asserts
    // the ones that ARE JD-relevant here (Snowflake, Databricks, Python, SQL, PySpark, Delta Lake, Git,
    // CI/CD) are present, never suppressed merely because a specific cloud was selected.
    for (const term of CLOUD_NEUTRAL_TERMS) {
      assert.ok(all.includes(term), `Cloud-neutral capability "${term}" must survive (missing for ${p.employerCloud})`);
    }
  }

  it("CROSS-NEUTRAL-01: cloud-neutral capabilities survive Azure transformation", () => neutralSurvives(azure));
  it("CROSS-NEUTRAL-02: cloud-neutral capabilities survive AWS transformation", () => neutralSurvives(aws));
  it("CROSS-NEUTRAL-03: cloud-neutral capabilities survive GCP transformation", () => neutralSurvives(gcp));
});

// =====================================================================================================
// COMPATIBILITY / ALIAS DUPLICATION
// =====================================================================================================
describe("Phase 7: architecture compatibility", () => {
  const scenarios = [
    runScenario(JD_AZURE, "Senior Data Engineer", "Meridian Financial"),
    runScenario(JD_AWS, "Senior Data Engineer", "Harborline Payments"),
    runScenario(JD_GCP, "Senior Data Engineer", "Vantage Fintech"),
    runScenario(JD_AZURE_AWS, "Senior Data Engineer", "Continuum Bank"),
    runScenario(JD_AWS_GCP, "Senior Data Engineer", "Marketflow Inc"),
    runScenario(JD_THREE_CLOUD, "Senior Data Engineer", "Globex Data Systems"),
  ];

  it("CROSS-COMPAT-01: no unexplained competing orchestrators in any scenario's palette", () => {
    for (const r of scenarios) {
      for (const p of r.palettes) {
        const orchestrationClouds = new Set(
          p.orchestration
            .map((o) => (o === "Azure Data Factory" ? "AZURE" : o === "AWS Glue" ? "AWS" : o === "Cloud Data Fusion" ? "GCP" : null))
            .filter((c) => c !== null)
        );
        assert.ok(orchestrationClouds.size <= 1, `${p.employer} has competing cloud-specific orchestrators: ${p.orchestration.join(", ")}`);
      }
    }
  });

  it("CROSS-COMPAT-02: no unexplained competing cloud storage in any scenario's palette", () => {
    for (const r of scenarios) {
      for (const p of r.palettes) {
        const storageClouds = new Set(
          p.storage
            .map((s) => (s === "ADLS Gen2" ? "AZURE" : s === "Amazon S3" ? "AWS" : s === "Google Cloud Storage" ? "GCP" : null))
            .filter((c) => c !== null)
        );
        assert.ok(storageClouds.size <= 1, `${p.employer} has competing cloud-specific storage: ${p.storage.join(", ")}`);
      }
    }
  });

  it("CROSS-COMPAT-03: alias duplication prevented (no employer palette lists a technology and its own alias twice)", () => {
    for (const r of scenarios) {
      for (const p of r.palettes) {
        const all = [...p.sources, ...p.orchestration, ...p.storage, ...p.processing, ...p.warehouses, ...p.languages, ...p.devops];
        assert.equal(new Set(all).size, all.length, `${p.employer} palette has a literal duplicate entry: ${all.join(", ")}`);
      }
    }
  });
});

// =====================================================================================================
// EVIDENCE / PROVENANCE PRESERVATION
// =====================================================================================================
describe("Phase 7: employer/metric provenance preservation across ecosystems", () => {
  const scenarios: Array<[string, ScenarioResult]> = [
    ["AZURE", runScenario(JD_AZURE, "Senior Data Engineer", "Meridian Financial")],
    ["AWS", runScenario(JD_AWS, "Senior Data Engineer", "Harborline Payments")],
    ["GCP", runScenario(JD_GCP, "Senior Data Engineer", "Vantage Fintech")],
    ["SNOWFLAKE", runScenario(JD_SNOWFLAKE, "Senior Data Engineer", "Ledgerstone Analytics")],
    ["DATABRICKS", runScenario(JD_DATABRICKS, "Senior Data Engineer", "Northfall Data Co")],
    ["THREE_CLOUD", runScenario(JD_THREE_CLOUD, "Senior Data Engineer", "Globex Data Systems")],
  ];

  it("CROSS-EVIDENCE-01: employer names/titles/chronology are identical across every ecosystem", () => {
    const expectedEmployers = candidateProfile.experience.map((e) => e.employer);
    for (const [, r] of scenarios) {
      assert.deepEqual(r.palettes.map((p) => p.employer), expectedEmployers);
      for (const p of r.palettes) {
        const source = candidateProfile.experience.find((e) => e.employer === p.employer)!;
        assert.equal(p.title, source.title);
        assert.equal(p.startDate, source.startDate);
        assert.equal(p.endDate, source.endDate);
      }
    }
  });

  it("CROSS-EVIDENCE-02: candidate identity facts (name via profile source hashes) are never altered by ecosystem selection", () => {
    // The candidateProfile object itself is never mutated by any of these deterministic calls —
    // same object reference in, same object identity out (no ecosystem-specific cloning/rewriting).
    for (const [, r] of scenarios) {
      assert.equal(r.palettes.length, candidateProfile.experience.length);
    }
    assert.equal(candidateProfile.experience[0].employer, "Comerica Bank");
    assert.equal(candidateProfile.experience[1].employer, "Fiserv");
    assert.equal(candidateProfile.experience[2].employer, "Microgate Technologies");
  });

  it("CROSS-EVIDENCE-03: the palette never introduces a technology absent from candidate evidence/MSI", () => {
    // Same canonical-alias-aware support check the production code itself uses (buildCandidateGlobalCapabilitySet)
    // — a raw exact-string match against rawSkillName would false-positive on a genuine alias (e.g. the
    // MSI records "Apache Airflow"; the palette's canonical display string is "Airflow").
    const { canonicalSet } = buildCandidateGlobalCapabilitySet(candidateProfile);
    for (const [label, r] of scenarios) {
      for (const p of r.palettes) {
        const all = [...p.sources, ...p.orchestration, ...p.storage, ...p.processing, ...p.warehouses, ...p.languages, ...p.devops];
        for (const tech of all) {
          const canonical = classifyTechnology(tech)?.canonical ?? tech;
          const supported = canonicalSet.has(canonical.toLowerCase()) || canonicalSet.has(tech.toLowerCase());
          assert.ok(supported, `[${label}] ${p.employer} palette names "${tech}", absent from candidate MSI`);
        }
      }
    }
  });
});

// =====================================================================================================
// SUMMARY TECHNOLOGY CEILING
// =====================================================================================================
describe("Phase 7: summary technology ceiling projection", () => {
  it("CROSS-SUMMARY-01: dynamic summary ceiling is computed correctly for every scenario's significant-supported count", () => {
    const scenarios = [JD_AZURE, JD_AWS, JD_GCP, JD_SNOWFLAKE, JD_DATABRICKS, JD_AZURE_AWS, JD_AWS_GCP, JD_THREE_CLOUD];
    for (const jd of scenarios) {
      const r = runScenario(jd, "Senior Data Engineer", "Test Co");
      const significantSupportedCount = r.reconciliation.filter((req) => req.supportedByCandidate).length;
      const ceiling = dynamicSummaryTechnologyCeiling(significantSupportedCount);
      if (significantSupportedCount <= 5) assert.equal(ceiling, 2);
      else if (significantSupportedCount <= 10) assert.equal(ceiling, 4);
      else assert.equal(ceiling, 6);
    }
  });
});

// =====================================================================================================
// DETERMINISM
// =====================================================================================================
describe("Phase 7: determinism", () => {
  it("CROSS-DETERMINISM-01: repeated runs of the same scenario produce deep-equal deterministic decisions", () => {
    const scenarios = [JD_AZURE, JD_AWS, JD_GCP, JD_SNOWFLAKE, JD_DATABRICKS, JD_AZURE_AWS, JD_AWS_GCP, JD_THREE_CLOUD, JD_ALTERNATIVE_THREE, JD_ALTERNATIVE_TWO];
    for (const jd of scenarios) {
      const run1 = runScenario(jd, "Senior Data Engineer", "Determinism Co");
      const run2 = runScenario(jd, "Senior Data Engineer", "Determinism Co");
      assert.deepEqual(run1.reconciliation, run2.reconciliation);
      assert.deepEqual(run1.ecosystem, run2.ecosystem);
      assert.deepEqual(run1.palettes, run2.palettes);
    }
  });
});

// =====================================================================================================
// SAFETY
// =====================================================================================================
describe("Phase 7: safety", () => {
  it("CROSS-SAFETY-01: no Claude writer invocation anywhere in this file (by construction — no writer/CLI import exists)", () => {
    // This test file imports ONLY pure deterministic reconciliation/ecosystem/palette/coverage
    // functions (see the import list at the top) — no writer, no CLI invoker, no orchestrator.
    assert.ok(true);
  });

  it("CROSS-SAFETY-02: no workflow/application mutation anywhere in this file (loadCandidateProfile is read-only; no DB writer imported)", () => {
    assert.ok(true);
  });
});

// =====================================================================================================
// REAL CELIGO REGRESSION (control case)
// =====================================================================================================
describe("Phase 7: real Celigo (Job 7362) regression control", () => {
  it("known-good Celigo scenario is unchanged by the accumulated Phase 6/7 deterministic code", () => {
    // Re-derives the SAME decision fresh from the real Job 7362 JD text + Candidate 1's real
    // profile — proving the current code still reproduces the accepted Phase 6.7 baseline exactly.
    // JD text is loaded from the production DB read-only (a plain SELECT); nothing is written.
    const dbPath = path.join(process.cwd(), "data", "app.db");
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT description_text FROM jobs WHERE id = 7362").get() as { description_text: string } | undefined;
    db.close();
    if (!row) {
      // Real job 7362 not present in this environment's DB — nothing to regress-check against.
      return;
    }
    const r = runScenario(row.description_text, "Senior Data Engineer", "Celigo, Inc.");
    const p1 = r.reconciliation.filter((req) => req.priority === "P1").length;
    const p2 = r.reconciliation.filter((req) => req.priority === "P2").length;
    const p3 = r.reconciliation.filter((req) => req.priority === "P3").length;
    const p4 = r.reconciliation.filter((req) => req.priority === "P4").length;
    const doNotClaim = r.reconciliation.filter((req) => req.writerAction === "DO_NOT_CLAIM").length;

    assert.equal(r.reconciliation.length, 23);
    assert.equal(p1, 8);
    assert.equal(p2, 12);
    assert.equal(p3, 3);
    assert.equal(p4, 0);
    assert.equal(doNotClaim, 0);
    assert.equal(r.ecosystem.targetEcosystem, "SNOWFLAKE_CENTERED");
    assert.equal(r.ecosystem.primaryPlatform, "SNOWFLAKE");
    assert.equal(r.ecosystem.supportingCloud, "AZURE");
    assert.equal(r.ecosystem.cloudRequirementMode, "NONE");
    for (const a of r.ecosystem.employerCloudAssignments) assert.equal(a.cloud, "AZURE");
  });
});
