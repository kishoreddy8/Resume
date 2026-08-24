import type { RequirementUnit } from "@/lib/match/types";

export interface JobIntentCapability {
  name: string;
  kind: "EXPLICIT_EMPLOYER_REQUIREMENT" | "DETERMINISTIC_DERIVED_CATEGORY";
  criticality: "CRITICAL" | "REQUIRED" | "PREFERRED" | "OPTIONAL";
  sourceEvidence?: string;
}

export interface WriterJobIntent {
  company: string;
  roleTitle: string;
  seniority: string;
  primaryMission: string;
  criticalCapabilities: JobIntentCapability[];
  requiredCapabilities: JobIntentCapability[];
  preferredCapabilities: JobIntentCapability[];
  coreResponsibilities: string[];
  architectureExpectations: string[];
  pipelineExpectations: string[];
  dataQualityExpectations: string[];
  governanceExpectations: string[];
}

/**
 * Deterministically extracts rich hiring intent from structured JD requirements and raw JD text.
 * Never uses an LLM. Distinguishes explicit employer requirements from derived categories.
 */
export function extractWriterJobIntent(params: {
  company: string;
  roleTitle: string;
  jobDescriptionText?: string;
  jobRequirements?: RequirementUnit[];
}): WriterJobIntent {
  const { company, roleTitle, jobDescriptionText, jobRequirements = [] } = params;

  const isSenior = /\b(senior|sr\.?|lead|principal|staff|architect)\b/i.test(roleTitle);
  const seniority = isSenior ? "Senior / Technical Lead" : "Mid-Level Professional";

  const criticalCaps: JobIntentCapability[] = [];
  const requiredCaps: JobIntentCapability[] = [];
  const preferredCaps: JobIntentCapability[] = [];

  for (const req of jobRequirements) {
    const name = req.label || req.memberSkillNames?.[0] || "Requirement";
    const snippet = req.evidenceSnippets?.[0];
    const isExplicit = (req.evidenceSnippets && req.evidenceSnippets.length > 0) || !req.fromUnclaimedText;

    const cap: JobIntentCapability = {
      name,
      kind: isExplicit ? "EXPLICIT_EMPLOYER_REQUIREMENT" : "DETERMINISTIC_DERIVED_CATEGORY",
      criticality: req.criticality,
      sourceEvidence: snippet,
    };

    if (req.criticality === "CRITICAL") {
      criticalCaps.push(cap);
    } else if (req.criticality === "REQUIRED" || req.requirementLevel === "Required") {
      requiredCaps.push(cap);
    } else {
      preferredCaps.push(cap);
    }
  }

  // Fallbacks if structured requirements array was empty
  if (criticalCaps.length === 0 && requiredCaps.length === 0) {
    const rawLower = (jobDescriptionText || "").toLowerCase();
    const explicitKnown = [
      { name: "Snowflake", test: /snowflake/ },
      { name: "Python", test: /python/ },
      { name: "SQL", test: /sql/ },
      { name: "Data Warehousing", test: /data warehouse|warehousing/ },
      { name: "ETL / ELT Pipelines", test: /etl|elt|pipeline/ },
      { name: "Cloud Platforms (Azure/AWS)", test: /azure|aws|cloud/ },
      { name: "Data Modeling", test: /data model|dimensional model|star schema/ },
      { name: "Data Quality & Governance", test: /data quality|governance/ }
    ];

    for (const item of explicitKnown) {
      if (item.test.test(rawLower)) {
        requiredCaps.push({
          name: item.name,
          kind: "EXPLICIT_EMPLOYER_REQUIREMENT",
          criticality: "REQUIRED",
          sourceEvidence: `Explicitly mentioned in ${company} job posting.`,
        });
      }
    }
  }

  const primaryMission = `Architect, scale, and maintain high-reliability cloud data engineering platforms and analytical data pipelines at ${company}, supporting business analytics and operational data integration.`;

  const coreResponsibilities = [
    `Design and build production ETL/ELT pipelines ingesting transactional and operational data feeds into governed cloud data platforms.`,
    `Implement optimized dimensional data models (star schema, snowflake schema) and consumption layers for high-performance reporting.`,
    `Enforce automated data quality, validation rules, and schema consistency across batch and streaming ingestion workflows.`,
    `Collaborate with cross-functional data stakeholders and engineering teams to establish automated CI/CD and monitoring.`
  ];

  const architectureExpectations = [
    "Medallion architecture (raw/curated/consumption zones) or modern cloud data warehouse patterns.",
    "Decoupled storage and compute with automated lifecycle governance."
  ];

  const pipelineExpectations = [
    "Incremental loading, CDC (Change Data Capture), and robust error handling.",
    "Orchestrated batch and near-real-time ingestion workflows with minimal manual intervention."
  ];

  const dataQualityExpectations = [
    "Automated data reconciliation, completeness checks, and schema validation before loading analytical tables."
  ];

  const governanceExpectations = [
    "Centralized secret management, RBAC access control, and metadata/lineage traceability."
  ];

  return {
    company,
    roleTitle,
    seniority,
    primaryMission,
    criticalCapabilities: criticalCaps,
    requiredCapabilities: requiredCaps,
    preferredCapabilities: preferredCaps,
    coreResponsibilities,
    architectureExpectations,
    pipelineExpectations,
    dataQualityExpectations,
    governanceExpectations,
  };
}

/**
 * Formats structured JD intent into a compact markdown section for the writer.
 */
export function renderWriterJobIntentSection(intent: WriterJobIntent): string {
  const lines: string[] = [
    "## STRUCTURED JOB INTENT & HIRING PRIORITIES",
    "",
    `**Target Role**: ${intent.roleTitle} at **${intent.company}** (${intent.seniority})`,
    `**Primary Hiring Mission**: ${intent.primaryMission}`,
    "",
    "### Core Capabilities Demanded by Employer:",
  ];

  if (intent.criticalCapabilities.length > 0) {
    lines.push("- **Critical (P1)**: " + intent.criticalCapabilities.map((c) => `${c.name} [${c.kind === "EXPLICIT_EMPLOYER_REQUIREMENT" ? "Explicit" : "Derived"}]`).join(", "));
  }
  if (intent.requiredCapabilities.length > 0) {
    lines.push("- **Required (P2)**: " + intent.requiredCapabilities.map((c) => `${c.name} [${c.kind === "EXPLICIT_EMPLOYER_REQUIREMENT" ? "Explicit" : "Derived"}]`).join(", "));
  }
  if (intent.preferredCapabilities.length > 0) {
    lines.push("- **Preferred (P3)**: " + intent.preferredCapabilities.slice(0, 8).map((c) => `${c.name}`).join(", "));
  }

  lines.push("");
  lines.push("### Architectural & Delivery Expectations:");
  for (const exp of intent.architectureExpectations) {
    lines.push(`- ${exp}`);
  }
  for (const pipe of intent.pipelineExpectations) {
    lines.push(`- ${pipe}`);
  }

  return lines.join("\n");
}
