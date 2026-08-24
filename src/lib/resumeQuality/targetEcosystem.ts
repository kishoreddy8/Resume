import type { RequirementUnit, CandidateProfile } from "@/lib/match/types";
import { classifyTechnology, type CloudAffiliation } from "./technologyClassification";
import { roleAcceptsInventoryEvidence } from "./msiEvidence";

export type TargetEcosystem =
  | "AWS"
  | "AZURE"
  | "GCP"
  | "MULTI_CLOUD"
  | "CLOUD_NEUTRAL"
  | "SNOWFLAKE_CENTERED"
  | "DATABRICKS_CENTERED";

export type CloudRequirementMode =
  | "NONE"
  | "SINGLE"
  | "ALTERNATIVE"
  | "TRUE_TWO_CLOUD"
  | "TRUE_MULTI_CLOUD";

export type EcosystemConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface EmployerCloudAssignment {
  employer: string;
  cloud: "AZURE" | "AWS" | "GCP";
  reason: string;
}

export interface CloudSignalProvenance {
  provider: "AWS" | "AZURE" | "GCP";
  rawText: string;
  source: "RAW_JD" | "STRUCTURED_REQUIREMENT";
  priority: "P1" | "P2" | "P3" | "P4";
  scoreContribution: number;
}

export interface PlatformSignalProvenance {
  platform: "SNOWFLAKE" | "DATABRICKS";
  rawText: string;
  source: "RAW_JD" | "STRUCTURED_REQUIREMENT";
  priority: "P1" | "P2" | "P3" | "P4";
  scoreContribution: number;
}

export interface TargetEcosystemResult {
  primaryPlatform: "SNOWFLAKE" | "DATABRICKS" | null;
  supportingCloud: "AZURE" | "AWS" | "GCP" | "MULTI_CLOUD";
  primaryCloud: CloudAffiliation;
  targetEcosystem: TargetEcosystem;
  confidence: EcosystemConfidence;
  cloudsExplicitlyMentioned: string[];
  cloudRequirementMode: CloudRequirementMode;
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
  cloudSignals?: CloudSignalProvenance[];
  platformSignals?: PlatformSignalProvenance[];
  employerCloudAssignments: EmployerCloudAssignment[];
  reasoning: string;
}

// Regex patterns for detecting genuine alternative cloud language mentioning specific providers
const ALTERNATIVE_CLOUD_PATTERNS = [
  /\b(?:experience\s+(?:with|in)|proficiency\s+in|knowledge\s+of|working\s+with|familiarity\s+with)\s+(?:aws|azure|gcp)[\s,/]+(?:or|and\/or)?\s*(?:aws|azure|gcp)[\s,/]+(?:or|and\/or)?\s*(?:aws|azure|gcp)?/i,
  /\b(?:aws|azure|gcp)\s*,\s*(?:aws|azure|gcp)\s*,\s*or\s*(?:aws|azure|gcp)\b/i,
  /\b(?:aws|azure|gcp)\s*[\/|]\s*(?:aws|azure|gcp)(?:\s*[\/|]\s*(?:aws|azure|gcp))?\b/i,
  /\b(?:any|major)\s+(?:public\s+)?cloud\s+(?:provider|platform)s?\s*(?:\((?:aws|azure|gcp)[\s,/]+(?:aws|azure|gcp)?\))?/i,
  /\b(?:aws\s+or\s+azure|azure\s+or\s+aws|aws\s+or\s+gcp|gcp\s+or\s+aws|azure\s+or\s+gcp|gcp\s+or\s+azure)\s+(?:experience|is\s+a\s+plus|preferred|desired|technologies)\b/i,
  /\b(?:aws|azure|gcp)\s+or\s+(?:aws|azure|gcp)\b/i,
];

// Regex patterns for detecting genuine two-cloud requirements
const TRUE_TWO_CLOUD_PATTERNS = [
  /\b(?:across|between|both|integrate|integrating|hybrid|multi-cloud|solutions\s+across|platforms?\s+in|migrat\w*\s+between|workloads\s+between)\s+(?:azure\s+and\s+aws|aws\s+and\s+azure|azure\s+and\s+gcp|gcp\s+and\s+azure|aws\s+and\s+gcp|gcp\s+and\s+aws)\b/i,
  /\b(?:azure\s+and\s+aws|aws\s+and\s+azure|azure\s+and\s+gcp|gcp\s+and\s+azure|aws\s+and\s+gcp|gcp\s+and\s+aws)\s+(?:environments?|platforms?|infrastructure|workloads?|data\s+platforms?|architectures?)\b/i,
  /\b(?:operate|operating|maintain|maintaining)\s+data\s+platforms?\s+in\s+(?:azure\s+and\s+aws|aws\s+and\s+azure|azure\s+and\s+gcp|gcp\s+and\s+azure|aws\s+and\s+gcp|gcp\s+and\s+aws)\b/i,
];

// Regex patterns for detecting genuine three-cloud / multi-cloud requirements
const TRUE_THREE_CLOUD_PATTERNS = [
  /\b(?:across|between|integrate|integrating|hybrid|multi-cloud|solutions\s+across)\s+(?:aws,\s*azure,\s*(?:and\s+)?gcp|azure,\s*aws,\s*(?:and\s+)?gcp|aws,\s*gcp,\s*(?:and\s+)?azure)\b/i,
  /\bmulti-cloud\s+architecture\s+across\s+(?:azure|aws|gcp)\b/i,
];

/**
 * Deterministically detects the target technology ecosystem requested by the job description,
 * separating primary platform from supporting cloud, and computing per-employer cloud allocations.
 */
export function detectTargetEcosystem(params: {
  company?: string;
  roleTitle?: string;
  jobDescriptionText?: string;
  jobRequirements?: RequirementUnit[];
  candidateProfile?: CandidateProfile;
}): TargetEcosystemResult {
  const { jobRequirements = [], jobDescriptionText = "", candidateProfile } = params;

  let awsScore = 0;
  let azureScore = 0;
  let gcpScore = 0;
  let snowflakeScore = 0;
  let databricksScore = 0;

  const cloudSignals: CloudSignalProvenance[] = [];
  const platformSignals: PlatformSignalProvenance[] = [];

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
    const priority = req.criticality === "CRITICAL" ? "P1" : req.criticality === "REQUIRED" || req.requirementLevel === "Required" ? "P2" : req.criticality === "PREFERRED" ? "P3" : "P4";
    const weight =
      req.criticality === "CRITICAL"
        ? 4
        : req.criticality === "REQUIRED" || req.requirementLevel === "Required"
        ? 2
        : req.criticality === "PREFERRED"
        ? 1
        : 0.5;

    // PHASE 6.3A DEDUP FIX — a RequirementUnit whose label and memberSkillNames name the same
    // technology (e.g. label "Snowflake", memberSkillNames ["Snowflake"] — the common shape for a
    // single-skill unit, and exactly what the canonical-requirement adapter also emits) previously
    // ran through this scoring loop twice for the SAME piece of evidence, silently doubling that
    // term's score/signal contribution (observed live: a single "…rebuild on Snowflake" requirement
    // inflated snowflakeScore from 2 to 4). Case-insensitive dedup within this one requirement unit
    // only — distinct requirement units (or genuinely distinct member names) still contribute
    // separately, exactly as the scoring design intends.
    const seenTermKeys = new Set<string>();
    const termsToTest = [req.label, ...(req.memberSkillNames ?? [])]
      .filter((t): t is string => Boolean(t && t.trim().length > 0))
      .filter((t) => {
        const key = t.trim().toLowerCase();
        if (seenTermKeys.has(key)) return false;
        seenTermKeys.add(key);
        return true;
      });

    for (const term of termsToTest) {
      const entry = classifyTechnology(term);
      const termLower = term.toLowerCase();
      const rawText = (req.evidenceSnippets || []).join(" ") || req.label;

      if (entry?.cloud === "AWS" || termLower.includes("aws") || termLower.includes("amazon")) {
        awsScore += weight;
        supporting.aws.push(term);
        cloudSignals.push({
          provider: "AWS",
          rawText,
          source: "STRUCTURED_REQUIREMENT",
          priority,
          scoreContribution: weight,
        });
      } else if (entry?.cloud === "AZURE" || termLower.includes("azure") || termLower.includes("microsoft fabric")) {
        azureScore += weight;
        supporting.azure.push(term);
        cloudSignals.push({
          provider: "AZURE",
          rawText,
          source: "STRUCTURED_REQUIREMENT",
          priority,
          scoreContribution: weight,
        });
      } else if (entry?.cloud === "GCP" || termLower.includes("gcp") || termLower.includes("google cloud") || termLower.includes("bigquery")) {
        gcpScore += weight;
        supporting.gcp.push(term);
        cloudSignals.push({
          provider: "GCP",
          rawText,
          source: "STRUCTURED_REQUIREMENT",
          priority,
          scoreContribution: weight,
        });
      }

      if (termLower.includes("snowflake")) {
        snowflakeScore += weight;
        supporting.snowflake.push(term);
        platformSignals.push({
          platform: "SNOWFLAKE",
          rawText,
          source: "STRUCTURED_REQUIREMENT",
          priority,
          scoreContribution: weight,
        });
      }
      if (termLower.includes("databricks") || termLower.includes("pyspark") || termLower.includes("spark") || termLower.includes("delta lake")) {
        databricksScore += weight;
        supporting.databricks.push(term);
        platformSignals.push({
          platform: "DATABRICKS",
          rawText,
          source: "STRUCTURED_REQUIREMENT",
          priority,
          scoreContribution: weight,
        });
      }
      if (entry?.cloud === "CLOUD_NEUTRAL" || entry?.cloud === "MULTI_CLOUD") {
        supporting.neutral.push(term);
      }
    }
  }

  // 2. Scan JD text
  const textLower = (jobDescriptionText || "").toLowerCase();
  const fullText = `${jobDescriptionText || ""} ${jobRequirements.map((r) => `${r.label} ${(r.evidenceSnippets || []).join(" ")}`).join(" ")}`;

  // AWS indicators in text
  const awsMatches = (textLower.match(/\b(aws|amazon web services|amazon s3|aws glue|amazon redshift|emr|athena|kinesis|lambda)\b/gi) || []).length;
  if (awsScore === 0 && awsMatches > 0) {
    const contribution = awsMatches * 1.5;
    awsScore += contribution;
    supporting.aws.push(`JD text matches (${awsMatches})`);
    cloudSignals.push({
      provider: "AWS",
      rawText: `Matched ${awsMatches} AWS term(s) in JD text.`,
      source: "RAW_JD",
      priority: "P2",
      scoreContribution: contribution,
    });
  }

  // Azure indicators in text
  const azureMatches = (textLower.match(/\b(azure|adls|azure data factory|synapse|azure databricks|event hubs|cosmos db)\b/gi) || []).length;
  if (azureScore === 0 && azureMatches > 0) {
    const contribution = azureMatches * 1.5;
    azureScore += contribution;
    supporting.azure.push(`JD text matches (${azureMatches})`);
    cloudSignals.push({
      provider: "AZURE",
      rawText: `Matched ${azureMatches} Azure term(s) in JD text.`,
      source: "RAW_JD",
      priority: "P2",
      scoreContribution: contribution,
    });
  }

  // GCP indicators in text
  const gcpMatches = (textLower.match(/\b(gcp|google cloud|bigquery|cloud data fusion|dataflow|dataproc|gcs|pub\/sub)\b/gi) || []).length;
  if (gcpScore === 0 && gcpMatches > 0) {
    const contribution = gcpMatches * 1.5;
    gcpScore += contribution;
    supporting.gcp.push(`JD text matches (${gcpMatches})`);
    cloudSignals.push({
      provider: "GCP",
      rawText: `Matched ${gcpMatches} GCP term(s) in JD text.`,
      source: "RAW_JD",
      priority: "P2",
      scoreContribution: contribution,
    });
  }

  // Snowflake & Databricks text indicators
  const sfMatches = (textLower.match(/\bsnowflake\b/gi) || []).length;
  if (snowflakeScore === 0 && sfMatches > 0) {
    const contribution = sfMatches * 2;
    snowflakeScore += contribution;
    supporting.snowflake.push(`JD text matches (${sfMatches})`);
    platformSignals.push({
      platform: "SNOWFLAKE",
      rawText: `Matched ${sfMatches} Snowflake term(s) in JD text.`,
      source: "RAW_JD",
      priority: "P1",
      scoreContribution: contribution,
    });
  }

  const dbMatches = (textLower.match(/\b(databricks|pyspark|delta lake|apache spark)\b/gi) || []).length;
  if (databricksScore === 0 && dbMatches > 0) {
    const contribution = dbMatches * 1.5;
    databricksScore += contribution;
    supporting.databricks.push(`JD text matches (${dbMatches})`);
    platformSignals.push({
      platform: "DATABRICKS",
      rawText: `Matched ${dbMatches} Databricks term(s) in JD text.`,
      source: "RAW_JD",
      priority: "P2",
      scoreContribution: contribution,
    });
  }

  // 3. Determine Clouds Explicitly Mentioned
  const cloudsExplicitlyMentioned: string[] = [];
  if (awsScore > 0 || /\b(aws|amazon s3|aws glue|amazon redshift)\b/i.test(fullText)) cloudsExplicitlyMentioned.push("AWS");
  if (azureScore > 0 || /\b(azure|adls|azure data factory|synapse)\b/i.test(fullText)) cloudsExplicitlyMentioned.push("AZURE");
  if (gcpScore > 0 || /\b(gcp|google cloud|bigquery)\b/i.test(fullText)) cloudsExplicitlyMentioned.push("GCP");

  // 4. Classify Cloud Requirement Mode
  let cloudRequirementMode: CloudRequirementMode = "NONE";

  const hasAlternativeSignal = ALTERNATIVE_CLOUD_PATTERNS.some((pattern) => pattern.test(fullText));
  const hasTrueTwoCloudSignal = TRUE_TWO_CLOUD_PATTERNS.some((pattern) => pattern.test(fullText));
  const hasTrueThreeCloudSignal = TRUE_THREE_CLOUD_PATTERNS.some((pattern) => pattern.test(fullText));

  // Check if multiple clouds have explicit separate requirements without "or"
  const distinctStrongClouds = [
    awsScore >= 2 ? "AWS" : null,
    azureScore >= 2 ? "AZURE" : null,
    gcpScore >= 2 ? "GCP" : null,
  ].filter(Boolean) as string[];

  if (hasTrueThreeCloudSignal || (distinctStrongClouds.length === 3 && !hasAlternativeSignal)) {
    cloudRequirementMode = "TRUE_MULTI_CLOUD";
  } else if (hasTrueTwoCloudSignal || (distinctStrongClouds.length === 2 && !hasAlternativeSignal)) {
    cloudRequirementMode = "TRUE_TWO_CLOUD";
  } else if (hasAlternativeSignal && (cloudsExplicitlyMentioned.length >= 2 || distinctStrongClouds.length <= 1)) {
    cloudRequirementMode = "ALTERNATIVE";
  } else if (cloudsExplicitlyMentioned.length === 0 && distinctStrongClouds.length === 0) {
    cloudRequirementMode = "NONE";
  } else if (cloudsExplicitlyMentioned.length === 1 || (distinctStrongClouds.length === 1 && !hasAlternativeSignal)) {
    cloudRequirementMode = "SINGLE";
  } else if (hasAlternativeSignal) {
    cloudRequirementMode = "ALTERNATIVE";
  } else if (distinctStrongClouds.length >= 2) {
    cloudRequirementMode = distinctStrongClouds.length === 2 ? "TRUE_TWO_CLOUD" : "TRUE_MULTI_CLOUD";
  } else {
    cloudRequirementMode = "SINGLE";
  }

  // 5. Determine Primary Platform (Snowflake vs Databricks vs null)
  let primaryPlatform: "SNOWFLAKE" | "DATABRICKS" | null = null;
  if (
    (snowflakeScore >= 4 && (snowflakeScore >= awsScore && snowflakeScore >= azureScore && snowflakeScore >= gcpScore)) ||
    (snowflakeScore > 0 && (awsScore === 0 && azureScore === 0 && gcpScore === 0))
  ) {
    primaryPlatform = "SNOWFLAKE";
  } else if (
    (databricksScore >= 6 && (databricksScore >= awsScore && databricksScore >= azureScore && databricksScore >= gcpScore)) ||
    (databricksScore > 0 && (awsScore === 0 && azureScore === 0 && gcpScore === 0))
  ) {
    primaryPlatform = "DATABRICKS";
  }

  // 6. Determine Supporting Cloud & Target Ecosystem
  let supportingCloud: "AZURE" | "AWS" | "GCP" | "MULTI_CLOUD" = "AZURE";
  let targetEcosystem: TargetEcosystem = "AZURE";
  let primaryCloud: CloudAffiliation = "AZURE";
  let confidence: EcosystemConfidence = "HIGH";
  let reasoning = "";

  if (cloudRequirementMode === "NONE") {
    // RULE B: No cloud mentioned -> Default to AZURE
    supportingCloud = "AZURE";
    primaryCloud = "AZURE";
    if (primaryPlatform === "SNOWFLAKE") {
      targetEcosystem = "SNOWFLAKE_CENTERED";
      reasoning = `Snowflake data platform prominently required with no explicit cloud provider mentioned; deterministically defaulting supporting cloud to Azure.`;
    } else if (primaryPlatform === "DATABRICKS") {
      targetEcosystem = "DATABRICKS_CENTERED";
      reasoning = `Databricks / Lakehouse platform prominently required with no explicit cloud provider mentioned; deterministically defaulting supporting cloud to Azure.`;
    } else {
      targetEcosystem = "AZURE";
      confidence = "MEDIUM";
      reasoning = `No cloud provider specified in JD; deterministically defaulting supporting cloud ecosystem to Azure.`;
    }
  } else if (cloudRequirementMode === "ALTERNATIVE") {
    // RULE C: Alternative cloud language (e.g. AWS/Azure/GCP) -> Default to AZURE
    supportingCloud = "AZURE";
    primaryCloud = "AZURE";
    if (primaryPlatform === "SNOWFLAKE") {
      targetEcosystem = "SNOWFLAKE_CENTERED";
      reasoning = `Alternative cloud provider options listed in JD (e.g. AWS/Azure/GCP); deterministically selecting Azure as supporting cloud for Snowflake data platform.`;
    } else if (primaryPlatform === "DATABRICKS") {
      targetEcosystem = "DATABRICKS_CENTERED";
      reasoning = `Alternative cloud provider options listed in JD (e.g. AWS/Azure/GCP); deterministically selecting Azure as supporting cloud for Databricks platform.`;
    } else {
      targetEcosystem = "AZURE";
      reasoning = `Alternative cloud provider options listed in JD (e.g. AWS/Azure/GCP); deterministically selecting Azure as primary supporting ecosystem.`;
    }
  } else if (cloudRequirementMode === "SINGLE") {
    // RULE A: One explicit cloud
    if (awsScore >= azureScore && awsScore >= gcpScore && (awsScore > 0 || cloudsExplicitlyMentioned.includes("AWS"))) {
      supportingCloud = "AWS";
      primaryCloud = "AWS";
      targetEcosystem = primaryPlatform === "SNOWFLAKE" ? "SNOWFLAKE_CENTERED" : primaryPlatform === "DATABRICKS" ? "DATABRICKS_CENTERED" : "AWS";
      reasoning = `AWS ecosystem explicitly required by JD (AWS score: ${awsScore} vs Azure: ${azureScore}, GCP: ${gcpScore}).`;
    } else if (gcpScore > awsScore && gcpScore >= azureScore && (gcpScore > 0 || cloudsExplicitlyMentioned.includes("GCP"))) {
      supportingCloud = "GCP";
      primaryCloud = "GCP";
      targetEcosystem = primaryPlatform === "SNOWFLAKE" ? "SNOWFLAKE_CENTERED" : primaryPlatform === "DATABRICKS" ? "DATABRICKS_CENTERED" : "GCP";
      reasoning = `GCP ecosystem explicitly required by JD (GCP score: ${gcpScore} vs AWS: ${awsScore}, Azure: ${azureScore}).`;
    } else {
      supportingCloud = "AZURE";
      primaryCloud = "AZURE";
      targetEcosystem = primaryPlatform === "SNOWFLAKE" ? "SNOWFLAKE_CENTERED" : primaryPlatform === "DATABRICKS" ? "DATABRICKS_CENTERED" : "AZURE";
      reasoning = `Azure ecosystem explicitly required by JD (Azure score: ${azureScore} vs AWS: ${awsScore}, GCP: ${gcpScore}).`;
    }
  } else if (cloudRequirementMode === "TRUE_TWO_CLOUD") {
    // RULE D: Two clouds genuinely required
    targetEcosystem = "MULTI_CLOUD";
    supportingCloud = "MULTI_CLOUD";
    primaryCloud = "MULTI_CLOUD";
    reasoning = `True two-cloud architecture explicitly required across multiple providers.`;
  } else {
    // RULE E: True three-cloud / multi-cloud
    targetEcosystem = "MULTI_CLOUD";
    supportingCloud = "MULTI_CLOUD";
    primaryCloud = "MULTI_CLOUD";
    reasoning = `Multi-cloud architecture across all major cloud providers explicitly required.`;
  }

  // 7. Deterministic Employer Cloud Assignments
  // Identify candidate technical employers (ordered chronologically or as provided)
  const employers = candidateProfile?.experience?.map((e) => e.employer) ?? [
    "Comerica Bank",
    "Fiserv",
    "Microgate Technologies",
  ];

  const technicalEmployers = employers.filter((emp) =>
    candidateProfile ? roleAcceptsInventoryEvidence(candidateProfile, emp) : true
  );

  const employerCloudAssignments: EmployerCloudAssignment[] = [];

  if (cloudRequirementMode === "NONE" || cloudRequirementMode === "SINGLE" || cloudRequirementMode === "ALTERNATIVE") {
    const assigned = supportingCloud === "MULTI_CLOUD" ? "AZURE" : supportingCloud;
    for (const emp of technicalEmployers) {
      employerCloudAssignments.push({
        employer: emp,
        cloud: assigned,
        reason:
          cloudRequirementMode === "NONE"
            ? `Default supporting ecosystem (Azure) for ${emp}.`
            : cloudRequirementMode === "ALTERNATIVE"
            ? `Deterministic fallback ecosystem (Azure) for alternative-cloud JD.`
            : `Single target cloud (${assigned}) requested by JD.`,
      });
    }
  } else if (cloudRequirementMode === "TRUE_TWO_CLOUD") {
    // Identify the two clouds
    const cloudPairs: Array<"AZURE" | "AWS" | "GCP"> = [];
    if (awsScore > 0 || /\baws\b/i.test(fullText)) cloudPairs.push("AWS");
    if (azureScore > 0 || /\bazure\b/i.test(fullText)) cloudPairs.push("AZURE");
    if (gcpScore > 0 || /\b(gcp|google cloud|bigquery)\b/i.test(fullText)) cloudPairs.push("GCP");

    let primaryTwo: "AZURE" | "AWS" | "GCP" = "AZURE";
    let secondaryTwo: "AZURE" | "AWS" | "GCP" = "AWS";

    if (cloudPairs.includes("AZURE") && cloudPairs.includes("AWS")) {
      if (awsScore > azureScore) {
        primaryTwo = "AWS";
        secondaryTwo = "AZURE";
      } else {
        // Equal or Azure stronger -> Azure is primary
        primaryTwo = "AZURE";
        secondaryTwo = "AWS";
      }
    } else if (cloudPairs.includes("AZURE") && cloudPairs.includes("GCP")) {
      if (gcpScore > azureScore) {
        primaryTwo = "GCP";
        secondaryTwo = "AZURE";
      } else {
        // Equal or Azure stronger -> Azure is primary
        primaryTwo = "AZURE";
        secondaryTwo = "GCP";
      }
    } else if (cloudPairs.includes("AWS") && cloudPairs.includes("GCP")) {
      // AWS + GCP without Azure -> DO NOT inject Azure!
      if (gcpScore > awsScore) {
        primaryTwo = "GCP";
        secondaryTwo = "AWS";
      } else {
        // AWS stronger or tied -> AWS is primary (tie-breaker)
        primaryTwo = "AWS";
        secondaryTwo = "GCP";
      }
    } else {
      // Fallback pair if not parsed
      primaryTwo = awsScore > azureScore ? "AWS" : "AZURE";
      secondaryTwo = primaryTwo === "AZURE" ? "AWS" : "AZURE";
    }

    technicalEmployers.forEach((emp, idx) => {
      // For 3 employers: Emp 1 -> primary, Emp 2 -> primary, Emp 3 -> secondary
      const isSecondary = idx === technicalEmployers.length - 1 && technicalEmployers.length >= 2;
      const assignedCloud = isSecondary ? secondaryTwo : primaryTwo;
      employerCloudAssignments.push({
        employer: emp,
        cloud: assignedCloud,
        reason: isSecondary
          ? `Secondary cloud (${secondaryTwo}) for multi-cloud breadth under ${emp}.`
          : `Primary cloud (${primaryTwo}) with dominant JD requirement weight under ${emp}.`,
      });
    });
  } else {
    // TRUE_MULTI_CLOUD (3 clouds)
    // Sort clouds by score descending with tie-breakers Azure -> AWS -> GCP
    const order: Record<"AZURE" | "AWS" | "GCP", number> = { AZURE: 0, AWS: 1, GCP: 2 };
    const rankedClouds: Array<"AZURE" | "AWS" | "GCP"> = (["AZURE", "AWS", "GCP"] as Array<"AZURE" | "AWS" | "GCP">).sort((a, b) => {
      const scoreA = a === "AWS" ? awsScore : a === "AZURE" ? azureScore : gcpScore;
      const scoreB = b === "AWS" ? awsScore : b === "AZURE" ? azureScore : gcpScore;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return order[a] - order[b];
    });

    technicalEmployers.forEach((emp, idx) => {
      const assignedCloud = rankedClouds[idx % rankedClouds.length];
      employerCloudAssignments.push({
        employer: emp,
        cloud: assignedCloud,
        reason: `Multi-cloud rank ${idx + 1} ecosystem (${assignedCloud}) allocated to ${emp}.`,
      });
    });
  }

  return {
    targetEcosystem,
    primaryPlatform,
    supportingCloud,
    primaryCloud,
    cloudRequirementMode,
    cloudsExplicitlyMentioned: [...new Set(cloudsExplicitlyMentioned)],
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
    cloudSignals,
    platformSignals,
    employerCloudAssignments,
    reasoning,
  };
}

/**
 * Writer-facing guidance for the Target Ecosystem Strategy.
 */
export function renderTargetEcosystemSection(result: TargetEcosystemResult): string {
  const { targetEcosystem, primaryPlatform, supportingCloud, cloudRequirementMode, confidence, reasoning, employerCloudAssignments = [] } = result;

  let out = `## TARGET ECOSYSTEM STRATEGY: ${targetEcosystem} (Confidence: ${confidence})\n\n`;
  out += `**Directive:** ${reasoning}\n\n`;
  out += `- **Primary Ecosystem Focus:** Emphasize **${targetEcosystem}** architectures across Summary, Skills, and Experience.\n`;
  if (cloudRequirementMode) out += `- **Cloud Mode:** ${cloudRequirementMode}\n`;
  if (primaryPlatform) out += `- **Platform Focus:** **${primaryPlatform}** (Lead with ${primaryPlatform} platform architecture)\n`;
  if (supportingCloud) out += `- **Supporting Cloud:** **${supportingCloud}**\n`;

  if (employerCloudAssignments.length > 0) {
    out += `\n**Employer Cloud Allocations:**\n`;
    for (const alloc of employerCloudAssignments) {
      out += `- **${alloc.employer}:** **${alloc.cloud}** (${alloc.reason})\n`;
    }
  }

  out += `\n- **Cloud Substitution Rule:** Where MSI evidence supports it, represent workflows using approved ${targetEcosystem} equivalent services.\n`;
  out += `- **Architecture Coherence:** Each employer must follow its assigned architecture palette without unmigrated competing cloud services.\n`;
  out += `- **Cloud-Neutral Foundations:** Databricks, Snowflake, Python, SQL, PySpark, Spark, Delta Lake, dbt, Kafka, Airflow, Terraform, Docker, CI/CD are available when backed by evidence.\n`;

  return out;
}
