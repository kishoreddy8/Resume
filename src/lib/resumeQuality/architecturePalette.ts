import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
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
  employerCloud: "AZURE" | "AWS" | "GCP";
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
 *
 * PALETTE NARROWING PRINCIPLE:
 * The palette is a narrow, coherent JD-targeted stack (typically 1 primary orchestrator,
 * 1 primary storage, 1-2 processing, 1 primary warehouse, 1-3 languages/devops),
 * NOT a dump of the entire Global MSI.
 */
export function buildEmployerArchitecturePalettes(params: {
  candidateProfile: CandidateProfile;
  targetEcosystem: TargetEcosystemResult;
  coveragePlan: JdToolCoveragePlan;
  jobRequirements?: RequirementUnit[];
  /** PHASE 6.3A — when the caller already ran canonical JD reconciliation, its own
   *  writerAction === "DO_NOT_CLAIM" names (see jdRequirementReconciler.ts's
   *  getReconciledUnsupportedNames) are the authoritative unsupported list — coveragePlan's own
   *  allUnsupportedTools can disagree for a capability/architecture requirement name it does not
   *  recognize (see canonicalRequirementsToRequirementUnits's doc comment). Falls back to
   *  coveragePlan.allUnsupportedTools, unchanged, whenever this is omitted. */
  authoritativeUnsupportedTools?: string[];
}): EmployerArchitecturePalette[] {
  const { candidateProfile, targetEcosystem, coveragePlan, jobRequirements = [] } = params;
  const unsupportedTools = params.authoritativeUnsupportedTools ?? coveragePlan.allUnsupportedTools;
  const { canonicalSet } = buildCandidateGlobalCapabilitySet(candidateProfile);

  const hasSkill = (tech: string) => {
    const entry = classifyTechnology(tech);
    const key = (entry?.canonical ?? tech).toLowerCase();
    return canonicalSet.has(key) || canonicalSet.has(tech.toLowerCase());
  };

  const isJdSkill = (tech: string) => {
    const entry = classifyTechnology(tech);
    const canon = (entry?.canonical ?? tech).toLowerCase();
    return jobRequirements.some((r) => {
      const rName = (r.label || "").toLowerCase();
      const rMembers = (r.memberSkillNames || []).map((m) => m.toLowerCase());
      return rName === canon || rName.includes(canon) || rMembers.includes(canon);
    });
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
        employerCloud: "AZURE",
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

    // Determine assigned cloud for this specific employer
    const assignment = targetEcosystem.employerCloudAssignments?.find((a) => a.employer === exp.employer);
    let employerCloud: "AZURE" | "AWS" | "GCP" = assignment?.cloud ?? "AZURE";
    if (!assignment) {
      if (targetEcosystem.supportingCloud === "AWS" || targetEcosystem.primaryCloud === "AWS" || targetEcosystem.targetEcosystem === "AWS") {
        employerCloud = "AWS";
      } else if (targetEcosystem.supportingCloud === "GCP" || targetEcosystem.primaryCloud === "GCP" || targetEcosystem.targetEcosystem === "GCP") {
        employerCloud = "GCP";
      } else {
        employerCloud = "AZURE";
      }
    }

    // 1. Sources (Target 1-3 coherent sources)
    const sources: string[] = [];
    if (hasSkill("SQL Server")) sources.push("SQL Server");
    if (sources.length < 2 && hasSkill("PostgreSQL")) sources.push("PostgreSQL");
    if (sources.length < 2 && hasSkill("Oracle")) sources.push("Oracle");
    if (hasSkill("Kafka") && (isJdSkill("Kafka") || hasSkill("Kafka"))) sources.push("Kafka");
    if (hasSkill("REST APIs") && sources.length < 3) sources.push("REST APIs");
    const narrowSources = sources.slice(0, 3);

    // 2. Orchestration & Ingestion (Target normally 1 primary, max 2 if dbt/Airflow relevant)
    const orchestration: string[] = [];
    if (employerCloud === "AWS") {
      if (hasSkill("AWS Glue")) {
        orchestration.push("AWS Glue");
      } else if (hasSkill("Airflow")) {
        orchestration.push("Airflow");
      }
      if (hasSkill("dbt") && (isJdSkill("dbt") || orchestration.length === 0)) orchestration.push("dbt");
    } else if (employerCloud === "AZURE") {
      if (hasSkill("Azure Data Factory")) {
        orchestration.push("Azure Data Factory");
      } else if (hasSkill("Airflow")) {
        orchestration.push("Airflow");
      }
      if (hasSkill("dbt") && (isJdSkill("dbt") || orchestration.length === 0)) orchestration.push("dbt");
    } else if (employerCloud === "GCP") {
      if (hasSkill("Cloud Data Fusion")) {
        orchestration.push("Cloud Data Fusion");
      } else if (hasSkill("Airflow")) {
        orchestration.push("Airflow");
      }
      if (hasSkill("dbt") && (isJdSkill("dbt") || orchestration.length === 0)) orchestration.push("dbt");
    }

    // 3. Storage Layer (Target 1 primary object store + optionally Delta Lake)
    const storage: string[] = [];
    if (employerCloud === "AWS") {
      if (hasSkill("Amazon S3")) storage.push("Amazon S3");
    } else if (employerCloud === "AZURE") {
      if (hasSkill("ADLS Gen2")) storage.push("ADLS Gen2");
    } else if (employerCloud === "GCP") {
      if (hasSkill("Google Cloud Storage")) storage.push("Google Cloud Storage");
    }
    if (hasSkill("Delta Lake")) storage.push("Delta Lake");

    // 4. Processing Engine (Target 1-2 compatible technologies)
    const processing: string[] = [];
    if (hasSkill("Databricks")) processing.push("Databricks");
    if (hasSkill("PySpark")) processing.push("PySpark");
    else if (hasSkill("Apache Spark")) processing.push("Apache Spark");

    // 5. Warehouses & Analytics Engines (Target normally 1 primary, max 2 if justified)
    const warehouses: string[] = [];
    if (hasSkill("Snowflake")) warehouses.push("Snowflake");
    if (employerCloud === "AWS" && hasSkill("Amazon Redshift")) warehouses.push("Amazon Redshift");
    else if (employerCloud === "AZURE" && hasSkill("Azure Synapse Analytics")) warehouses.push("Azure Synapse Analytics");
    else if (employerCloud === "GCP" && hasSkill("BigQuery")) warehouses.push("BigQuery");

    // 6. Languages (Target 1-3)
    const languages: string[] = [];
    if (hasSkill("Python")) languages.push("Python");
    if (hasSkill("SQL")) languages.push("SQL");
    if (hasSkill("Scala") && isJdSkill("Scala")) languages.push("Scala");

    // 7. DevOps & CI/CD (Target 1-3)
    const devops: string[] = [];
    if (hasSkill("Git")) devops.push("Git");
    if (hasSkill("CI/CD")) devops.push("CI/CD");
    if (hasSkill("Terraform")) devops.push("Terraform");
    else if (employerCloud === "AZURE" && hasSkill("Azure DevOps")) devops.push("Azure DevOps");
    else if (hasSkill("GitHub Actions")) devops.push("GitHub Actions");

    // 8. Prohibited Combinations for this employer
    const prohibitedCombinations: string[] = [];
    if (employerCloud === "AWS") {
      prohibitedCombinations.push("Azure Data Factory + AWS Glue in same un-migrated pipeline");
      prohibitedCombinations.push("ADLS Gen2 + Amazon S3 as duplicate storage in same pipeline");
      prohibitedCombinations.push("Azure Synapse Analytics + Amazon Redshift as competing primary warehouses");
    } else if (employerCloud === "AZURE") {
      prohibitedCombinations.push("AWS Glue + Azure Data Factory in same un-migrated pipeline");
      prohibitedCombinations.push("Amazon Redshift + Synapse as competing primary warehouses");
      prohibitedCombinations.push("Amazon S3 + ADLS Gen2 in same un-migrated pipeline");
    } else if (employerCloud === "GCP") {
      prohibitedCombinations.push("ADF + Cloud Data Fusion in same un-migrated pipeline");
      prohibitedCombinations.push("Synapse + BigQuery as competing primary warehouses");
      prohibitedCombinations.push("AWS Glue + Cloud Data Fusion in same un-migrated pipeline");
    }

    if (unsupportedTools.length > 0) {
      prohibitedCombinations.push(`Unsupported JD tools: ${unsupportedTools.join(", ")}`);
    }

    palettes.push({
      employer: exp.employer,
      title: exp.title,
      startDate: exp.startDate ?? null,
      endDate: exp.endDate ?? null,
      targetEcosystem: targetEcosystem.targetEcosystem,
      employerCloud,
      sources: narrowSources,
      orchestration: [...new Set(orchestration)],
      storage: [...new Set(storage)],
      processing: [...new Set(processing)],
      warehouses: [...new Set(warehouses)],
      languages: [...new Set(languages)],
      devops: [...new Set(devops)],
      prohibitedCombinations,
      accomplishmentContext: `Enterprise data engineering and pipeline modernization at ${exp.employer} using ${employerCloud} ecosystem.`,
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
    out += `### ${pal.employer} (${pal.title}) [Cloud: ${pal.employerCloud}]\n`;
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
