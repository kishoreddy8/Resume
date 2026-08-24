import type { RequirementUnit } from "@/lib/match/types";
import { classifyTechnology, type CloudAffiliation } from "./technologyClassification";

export type TargetEcosystem =
  | "AWS"
  | "AZURE"
  | "GCP"
  | "MULTI_CLOUD"
  | "CLOUD_NEUTRAL"
  | "SNOWFLAKE_CENTERED"
  | "DATABRICKS_CENTERED";

export type EcosystemConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface TargetEcosystemResult {
  targetEcosystem: TargetEcosystem;
  primaryCloud: CloudAffiliation;
  confidence: EcosystemConfidence;
  scores: {
    aws: number;
    azure: number;
    gcp: number;
    snowflake: number;
    databricks: number;
  };
  supportingRequirements: {
    aws: string[];
    azure: string[];
    gcp: string[];
    snowflake: string[];
    databricks: string[];
    neutral: string[];
  };
  reasoning: string;
}

/**
 * Deterministically detects the target technology ecosystem requested by the job description.
 */
export function detectTargetEcosystem(params: {
  company?: string;
  roleTitle?: string;
  jobDescriptionText?: string;
  jobRequirements?: RequirementUnit[];
}): TargetEcosystemResult {
  const { jobRequirements = [], jobDescriptionText = "" } = params;

  let awsScore = 0;
  let azureScore = 0;
  let gcpScore = 0;
  let snowflakeScore = 0;
  let databricksScore = 0;

  const supporting = {
    aws: [] as string[],
    azure: [] as string[],
    gcp: [] as string[],
    snowflake: [] as string[],
    databricks: [] as string[],
    neutral: [] as string[],
  };

  // 1. Score structured requirements
  for (const req of jobRequirements) {
    const weight =
      req.criticality === "CRITICAL"
        ? 4
        : req.criticality === "REQUIRED" || req.requirementLevel === "Required"
        ? 2
        : req.criticality === "PREFERRED"
        ? 1
        : 0.5;

    const termsToTest = [req.label, ...(req.memberSkillNames ?? [])].filter(
      (t): t is string => Boolean(t && t.trim().length > 0)
    );

    for (const term of termsToTest) {
      const entry = classifyTechnology(term);
      const termLower = term.toLowerCase();

      if (entry?.cloud === "AWS" || termLower.includes("aws") || termLower.includes("amazon")) {
        awsScore += weight;
        supporting.aws.push(term);
      } else if (entry?.cloud === "AZURE" || termLower.includes("azure") || termLower.includes("microsoft fabric")) {
        azureScore += weight;
        supporting.azure.push(term);
      } else if (entry?.cloud === "GCP" || termLower.includes("gcp") || termLower.includes("google cloud") || termLower.includes("bigquery")) {
        gcpScore += weight;
        supporting.gcp.push(term);
      }

      if (termLower.includes("snowflake")) {
        snowflakeScore += weight;
        supporting.snowflake.push(term);
      }
      if (termLower.includes("databricks") || termLower.includes("pyspark") || termLower.includes("spark") || termLower.includes("delta lake")) {
        databricksScore += weight;
        supporting.databricks.push(term);
      }
      if (entry?.cloud === "CLOUD_NEUTRAL" || entry?.cloud === "MULTI_CLOUD") {
        supporting.neutral.push(term);
      }
    }
  }

  // 2. Scan JD text if structured requirements yielded zero or low cloud signal
  if (awsScore === 0 && azureScore === 0 && gcpScore === 0) {
    const textLower = jobDescriptionText.toLowerCase();
    
    // AWS indicators
    const awsMatches = (textLower.match(/\b(aws|amazon web services|s3|redshift|glue|emr|athena|kinesis|lambda)\b/gi) || []).length;
    awsScore += awsMatches * 1.5;
    if (awsMatches > 0) supporting.aws.push(`JD text matches (${awsMatches})`);

    // Azure indicators
    const azureMatches = (textLower.match(/\b(azure|adls|azure data factory|synapse|azure databricks|event hubs|cosmos db)\b/gi) || []).length;
    azureScore += azureMatches * 1.5;
    if (azureMatches > 0) supporting.azure.push(`JD text matches (${azureMatches})`);

    // GCP indicators
    const gcpMatches = (textLower.match(/\b(gcp|google cloud|bigquery|cloud data fusion|dataflow|dataproc|gcs|pub\/sub)\b/gi) || []).length;
    gcpScore += gcpMatches * 1.5;
    if (gcpMatches > 0) supporting.gcp.push(`JD text matches (${gcpMatches})`);

    // Snowflake & Databricks indicators
    const sfMatches = (textLower.match(/\bsnowflake\b/gi) || []).length;
    snowflakeScore += sfMatches * 2;
    if (sfMatches > 0) supporting.snowflake.push(`JD text matches (${sfMatches})`);

    const dbMatches = (textLower.match(/\b(databricks|pyspark|delta lake|apache spark)\b/gi) || []).length;
    databricksScore += dbMatches * 1.5;
    if (dbMatches > 0) supporting.databricks.push(`JD text matches (${dbMatches})`);
  }

  // 3. Determine target ecosystem
  const maxScore = Math.max(awsScore, azureScore, gcpScore);
  const cloudDiff = (a: number, b: number) => Math.abs(a - b);

  let targetEcosystem: TargetEcosystem = "CLOUD_NEUTRAL";
  let primaryCloud: CloudAffiliation = "CLOUD_NEUTRAL";
  let confidence: EcosystemConfidence = "LOW";
  let reasoning = "";

  const isMultiCloud =
    (awsScore >= 4 && azureScore >= 4) ||
    (awsScore >= 4 && gcpScore >= 4) ||
    (azureScore >= 4 && gcpScore >= 4);

  if (isMultiCloud && cloudDiff(awsScore, azureScore) <= 2 && cloudDiff(awsScore, gcpScore) <= 2) {
    targetEcosystem = "MULTI_CLOUD";
    primaryCloud = "MULTI_CLOUD";
    confidence = "HIGH";
    reasoning = `Multiple cloud ecosystems explicitly requested with comparable weights (AWS: ${awsScore}, Azure: ${azureScore}, GCP: ${gcpScore}).`;
  } else if (awsScore > azureScore && awsScore > gcpScore && awsScore >= 3) {
    targetEcosystem = "AWS";
    primaryCloud = "AWS";
    confidence = awsScore >= 6 ? "HIGH" : "MEDIUM";
    reasoning = `AWS ecosystem strongly indicated by JD requirements (score: ${awsScore} vs Azure: ${azureScore}, GCP: ${gcpScore}).`;
  } else if (azureScore > awsScore && azureScore > gcpScore && azureScore >= 3) {
    targetEcosystem = "AZURE";
    primaryCloud = "AZURE";
    confidence = azureScore >= 6 ? "HIGH" : "MEDIUM";
    reasoning = `Azure ecosystem strongly indicated by JD requirements (score: ${azureScore} vs AWS: ${awsScore}, GCP: ${gcpScore}).`;
  } else if (gcpScore > awsScore && gcpScore > azureScore && gcpScore >= 3) {
    targetEcosystem = "GCP";
    primaryCloud = "GCP";
    confidence = gcpScore >= 6 ? "HIGH" : "MEDIUM";
    reasoning = `GCP ecosystem strongly indicated by JD requirements (score: ${gcpScore} vs AWS: ${awsScore}, Azure: ${azureScore}).`;
  } else if (snowflakeScore >= 6 && maxScore <= 3) {
    targetEcosystem = "SNOWFLAKE_CENTERED";
    primaryCloud = "CLOUD_NEUTRAL";
    confidence = "HIGH";
    reasoning = `Snowflake data platform prominently required without a dominant cloud constraint (score: ${snowflakeScore}).`;
  } else if (databricksScore >= 6 && maxScore <= 3) {
    targetEcosystem = "DATABRICKS_CENTERED";
    primaryCloud = "CLOUD_NEUTRAL";
    confidence = "HIGH";
    reasoning = `Databricks / Lakehouse platform prominently required without a dominant cloud constraint (score: ${databricksScore}).`;
  } else {
    targetEcosystem = "CLOUD_NEUTRAL";
    primaryCloud = "CLOUD_NEUTRAL";
    confidence = "LOW";
    reasoning = `No single cloud provider dominated; prioritizing core data engineering and cloud-neutral technologies.`;
  }

  return {
    targetEcosystem,
    primaryCloud,
    confidence,
    scores: {
      aws: Math.round(awsScore * 10) / 10,
      azure: Math.round(azureScore * 10) / 10,
      gcp: Math.round(gcpScore * 10) / 10,
      snowflake: Math.round(snowflakeScore * 10) / 10,
      databricks: Math.round(databricksScore * 10) / 10,
    },
    supportingRequirements: {
      aws: [...new Set(supporting.aws)],
      azure: [...new Set(supporting.azure)],
      gcp: [...new Set(supporting.gcp)],
      snowflake: [...new Set(supporting.snowflake)],
      databricks: [...new Set(supporting.databricks)],
      neutral: [...new Set(supporting.neutral)],
    },
    reasoning,
  };
}

/**
 * Writer-facing guidance for the Target Ecosystem Strategy.
 */
export function renderTargetEcosystemSection(result: TargetEcosystemResult): string {
  const { targetEcosystem, confidence, reasoning } = result;

  return `## TARGET ECOSYSTEM STRATEGY: ${targetEcosystem} (Confidence: ${confidence})

**Deterministic Ecosystem Directive:**
${reasoning}

- **Primary Ecosystem Focus:** Tailor the complete resume (Summary, Skills, Project Descriptions, Experience Bullets, Environment lines) to emphasize **${targetEcosystem}** architectures.
- **Cloud Substitution Rule:** Where MSI evidence supports it, represent data engineering workflows using approved ${targetEcosystem} equivalent services (e.g. Ingestion, Storage, Warehousing).
- **Preserve Cloud-Neutral Engineering Foundations:** Core technologies (Databricks, Snowflake, Python, SQL, PySpark, Spark, Delta Lake, dbt, Kafka, Airflow, Terraform, Docker, Kubernetes, CI/CD, CDC, SCD Type 2, dimensional modeling, data quality, governance) are available when supported by candidate evidence; do NOT mechanically force every neutral tool into every section.
- **Coherent Architecture:** Ensure every bullet forms a valid engineering pipeline: SOURCE -> INGESTION/ORCHESTRATION -> PROCESSING -> STORAGE/WAREHOUSE -> OUTCOME. Never stack competing equivalent tools in the same pipeline without migration/integration context.
`;
}
