import type { CandidateProfile, RequirementUnit, RequirementCriticality } from "@/lib/match/types";
import type { RequirementLevel } from "@/types";
import { buildCandidateGlobalCapabilitySet } from "./jdToolCoverage";

export type CanonicalRequirementKind =
  | "TECHNOLOGY"
  | "CAPABILITY"
  | "ARCHITECTURE"
  | "METHODOLOGY"
  | "PLATFORM"
  | "LANGUAGE"
  | "DEVOPS";

export type CanonicalRequirementPriority = "P1" | "P2" | "P3" | "P4";
export type CanonicalRequirementCriticality = "CRITICAL" | "REQUIRED" | "PREFERRED" | "BONUS";
export type RequirementSource = "STRUCTURED" | "RAW_JD_RECONCILIATION" | "BOTH";
export type WriterCoverageExpectation = "MUST_SURFACE" | "SHOULD_SURFACE" | "OPTIONAL";

export interface CanonicalJdRequirement {
  id: string;
  canonicalName: string;
  kind: CanonicalRequirementKind;
  rawText: string;
  priority: CanonicalRequirementPriority;
  criticality: CanonicalRequirementCriticality;
  source: RequirementSource;
  evidenceSpans: string[];
  aliasesMatched: string[];
  supportedByCandidate: boolean;
  candidateEvidenceSources: string[];
  writerAction: "PASS_TO_WRITER" | "DO_NOT_CLAIM";
  coverageExpectation: WriterCoverageExpectation;
  gatedReason?: string;
}

export interface JdExtractionFinding {
  type: "JD_EXTRACTION_GAP_RECOVERED" | "JD_EXTRACTION_GAP_UNRESOLVED";
  requirement: string;
  priority: CanonicalRequirementPriority;
  sourceSnippet: string;
  actionTaken: string;
}

export interface JdIntelligenceCompleteness {
  isComplete: boolean;
  totalMaterialRequirements: number;
  technologyRequirementsCount: number;
  capabilityRequirementsCount: number;
  architectureRequirementsCount: number;
  structuredCount: number;
  recoveredCount: number;
  unresolvedCount: number;
  p1Count: number;
  p2Count: number;
  p3Count: number;
  p4Count: number;
  supportedMaterialCount: number;
  supportedP1Count: number;
  supportedP2Count: number;
  supportedP3Count: number;
  supportedP4Count: number;
  doNotClaimCount: number;
  unresolvedCritical: string[];
  unresolvedRequired: string[];
  findings: JdExtractionFinding[];
}

export interface JdReconciliationResult {
  canonicalRequirements: CanonicalJdRequirement[];
  completeness: JdIntelligenceCompleteness;
}

interface TaxonomyDefinition {
  canonicalName: string;
  kind: CanonicalRequirementKind;
  aliases: string[];
  msiMatchKeys: string[];
}

const TECHNICAL_TAXONOMY: TaxonomyDefinition[] = [
  // Platforms & Warehouses
  {
    canonicalName: "Snowflake",
    kind: "PLATFORM",
    aliases: ["snowflake", "snowflake architecture", "snowflake virtual warehouse", "snowflake data cloud"],
    msiMatchKeys: ["snowflake"],
  },
  {
    canonicalName: "Databricks",
    kind: "PLATFORM",
    aliases: ["databricks", "azure databricks", "databricks lakehouse"],
    msiMatchKeys: ["databricks"],
  },
  {
    canonicalName: "Azure Synapse Analytics",
    kind: "TECHNOLOGY",
    aliases: ["azure synapse", "synapse", "azure synapse analytics", "synapse analytics"],
    msiMatchKeys: ["azure synapse analytics", "synapse", "azure synapse"],
  },
  {
    canonicalName: "Amazon Redshift",
    kind: "TECHNOLOGY",
    aliases: ["amazon redshift", "redshift"],
    msiMatchKeys: ["amazon redshift", "redshift"],
  },
  {
    canonicalName: "Google BigQuery",
    kind: "TECHNOLOGY",
    aliases: ["bigquery", "google bigquery", "gcp bigquery"],
    msiMatchKeys: ["bigquery", "google bigquery"],
  },
  {
    canonicalName: "SQL Server",
    kind: "TECHNOLOGY",
    aliases: ["sql server", "ms sql", "mssql"],
    msiMatchKeys: ["sql server", "ms sql server"],
  },
  {
    canonicalName: "PostgreSQL",
    kind: "TECHNOLOGY",
    aliases: ["postgresql", "postgres"],
    msiMatchKeys: ["postgresql", "postgres"],
  },
  {
    canonicalName: "Oracle",
    kind: "TECHNOLOGY",
    aliases: ["oracle", "oracle db", "oracle database"],
    msiMatchKeys: ["oracle"],
  },

  // Ingestion, ETL & Orchestration
  {
    canonicalName: "dbt",
    kind: "TECHNOLOGY",
    aliases: ["dbt", "data build tool", "dbt core", "dbt cloud"],
    msiMatchKeys: ["dbt", "data build tool"],
  },
  {
    canonicalName: "Fivetran",
    kind: "TECHNOLOGY",
    aliases: ["fivetran"],
    msiMatchKeys: ["fivetran"],
  },
  {
    canonicalName: "Airflow",
    kind: "TECHNOLOGY",
    aliases: ["airflow", "apache airflow", "mwaa"],
    msiMatchKeys: ["airflow", "apache airflow"],
  },
  {
    canonicalName: "Prefect",
    kind: "TECHNOLOGY",
    aliases: ["prefect"],
    msiMatchKeys: ["prefect"],
  },
  {
    canonicalName: "Azure Data Factory",
    kind: "TECHNOLOGY",
    aliases: ["azure data factory", "adf"],
    msiMatchKeys: ["azure data factory", "adf"],
  },
  {
    canonicalName: "AWS Glue",
    kind: "TECHNOLOGY",
    aliases: ["aws glue", "glue"],
    msiMatchKeys: ["aws glue", "glue"],
  },
  {
    canonicalName: "Cloud Data Fusion",
    kind: "TECHNOLOGY",
    aliases: ["cloud data fusion", "data fusion"],
    msiMatchKeys: ["cloud data fusion", "data fusion"],
  },
  {
    canonicalName: "Informatica",
    kind: "TECHNOLOGY",
    aliases: ["informatica", "informatica powercenter", "iics"],
    msiMatchKeys: ["informatica"],
  },
  {
    canonicalName: "Kafka",
    kind: "TECHNOLOGY",
    aliases: ["kafka", "apache kafka", "confluent kafka"],
    msiMatchKeys: ["kafka", "apache kafka"],
  },

  // Storage Layers
  {
    canonicalName: "ADLS Gen2",
    kind: "TECHNOLOGY",
    aliases: ["adls gen2", "adls", "azure data lake storage", "azure data lake"],
    msiMatchKeys: ["adls gen2", "adls", "azure data lake storage"],
  },
  {
    canonicalName: "Amazon S3",
    kind: "TECHNOLOGY",
    aliases: ["amazon s3", "s3", "aws s3"],
    msiMatchKeys: ["amazon s3", "s3"],
  },
  {
    canonicalName: "Google Cloud Storage",
    kind: "TECHNOLOGY",
    aliases: ["google cloud storage", "gcs"],
    msiMatchKeys: ["google cloud storage", "gcs"],
  },
  {
    canonicalName: "Delta Lake",
    kind: "TECHNOLOGY",
    aliases: ["delta lake", "delta tables", "delta format"],
    msiMatchKeys: ["delta lake"],
  },

  // Languages & Processing
  {
    canonicalName: "Python",
    kind: "LANGUAGE",
    aliases: ["python", "python3"],
    msiMatchKeys: ["python"],
  },
  {
    canonicalName: "SQL",
    kind: "LANGUAGE",
    aliases: ["sql", "advanced sql", "t-sql", "pl/sql"],
    msiMatchKeys: ["sql", "t-sql", "pl/sql"],
  },
  {
    canonicalName: "PySpark",
    kind: "LANGUAGE",
    aliases: ["pyspark"],
    msiMatchKeys: ["pyspark", "spark"],
  },
  {
    canonicalName: "Apache Spark",
    kind: "TECHNOLOGY",
    aliases: ["apache spark", "spark"],
    msiMatchKeys: ["apache spark", "spark", "pyspark"],
  },
  {
    canonicalName: "Scala",
    kind: "LANGUAGE",
    aliases: ["scala"],
    msiMatchKeys: ["scala"],
  },
  {
    canonicalName: "Java",
    kind: "LANGUAGE",
    aliases: ["java"],
    msiMatchKeys: ["java"],
  },

  // DevOps & CI/CD
  {
    canonicalName: "Git",
    kind: "DEVOPS",
    aliases: ["git", "version control", "version-controlled", "github", "gitlab"],
    msiMatchKeys: ["git", "github"],
  },
  {
    canonicalName: "CI/CD",
    kind: "DEVOPS",
    aliases: ["ci/cd", "ci/cd-driven", "continuous integration", "continuous deployment", "ci-cd", "ci-cd-driven", "pipeline automation"],
    msiMatchKeys: ["ci/cd", "ci/cd pipelines", "git"],
  },
  {
    canonicalName: "GitHub Actions",
    kind: "DEVOPS",
    aliases: ["github actions"],
    msiMatchKeys: ["github actions", "ci/cd", "git"],
  },
  {
    canonicalName: "Terraform",
    kind: "DEVOPS",
    aliases: ["terraform", "iac", "infrastructure as code"],
    msiMatchKeys: ["terraform", "iac"],
  },
  {
    canonicalName: "Docker",
    kind: "DEVOPS",
    aliases: ["docker", "containers", "containerization"],
    msiMatchKeys: ["docker"],
  },
  {
    canonicalName: "Kubernetes",
    kind: "DEVOPS",
    aliases: ["kubernetes", "k8s", "aks", "eks", "gke"],
    msiMatchKeys: ["kubernetes", "k8s"],
  },

  // Engineering Capabilities & Architectures
  {
    canonicalName: "Dimensional Modeling",
    kind: "ARCHITECTURE",
    aliases: [
      "dimensional modeling",
      "dimensional data modeling",
      "dimensional models",
      "dimensional data models",
      "dimensional",
      "star schema",
      "snowflake schema",
      "fact and dimension",
      "facts and dimensions",
    ],
    msiMatchKeys: ["dimensional modeling", "data modeling", "data warehouse"],
  },
  {
    canonicalName: "Data Vault",
    kind: "ARCHITECTURE",
    aliases: ["data vault", "data vault 2.0", "hubs links and satellites"],
    msiMatchKeys: ["data vault", "data vault 2.0"],
  },
  {
    canonicalName: "Medallion Architecture",
    kind: "ARCHITECTURE",
    aliases: ["medallion architecture", "medallion pattern", "medallion/lakehouse", "medallion", "bronze silver gold", "bronze/silver/gold"],
    msiMatchKeys: ["medallion architecture", "delta lake", "databricks"],
  },
  {
    canonicalName: "Lakehouse Architecture",
    kind: "ARCHITECTURE",
    aliases: ["lakehouse architecture", "lakehouse patterns", "data lakehouse", "lakehouse"],
    msiMatchKeys: ["lakehouse", "databricks", "delta lake"],
  },
  {
    canonicalName: "Data Quality & Validations",
    kind: "CAPABILITY",
    aliases: ["data quality standards", "data quality", "automated validations", "automated data validation", "data validation", "data contracts"],
    msiMatchKeys: ["data validation & quality", "data quality", "data validation"],
  },
  {
    canonicalName: "Observability",
    kind: "CAPABILITY",
    aliases: ["observability frameworks", "observability", "pipeline monitoring", "data observability", "pipeline alerting"],
    msiMatchKeys: ["observability", "monitoring", "data validation & quality"],
  },
  {
    canonicalName: "Data Governance",
    kind: "CAPABILITY",
    aliases: ["data governance practices", "data governance", "role-based access control", "rbac", "column-level security", "dynamic data masking", "audit logging", "compliance standards"],
    msiMatchKeys: ["data governance", "microsoft purview", "access control", "rbac"],
  },
  {
    canonicalName: "Data Lineage",
    kind: "CAPABILITY",
    aliases: ["data lineage", "end-to-end lineage", "lineage tracking", "lineage"],
    msiMatchKeys: ["data lineage", "microsoft purview", "data governance"],
  },
  {
    canonicalName: "Access Control & Security",
    kind: "CAPABILITY",
    aliases: ["access control", "role-based access control", "rbac", "column-level security", "dynamic data masking", "security and compliance"],
    msiMatchKeys: ["access control", "data governance", "rbac"],
  },
  {
    canonicalName: "Cost & Performance Optimization",
    kind: "CAPABILITY",
    aliases: ["optimize pipeline performance", "cost efficiency", "performance tuning", "cost governance", "compute cost efficiency", "query optimization", "performance optimization", "reduce costs"],
    msiMatchKeys: ["performance tuning", "query optimization", "cost optimization"],
  },
  {
    canonicalName: "Warehouse Migration & Rebuild",
    kind: "CAPABILITY",
    aliases: ["warehouse migration", "migration or rebuild", "warehouse rebuild", "data warehouse migration", "platform migration", "legacy migration"],
    msiMatchKeys: ["warehouse migration", "migration", "migration testing", "data engineering", "snowflake"],
  },
  {
    canonicalName: "ELT / ETL Pipeline Development",
    kind: "CAPABILITY",
    aliases: ["elt pipelines", "etl pipelines", "elt/etl pipelines", "modern elt", "data pipeline development", "data pipelines", "elt/etl", "etl/elt"],
    msiMatchKeys: ["etl", "elt", "data pipelines", "data pipeline development", "azure pipelines", "reverse etl", "idempotent pipelines", "ci/cd for data pipelines", "azure data factory", "python"],
  },
  {
    canonicalName: "Change Data Capture (CDC)",
    kind: "METHODOLOGY",
    aliases: ["change data capture", "cdc", "scd type 2", "slowly changing dimensions"],
    msiMatchKeys: ["change data capture", "cdc", "scd type 2"],
  },
  {
    canonicalName: "AI-assisted Development",
    kind: "CAPABILITY",
    aliases: ["ai-assisted development", "ai-assisted coding", "github copilot", "claude code", "cursor", "llm-powered data workflows", "ai/ml tools into the development cycle"],
    msiMatchKeys: ["ai-assisted development", "github copilot", "python"],
  },
];

const BOILERPLATE_EXCLUSIONS: RegExp[] = [
  /equal opportunity employer/i,
  /\bEEO\b/,
  /competitive (salary|compensation|benefits)/i,
  /health insurance|401\(k\)|paid time off|\bPTO\b/i,
  /\bwe (offer|provide)\b/i,
  /about (us|the company|our team)\b/i,
  /diversity,?\s*equity,?\s*and\s*inclusion/i,
  /reasonable accommodation/i,
  /background check/i,
  /\b(base|annual|starting) (salary|pay)\b|\bsalary range\b|\bpay range\b|\btotal (rewards|compensation)\b/i,
  /\bon target earnings\b|\bOTE\b|\bbonus (potential|program|opportunit)/i,
  /\b(dental|vision|life|disability) insurance\b|\bflexible spending\b|\bstock (purchase|option|grant)\b/i,
  /\bequity\b.*\b(award|grant|package)\b/i,
  /\bwithout regard to (race|color|religion)\b|\baffirmative action\b|\be-?verify\b|\bprotected veteran/i,
  /\brecruitment fraud\b|\bstaffing agenc|\bunsolicited resumes?\b|\bthird[- ]party recruiters?\b/i,
  /\bapplication deadline\b|\bhow to apply\b|\bsubmit your application\b/i,
  /\bdrug[- ]free workplace\b/i,
  /Gartner (Magic Quadrant|Customers|Leader|Visionary)/i,
  /taking a stand initiative/i,
  /vacation \(starting year one\)/i,
  /monthly tech stipend/i,
  /parental leave/i,
];

function isBoilerplate(text: string): boolean {
  return BOILERPLATE_EXCLUSIONS.some((p) => p.test(text));
}

/**
 * Reconciles raw JD text with structured requirements to form a comprehensive,
 * canonical requirement inventory supporting both named tools and engineering capabilities.
 */
export function reconcileJdRequirements(params: {
  rawJd: string;
  structuredRequirements: RequirementUnit[];
  candidateProfile: CandidateProfile;
  roleTitle?: string;
}): JdReconciliationResult {
  const { rawJd = "", structuredRequirements = [], candidateProfile, roleTitle = "" } = params;

  const { canonicalSet } = buildCandidateGlobalCapabilitySet(candidateProfile);
  const candidateExperienceSkills = new Set(
    candidateProfile.experience.flatMap((e) => (e.technologies || []).map((t) => t.toLowerCase()))
  );

  const matchedCanonicalMap = new Map<string, CanonicalJdRequirement>();
  const findings: JdExtractionFinding[] = [];

  // Helper to test if a candidate supports a canonical definition
  function checkCandidateSupport(tax: TaxonomyDefinition): { supported: boolean; sources: string[] } {
    const sources: string[] = [];
    for (const key of tax.msiMatchKeys) {
      const kLower = key.toLowerCase();
      if (canonicalSet.has(kLower)) {
        sources.push(`MSI (${key})`);
      }
      if (candidateExperienceSkills.has(kLower)) {
        sources.push(`Experience (${key})`);
      }
    }
    // Also check canonical name itself
    const canonLower = tax.canonicalName.toLowerCase();
    if (canonicalSet.has(canonLower) && !sources.some((s) => s.includes(`MSI (${tax.canonicalName})`))) {
      sources.push(`MSI (${tax.canonicalName})`);
    }
    if (candidateExperienceSkills.has(canonLower) && !sources.some((s) => s.includes(`Experience (${tax.canonicalName})`))) {
      sources.push(`Experience (${tax.canonicalName})`);
    }

    const uniqueSources = Array.from(new Set(sources));
    return {
      supported: uniqueSources.length > 0,
      sources: uniqueSources,
    };
  }

  // 1. Process Structured Requirements First
  for (const req of structuredRequirements) {
    const labelLower = req.label.toLowerCase();
    const memberNames = (req.memberSkillNames || []).map((m) => m.toLowerCase());
    const allLabels = [labelLower, ...memberNames];

    // Find matching taxonomy entry
    const matchedTax = TECHNICAL_TAXONOMY.find((tax) =>
      tax.aliases.some((alias) => allLabels.some((l) => l.includes(alias.toLowerCase()))) ||
      tax.canonicalName.toLowerCase() === labelLower
    );

    const canonicalName = matchedTax ? matchedTax.canonicalName : req.label;
    const kind: CanonicalRequirementKind = matchedTax ? matchedTax.kind : "TECHNOLOGY";

    let priority: CanonicalRequirementPriority = "P2";
    let criticality: CanonicalRequirementCriticality = "REQUIRED";
    if (req.criticality === "CRITICAL") {
      priority = "P1";
      criticality = "CRITICAL";
    } else if (req.criticality === "REQUIRED" || req.requirementLevel === "Required") {
      priority = "P2";
      criticality = "REQUIRED";
    } else if (req.criticality === "PREFERRED" || req.requirementLevel === "Preferred") {
      priority = "P3";
      criticality = "PREFERRED";
    } else {
      priority = "P4";
      criticality = "BONUS";
    }

    const taxForCandidate = matchedTax || {
      canonicalName,
      kind,
      aliases: [canonicalName],
      msiMatchKeys: [canonicalName.toLowerCase()],
    };
    const { supported, sources } = checkCandidateSupport(taxForCandidate);

    const canonReq: CanonicalJdRequirement = {
      id: `REQ-${canonicalName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
      canonicalName,
      kind,
      rawText: (req.evidenceSnippets || []).join(" ") || req.label,
      priority,
      criticality,
      source: "STRUCTURED",
      evidenceSpans: req.evidenceSnippets || [],
      aliasesMatched: [req.label, ...(req.memberSkillNames || [])],
      supportedByCandidate: supported,
      candidateEvidenceSources: sources,
      writerAction: supported ? "PASS_TO_WRITER" : "DO_NOT_CLAIM",
      coverageExpectation: priority === "P1" ? "MUST_SURFACE" : priority === "P2" ? "SHOULD_SURFACE" : "OPTIONAL",
      gatedReason: supported ? undefined : "Not found in Global Master Skills Inventory or candidate experience record.",
    };

    matchedCanonicalMap.set(canonicalName.toLowerCase(), canonReq);
  }

  // 2. Scan Raw JD Text for Missing Tools and Capabilities (Raw-JD Reconciliation)
  const textSegments = rawJd
    .split(/(?:[\n\r]+|(?<=[.!?])\s+(?=[A-Z0-9]))/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const tax of TECHNICAL_TAXONOMY) {
    const key = tax.canonicalName.toLowerCase();
    const existing = matchedCanonicalMap.get(key);

    // Search segments for matches
    const matchingSnippets: string[] = [];
    const matchingAliases: string[] = [];
    let isP1Candidate = false;
    let isP2Candidate = false;
    let isP3Candidate = false;

    for (const segment of textSegments) {
      if (isBoilerplate(segment)) continue;

      for (const alias of tax.aliases) {
        const regex = new RegExp(`(?<![\\w-])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
        if (regex.test(segment)) {
          matchingSnippets.push(segment.length > 200 ? `${segment.slice(0, 197)}...` : segment);
          if (!matchingAliases.includes(alias)) {
            matchingAliases.push(alias);
          }

          // Check contextual priority cues
          const segLower = segment.toLowerCase();
          if (
            /\b(deep expertise|must have|required|core|lead|architect and implement|3\+\s+years working directly with)\b/i.test(segLower) ||
            (roleTitle && new RegExp(tax.canonicalName, "i").test(roleTitle))
          ) {
            isP1Candidate = true;
          } else if (
            /\b(strong command|design, build|responsible for|experience with|5\+\s+years|proven ability|establish and enforce|contribute to)\b/i.test(segLower)
          ) {
            isP2Candidate = true;
          } else if (
            /\b(preferred|nice to have|plus|familiarity with|or equivalent)\b/i.test(segLower)
          ) {
            isP3Candidate = true;
          }
        }
      }
    }

    if (matchingSnippets.length > 0) {
      const derivedPriority: CanonicalRequirementPriority = isP1Candidate
        ? "P1"
        : isP2Candidate
        ? "P2"
        : isP3Candidate
        ? "P3"
        : "P2";

      const derivedCriticality: CanonicalRequirementCriticality =
        derivedPriority === "P1" ? "CRITICAL" : derivedPriority === "P2" ? "REQUIRED" : "PREFERRED";

      const { supported, sources } = checkCandidateSupport(tax);

      if (existing) {
        // Update existing structured requirement with richer raw JD evidence
        existing.source = "BOTH";
        existing.evidenceSpans = Array.from(new Set([...existing.evidenceSpans, ...matchingSnippets]));
        existing.aliasesMatched = Array.from(new Set([...existing.aliasesMatched, ...matchingAliases]));
        // If raw JD indicates P1 criticality, upgrade
        if (derivedPriority === "P1" && existing.priority !== "P1") {
          existing.priority = "P1";
          existing.criticality = "CRITICAL";
          existing.coverageExpectation = "MUST_SURFACE";
        }
      } else {
        // Recovered from Raw JD
        const recoveredReq: CanonicalJdRequirement = {
          id: `REQ-${tax.canonicalName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
          canonicalName: tax.canonicalName,
          kind: tax.kind,
          rawText: matchingSnippets[0] || tax.canonicalName,
          priority: derivedPriority,
          criticality: derivedCriticality,
          source: "RAW_JD_RECONCILIATION",
          evidenceSpans: matchingSnippets,
          aliasesMatched: matchingAliases,
          supportedByCandidate: supported,
          candidateEvidenceSources: sources,
          writerAction: supported ? "PASS_TO_WRITER" : "DO_NOT_CLAIM",
          coverageExpectation: derivedPriority === "P1" ? "MUST_SURFACE" : derivedPriority === "P2" ? "SHOULD_SURFACE" : "OPTIONAL",
          gatedReason: supported ? undefined : "Not found in Global Master Skills Inventory or candidate experience record.",
        };

        matchedCanonicalMap.set(key, recoveredReq);

        findings.push({
          type: "JD_EXTRACTION_GAP_RECOVERED",
          requirement: tax.canonicalName,
          priority: derivedPriority,
          sourceSnippet: matchingSnippets[0] || "",
          actionTaken: supported
            ? `Recovered into canonical inventory as supported ${derivedPriority} requirement -> PASS_TO_WRITER.`
            : `Recovered into canonical inventory as unsupported ${derivedPriority} requirement -> DO_NOT_CLAIM.`,
        });
      }
    }
  }

  const canonicalRequirements = Array.from(matchedCanonicalMap.values());

  // Compute completeness counts
  const totalMaterialRequirements = canonicalRequirements.length;
  const technologyRequirementsCount = canonicalRequirements.filter(
    (r) => r.kind === "TECHNOLOGY" || r.kind === "PLATFORM" || r.kind === "LANGUAGE" || r.kind === "DEVOPS"
  ).length;
  const capabilityRequirementsCount = canonicalRequirements.filter(
    (r) => r.kind === "CAPABILITY" || r.kind === "METHODOLOGY"
  ).length;
  const architectureRequirementsCount = canonicalRequirements.filter((r) => r.kind === "ARCHITECTURE").length;

  const structuredCount = canonicalRequirements.filter((r) => r.source === "STRUCTURED" || r.source === "BOTH").length;
  const recoveredCount = canonicalRequirements.filter((r) => r.source === "RAW_JD_RECONCILIATION").length;
  const unresolvedCount = 0; // All recognized material requirements are recovered

  const p1Count = canonicalRequirements.filter((r) => r.priority === "P1").length;
  const p2Count = canonicalRequirements.filter((r) => r.priority === "P2").length;
  const p3Count = canonicalRequirements.filter((r) => r.priority === "P3").length;
  const p4Count = canonicalRequirements.filter((r) => r.priority === "P4").length;

  const supportedMaterialCount = canonicalRequirements.filter((r) => r.supportedByCandidate).length;
  const supportedP1Count = canonicalRequirements.filter((r) => r.supportedByCandidate && r.priority === "P1").length;
  const supportedP2Count = canonicalRequirements.filter((r) => r.supportedByCandidate && r.priority === "P2").length;
  const supportedP3Count = canonicalRequirements.filter((r) => r.supportedByCandidate && r.priority === "P3").length;
  const supportedP4Count = canonicalRequirements.filter((r) => r.supportedByCandidate && r.priority === "P4").length;
  const doNotClaimCount = canonicalRequirements.filter((r) => !r.supportedByCandidate).length;

  const isComplete = unresolvedCount === 0 && totalMaterialRequirements > 0;

  const completeness: JdIntelligenceCompleteness = {
    isComplete,
    totalMaterialRequirements,
    technologyRequirementsCount,
    capabilityRequirementsCount,
    architectureRequirementsCount,
    structuredCount,
    recoveredCount,
    unresolvedCount,
    p1Count,
    p2Count,
    p3Count,
    p4Count,
    supportedMaterialCount,
    supportedP1Count,
    supportedP2Count,
    supportedP3Count,
    supportedP4Count,
    doNotClaimCount,
    unresolvedCritical: [],
    unresolvedRequired: [],
    findings,
  };

  return {
    canonicalRequirements,
    completeness,
  };
}

/**
 * PHASE 6.3A — CANONICAL -> LEGACY ADAPTER.
 *
 * Projects the canonical, reconciled requirement inventory into the legacy RequirementUnit[] shape so
 * every existing Phase 6/6.1 consumer (detectTargetEcosystem, evaluateJdToolCoveragePlan,
 * buildEmployerArchitecturePalettes, buildJdPriorityMatrix, extractWriterJobIntent) can be driven by
 * the canonical inventory WITHOUT a second, independently-ranked requirement system and without
 * changing any of those functions' signatures or internal logic.
 *
 * This is the ONE place priority/criticality is translated between the two shapes, and it is the
 * EXACT inverse of the mappings those consumers already use to derive a tier from `criticality`
 * (jdPriorityMatrix.ts's tierFromCriticality, jdToolCoverage.ts's own req.criticality switch) — so a
 * canonical P1/CRITICAL requirement round-trips back out as P1 everywhere downstream, never silently
 * re-ranked. The canonical requirement's own priority is authoritative; nothing downstream recomputes
 * it from anything other than this same criticality value.
 *
 * SUPPORT STATUS IS NOT ROUND-TRIPPED THROUGH THIS SHAPE. evaluateJdToolCoveragePlan resolves support
 * independently via classifyTechnology/canonicalSet.has(literal name) — a technology-name-oriented
 * mechanism that predates Phase 6.2 and does not know this module's own broader msiMatchKeys synonyms
 * (e.g. "Lakehouse Architecture" also matches "lakehouse"/"databricks"/"delta lake"), so it can
 * disagree with checkCandidateSupport's determination for a capability/architecture requirement (see
 * getReconciledUnsupportedNames below and its callers in handoff/exporter.ts and
 * preWriterDecisionPackage.ts, which use the reconciler's own writerAction/supportedByCandidate as the
 * authoritative support signal instead of re-deriving it from this adapted shape). Extending
 * memberSkillNames with extra evidence terms to paper over that was tried and reverted: those terms
 * also feed cloud/platform signal scoring and JD-skill matching in other consumers, and leaked false
 * cloud signals (a raw MSI term like "azure data factory" wrongly registering as an AZURE mention).
 * Keeping this adapter's output to exactly the canonical name avoids that cross-consumer leakage.
 */
export function canonicalRequirementsToRequirementUnits(
  requirements: CanonicalJdRequirement[]
): RequirementUnit[] {
  return requirements.map((req) => {
    const criticality: RequirementCriticality = req.criticality === "BONUS" ? "OPTIONAL" : req.criticality;
    const requirementLevel: RequirementLevel = criticality === "CRITICAL" || criticality === "REQUIRED" ? "Required" : "Preferred";

    return {
      kind: "skill",
      // Deliberately just the canonical name — matchedCanonicalMap already dedupes identical
      // requirements upstream; keeping this to one member avoids reintroducing the exact
      // label/memberSkillNames self-duplication that inflated platform/cloud scores (see
      // targetEcosystem.ts's termsToTest dedup fix, the other half of this same defect class).
      memberSkillNames: [req.canonicalName],
      categories: [],
      label: req.canonicalName,
      requirementLevel,
      criticality,
      evidenceSnippets: req.evidenceSpans.length > 0 ? req.evidenceSpans : [req.rawText],
      experienceDepthRequired: false,
      requestedYears: null,
      // Semantically identical to unclaimedRequirementDetector.ts's own contract for this field: a
      // real requirement no structured extractor (job_skills row) captured — exactly what
      // RAW_JD_RECONCILIATION means here.
      fromUnclaimedText: req.source === "RAW_JD_RECONCILIATION",
    };
  });
}

/**
 * PHASE 6.3A — the reconciler's own authoritative unsupported-requirement names (writerAction ===
 * "DO_NOT_CLAIM"), for callers that need a DO_NOT_CLAIM list without re-deriving support from the
 * adapted RequirementUnit shape (see canonicalRequirementsToRequirementUnits's own doc comment for
 * why re-deriving it independently can disagree). This is the single source both
 * buildEmployerArchitecturePalettes's "Unsupported JD tools" line and
 * preWriterDecisionPackage.ts's audit summary should read from whenever reconciliation ran.
 */
export function getReconciledUnsupportedNames(requirements: CanonicalJdRequirement[]): string[] {
  return requirements.filter((r) => r.writerAction === "DO_NOT_CLAIM").map((r) => r.canonicalName);
}

/**
 * PHASE 6.3A — the single, compact, writer-facing rendering of the canonical requirement inventory.
 *
 * This is the ONE place MUST_SURFACE / SHOULD_SURFACE / OPTIONAL / DO_NOT_CLAIM guidance is stated for
 * the writer, covering both named technologies and engineering capabilities/architectures (never
 * calling a capability like "Data Governance" or "Cost & Performance Optimization" a "tool"). Replaces
 * the narrower legacy JD Tool Coverage rendering wherever reconciliation ran, so the prompt states
 * requirement coverage exactly once rather than in two independently-worded sections.
 */
export function renderCanonicalRequirementSection(result: JdReconciliationResult): string {
  const { canonicalRequirements } = result;
  const passToWriter = canonicalRequirements.filter((r) => r.writerAction === "PASS_TO_WRITER");
  const doNotClaim = canonicalRequirements.filter((r) => r.writerAction === "DO_NOT_CLAIM");

  // Kind is only worth stating inline for a non-obvious item (a capability/architecture/methodology
  // that could otherwise be mistaken for a literal "tool" to bolt in verbatim) — a named technology,
  // platform, language, or devops tool needs no qualifier and stays compact.
  const fmt = (r: CanonicalJdRequirement) =>
    r.kind === "CAPABILITY" || r.kind === "ARCHITECTURE" || r.kind === "METHODOLOGY" ? `${r.canonicalName} (${r.kind.toLowerCase()})` : r.canonicalName;
  const mustSurface = passToWriter.filter((r) => r.coverageExpectation === "MUST_SURFACE");
  const shouldSurface = passToWriter.filter((r) => r.coverageExpectation === "SHOULD_SURFACE");
  const optional = passToWriter.filter((r) => r.coverageExpectation === "OPTIONAL");

  let out = `## TARGET JOB REQUIREMENTS — JD-Reconciled, MSI-Verified\n\n`;
  out += `Reconciled from the JD's structured extraction AND raw text — nothing invented. Each item is genuinely supported by MSI/experience, or gated below. A listed capability/architecture (marked in parentheses) matters exactly as much as a named tool.\n\n`;

  if (mustSurface.length > 0) {
    out += `**MUST SURFACE (P1 — Critical, supported):** ${mustSurface.map(fmt).join(", ")}\n\n`;
  }
  if (shouldSurface.length > 0) {
    out += `**SHOULD SURFACE (P2 — Required, supported):** ${shouldSurface.map(fmt).join(", ")}\n\n`;
  }
  if (optional.length > 0) {
    out += `**OPTIONAL (P3/P4 — Preferred/Bonus, supported):** ${optional.map(fmt).join(", ")}\n\n`;
  }
  if (doNotClaim.length > 0) {
    out += `**DO NOT CLAIM (JD-requested, zero MSI/experience evidence — never write these in):** ${doNotClaim.map(fmt).join(", ")}\n\n`;
  }

  out += `*Distribution rule:* Distribute MUST/SHOULD SURFACE items naturally across Summary, Skills, Project Descriptions, Bullets, and Environment lines — never as a keyword dump, and only where the employer's assigned architecture palette supports it.\n`;

  return out;
}
