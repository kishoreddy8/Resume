import type { CandidateProfile } from "@/lib/match/types";
import { type TargetEcosystemResult, type TargetEcosystem } from "./targetEcosystem";
import { type JdToolCoveragePlan, buildCandidateGlobalCapabilitySet } from "./jdToolCoverage";
import { classifyTechnology } from "./technologyClassification";
import { roleAcceptsInventoryEvidence } from "./msiEvidence";

export interface EmployerArchitecturePalette {
  employer: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  targetEcosystem: TargetEcosystem;
  sources: string[];
  orchestration: string[];
  storage: string[];
  processing: string[];
  warehouses: string[];
  languages: string[];
  devops: string[];
  prohibitedCombinations: string[];
  accomplishmentContext: string;
}

/**
 * Builds employer-specific approved architecture palettes based on:
 * Immutable facts + Accomplishment Intent + Global MSI + Target Ecosystem + Technology Compatibility.
 */
export function buildEmployerArchitecturePalettes(params: {
  candidateProfile: CandidateProfile;
  targetEcosystem: TargetEcosystemResult;
  coveragePlan: JdToolCoveragePlan;
}): EmployerArchitecturePalette[] {
  const { candidateProfile, targetEcosystem, coveragePlan } = params;
  const { canonicalSet } = buildCandidateGlobalCapabilitySet(candidateProfile);
  const targetCloud = targetEcosystem.primaryCloud;

  const hasSkill = (tech: string) => {
    const entry = classifyTechnology(tech);
    const key = (entry?.canonical ?? tech).toLowerCase();
    return canonicalSet.has(key) || canonicalSet.has(tech.toLowerCase());
  };

  const palettes: EmployerArchitecturePalette[] = [];

  for (const exp of candidateProfile.experience ?? []) {
    const isTechRole = roleAcceptsInventoryEvidence(candidateProfile, exp.employer);

    // If role is outside technical domain, keep strictly recorded tools
    if (!isTechRole) {
      palettes.push({
        employer: exp.employer,
        title: exp.title,
        startDate: exp.startDate ?? null,
        endDate: exp.endDate ?? null,
        targetEcosystem: "CLOUD_NEUTRAL",
        sources: [],
        orchestration: [],
        storage: [],
        processing: [],
        warehouses: [],
        languages: [],
        devops: [],
        prohibitedCombinations: ["All cloud data engineering tools (role outside technical domain)"],
        accomplishmentContext: "Non-technical or legacy domain experience; present with original facts only.",
      });
      continue;
    }

    // 1. Sources (Relational, Operational, Message queues)
    const sources: string[] = [];
    if (hasSkill("SQL Server")) sources.push("SQL Server");
    if (hasSkill("PostgreSQL")) sources.push("PostgreSQL");
    if (hasSkill("MySQL")) sources.push("MySQL");
    if (hasSkill("Oracle")) sources.push("Oracle");
    if (hasSkill("Kafka")) sources.push("Kafka");
    if (hasSkill("REST APIs") || hasSkill("APIs")) sources.push("REST APIs");

    // 2. Orchestration & Ingestion
    const orchestration: string[] = [];
    if (targetCloud === "AWS") {
      if (hasSkill("AWS Glue")) orchestration.push("AWS Glue");
      if (hasSkill("Airflow")) orchestration.push("Airflow");
      if (hasSkill("AWS Step Functions")) orchestration.push("AWS Step Functions");
      if (hasSkill("dbt")) orchestration.push("dbt");
    } else if (targetCloud === "AZURE") {
      if (hasSkill("Azure Data Factory")) orchestration.push("Azure Data Factory");
      if (hasSkill("Airflow")) orchestration.push("Airflow");
      if (hasSkill("dbt")) orchestration.push("dbt");
    } else if (targetCloud === "GCP") {
      if (hasSkill("Cloud Data Fusion")) orchestration.push("Cloud Data Fusion");
      if (hasSkill("Cloud Composer") || hasSkill("Airflow")) orchestration.push("Airflow");
      if (hasSkill("dbt")) orchestration.push("dbt");
    } else {
      // Cloud-Neutral / Multi-Cloud
      if (hasSkill("Airflow")) orchestration.push("Airflow");
      if (hasSkill("dbt")) orchestration.push("dbt");
      if (hasSkill("Azure Data Factory")) orchestration.push("Azure Data Factory");
      if (hasSkill("AWS Glue")) orchestration.push("AWS Glue");
    }

    // 3. Storage Layer
    const storage: string[] = [];
    if (targetCloud === "AWS") {
      if (hasSkill("Amazon S3")) storage.push("Amazon S3");
    } else if (targetCloud === "AZURE") {
      if (hasSkill("ADLS Gen2")) storage.push("ADLS Gen2");
    } else if (targetCloud === "GCP") {
      if (hasSkill("Google Cloud Storage")) storage.push("Google Cloud Storage");
    } else {
      if (hasSkill("Amazon S3")) storage.push("Amazon S3");
      if (hasSkill("ADLS Gen2")) storage.push("ADLS Gen2");
    }
    if (hasSkill("Delta Lake")) storage.push("Delta Lake");

    // 4. Processing Engine
    const processing: string[] = [];
    if (hasSkill("Databricks")) processing.push("Databricks");
    if (hasSkill("PySpark")) processing.push("PySpark");
    if (hasSkill("Apache Spark") || hasSkill("Spark")) processing.push("Apache Spark");
    if (targetCloud === "AWS" && hasSkill("EMR")) processing.push("EMR");
    if (targetCloud === "AZURE" && hasSkill("Synapse Spark")) processing.push("Synapse Spark");
    if (targetCloud === "GCP" && (hasSkill("Dataproc") || hasSkill("Dataflow"))) processing.push("Dataproc");

    // 5. Warehouses & Analytics Engines
    const warehouses: string[] = [];
    if (hasSkill("Snowflake")) warehouses.push("Snowflake");
    if (targetCloud === "AWS") {
      if (hasSkill("Amazon Redshift")) warehouses.push("Amazon Redshift");
      if (hasSkill("Amazon Athena")) warehouses.push("Amazon Athena");
    } else if (targetCloud === "AZURE") {
      if (hasSkill("Azure Synapse Analytics")) warehouses.push("Azure Synapse Analytics");
    } else if (targetCloud === "GCP") {
      if (hasSkill("BigQuery")) warehouses.push("BigQuery");
    } else {
      if (hasSkill("Azure Synapse Analytics")) warehouses.push("Azure Synapse Analytics");
      if (hasSkill("Amazon Redshift")) warehouses.push("Amazon Redshift");
    }

    // 6. Languages
    const languages: string[] = [];
    if (hasSkill("Python")) languages.push("Python");
    if (hasSkill("SQL")) languages.push("SQL");
    if (hasSkill("Scala")) languages.push("Scala");

    // 7. DevOps & CI/CD
    const devops: string[] = [];
    if (hasSkill("Git")) devops.push("Git");
    if (hasSkill("CI/CD")) devops.push("CI/CD");
    if (hasSkill("Terraform")) devops.push("Terraform");
    if (hasSkill("Docker")) devops.push("Docker");
    if (targetCloud === "AZURE" && hasSkill("Azure DevOps")) devops.push("Azure DevOps");
    if (hasSkill("GitHub Actions")) devops.push("GitHub Actions");

    // 8. Prohibited Combinations for this employer
    const prohibitedCombinations: string[] = [];
    if (targetCloud === "AWS") {
      prohibitedCombinations.push("Azure Data Factory + AWS Glue in same un-migrated pipeline");
      prohibitedCombinations.push("ADLS Gen2 + Amazon S3 as duplicate storage in same pipeline");
      prohibitedCombinations.push("Azure Synapse Analytics + Amazon Redshift as competing primary warehouses");
    } else if (targetCloud === "AZURE") {
      prohibitedCombinations.push("AWS Glue + Azure Data Factory in same un-migrated pipeline");
      prohibitedCombinations.push("Amazon Redshift + Synapse as competing primary warehouses");
    } else if (targetCloud === "GCP") {
      prohibitedCombinations.push("ADF + Cloud Data Fusion in same un-migrated pipeline");
      prohibitedCombinations.push("Synapse + BigQuery as competing primary warehouses");
    }

    // Add any unsupported tools explicitly
    if (coveragePlan.allUnsupportedTools.length > 0) {
      prohibitedCombinations.push(`Unsupported JD tools: ${coveragePlan.allUnsupportedTools.join(", ")}`);
    }

    palettes.push({
      employer: exp.employer,
      title: exp.title,
      startDate: exp.startDate ?? null,
      endDate: exp.endDate ?? null,
      targetEcosystem: targetEcosystem.targetEcosystem,
      sources: [...new Set(sources)],
      orchestration: [...new Set(orchestration)],
      storage: [...new Set(storage)],
      processing: [...new Set(processing)],
      warehouses: [...new Set(warehouses)],
      languages: [...new Set(languages)],
      devops: [...new Set(devops)],
      prohibitedCombinations,
      accomplishmentContext: `Enterprise data engineering and pipeline modernization at ${exp.employer}.`,
    });
  }

  return palettes;
}

/**
 * Renders approved architecture palettes into compact prompt text.
 */
export function renderArchitecturePaletteSection(palettes: EmployerArchitecturePalette[]): string {
  let out = `## APPROVED EMPLOYER ARCHITECTURE PALETTES (Target-Aligned + MSI-Backed)\n\n`;

  for (const pal of palettes) {
    out += `### ${pal.employer} (${pal.title})\n`;
    if (pal.orchestration.length === 0 && pal.processing.length === 0 && pal.warehouses.length === 0) {
      out += `- **Context:** ${pal.accomplishmentContext}\n\n`;
      continue;
    }

    out += `- **Approved Sources:** ${pal.sources.join(", ") || "(none)"}\n`;
    out += `- **Approved Ingestion/Orchestration:** ${pal.orchestration.join(", ") || "(none)"}\n`;
    out += `- **Approved Storage:** ${pal.storage.join(", ") || "(none)"}\n`;
    out += `- **Approved Processing/Transform:** ${pal.processing.join(", ") || "(none)"}\n`;
    out += `- **Approved Warehouses/Analytics:** ${pal.warehouses.join(", ") || "(none)"}\n`;
    out += `- **Approved Languages & DevOps:** ${[...pal.languages, ...pal.devops].join(", ") || "(none)"}\n`;
    if (pal.prohibitedCombinations.length > 0) {
      out += `- **Prohibited Stacks:** ${pal.prohibitedCombinations.join("; ")}\n`;
    }
    out += "\n";
  }

  return out;
}
