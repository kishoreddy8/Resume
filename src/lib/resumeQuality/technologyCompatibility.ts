import type { CandidateProfile } from "@/lib/match/types";
import type { ResumeContent } from "../../../tools/tailoring-engine/types";
import { extractCanonicalSkillsFromText } from "./reviewers/skillAliases";
import { findAliasDuplicates } from "./technologyClassification";
import { buildCandidateGlobalCapabilitySet } from "./jdToolCoverage";
import { type TargetEcosystemResult } from "./targetEcosystem";

export interface ArchitectureContradictionFinding {
  location: string;
  contradictionType:
    | "COMPETING_ORCHESTRATORS"
    | "COMPETING_WAREHOUSES"
    | "COMPETING_STORAGE"
    | "COMPETING_STREAMING"
    | "COMPETING_KUBERNETES"
    | "ALIAS_DUPLICATION"
    | "UNSUPPORTED_CAPABILITY"
    | "TARGET_ECOSYSTEM_DRIFT";
  technologies: string[];
  description: string;
  severity: "BLOCKING" | "WARNING";
}

export interface TechnologyCompatibilityResult {
  isCompatible: boolean;
  score: number;
  findings: ArchitectureContradictionFinding[];
  blockingFindings: ArchitectureContradictionFinding[];
  warnings: ArchitectureContradictionFinding[];
}

const MIGRATION_SIGNAL_RE = /\b(migrat\w*|moved to|transition\w*|replatform\w*|cross-cloud|coexist\w*|hybrid\s+cloud|legacy\s+to)\b/i;

export function hasMigrationSignal(text: string): boolean {
  return MIGRATION_SIGNAL_RE.test(text);
}

/**
 * Validates a single text block (e.g. experience bullet) for architecture compatibility.
 */
export function validateBulletArchitecture(bullet: string): ArchitectureContradictionFinding[] {
  const findings: ArchitectureContradictionFinding[] = [];
  if (!bullet || bullet.trim().length === 0) return findings;

  // If explicit migration/integration signal is present, multiple cloud services are legitimate
  if (hasMigrationSignal(bullet)) return findings;

  // 1. Check competing orchestrators
  const foundOrchestrators: string[] = [];
  if (/\b(azure data factory|adf)\b/i.test(bullet)) foundOrchestrators.push("Azure Data Factory");
  if (/\b(aws glue|glue)\b/i.test(bullet)) foundOrchestrators.push("AWS Glue");
  if (/\b(cloud data fusion|data fusion)\b/i.test(bullet)) foundOrchestrators.push("Cloud Data Fusion");
  if (/\binformatica\b/i.test(bullet)) foundOrchestrators.push("Informatica");
  if (foundOrchestrators.length >= 2) {
    findings.push({
      location: bullet,
      contradictionType: "COMPETING_ORCHESTRATORS",
      technologies: foundOrchestrators,
      description: `Competing ETL/orchestration engines (${foundOrchestrators.join(", ")}) used in the same pipeline without migration or integration context.`,
      severity: "BLOCKING",
    });
  }

  // 2. Check competing primary warehouses
  const foundWarehouses: string[] = [];
  if (/\b(azure synapse|synapse)\b/i.test(bullet)) foundWarehouses.push("Azure Synapse Analytics");
  if (/\b(amazon redshift|redshift)\b/i.test(bullet)) foundWarehouses.push("Amazon Redshift");
  if (/\b(google bigquery|bigquery)\b/i.test(bullet)) foundWarehouses.push("BigQuery");
  if (foundWarehouses.length >= 2) {
    findings.push({
      location: bullet,
      contradictionType: "COMPETING_WAREHOUSES",
      technologies: foundWarehouses,
      description: `Competing cloud data warehouses (${foundWarehouses.join(", ")}) positioned as primary in the same architecture without migration context.`,
      severity: "BLOCKING",
    });
  }

  // 3. Check competing storage layers
  const foundStorage: string[] = [];
  if (/\badls(\s+gen2)?\b/i.test(bullet)) foundStorage.push("ADLS Gen2");
  if (/\b(amazon\s+)?s3\b/i.test(bullet)) foundStorage.push("Amazon S3");
  if (/\b(google cloud storage|gcs)\b/i.test(bullet)) foundStorage.push("Google Cloud Storage");
  if (foundStorage.length >= 2) {
    findings.push({
      location: bullet,
      contradictionType: "COMPETING_STORAGE",
      technologies: foundStorage,
      description: `Competing primary object storage systems (${foundStorage.join(", ")}) used together without migration context.`,
      severity: "BLOCKING",
    });
  }

  // 4. Check competing Kubernetes engines
  const k8s = ["aks", "eks", "gke"];
  const foundK8s = k8s.filter((k) => new RegExp(`\\b${k}\\b`, "i").test(bullet));
  if (foundK8s.length >= 2) {
    findings.push({
      location: bullet,
      contradictionType: "COMPETING_KUBERNETES",
      technologies: foundK8s,
      description: `Competing managed Kubernetes platforms (${foundK8s.join(", ")}) combined in the same bullet.`,
      severity: "BLOCKING",
    });
  }

  return findings;
}

/**
 * Comprehensive evaluation of technology compatibility across entire resume.
 */
export function evaluateTechnologyCompatibility(
  resume: ResumeContent,
  masterResumeProfile?: CandidateProfile,
  targetEcosystem?: TargetEcosystemResult
): TechnologyCompatibilityResult {
  const findings: ArchitectureContradictionFinding[] = [];

  const { canonicalSet } = masterResumeProfile
    ? buildCandidateGlobalCapabilitySet(masterResumeProfile)
    : { canonicalSet: new Set<string>() };

  // 1. Validate individual bullets
  for (const exp of resume.experience ?? []) {
    for (const bullet of exp.bullets ?? []) {
      const bulletFindings = validateBulletArchitecture(bullet);
      for (const f of bulletFindings) {
        findings.push({
          ...f,
          location: `At ${exp.company}: "${bullet.slice(0, 80)}..."`,
        });
      }
    }
  }

  // 2. Validate alias duplicates in skills and bullets
  const allSkills = [
    ...(resume.skillGroups ?? []).flatMap((g) => g.items),
  ];
  const duplicateSkills = findAliasDuplicates(allSkills);
  for (const dup of duplicateSkills) {
    findings.push({
      location: `Skills Section`,
      contradictionType: "ALIAS_DUPLICATION",
      technologies: dup.duplicates,
      description: `Duplicate alias representations of "${dup.canonical}" found in visible skills (${dup.duplicates.join(", ")}).`,
      severity: "WARNING",
    });
  }

  // 3. Validate unsupported capabilities (absent from both MSI and candidate profile)
  if (masterResumeProfile) {
    const fullText = [
      ...(resume.skillGroups ?? []).flatMap((g) => g.items),
      ...(resume.experience ?? []).flatMap((e) => [
        ...(e.environment ?? []),
        ...e.bullets,
      ]),
    ].join("\n");

    const claimed = extractCanonicalSkillsFromText(fullText);
    for (const skill of claimed) {
      const key = skill.toLowerCase();
      if (!canonicalSet.has(key)) {
        findings.push({
          location: `Resume Claims`,
          contradictionType: "UNSUPPORTED_CAPABILITY",
          technologies: [skill],
          description: `Technology "${skill}" has no backing in candidate's Master Skills Inventory or experience record.`,
          severity: "BLOCKING",
        });
      }
    }
  }

  // 4. Validate Target Ecosystem Drift
  if (targetEcosystem && targetEcosystem.confidence === "HIGH" && targetEcosystem.primaryCloud !== "CLOUD_NEUTRAL" && targetEcosystem.primaryCloud !== "MULTI_CLOUD") {
    const targetCloud = targetEcosystem.primaryCloud;
    const fullResumeText = JSON.stringify(resume).toLowerCase();

    const awsCount = (fullResumeText.match(/\b(aws|glue|s3|redshift|emr|athena)\b/g) || []).length;
    const azureCount = (fullResumeText.match(/\b(azure|data factory|adls|synapse)\b/g) || []).length;
    const gcpCount = (fullResumeText.match(/\b(gcp|bigquery|data fusion|dataproc)\b/g) || []).length;

    if (targetCloud === "AWS" && awsCount === 0 && azureCount >= 5) {
      findings.push({
        location: `Resume Positioning`,
        contradictionType: "TARGET_ECOSYSTEM_DRIFT",
        technologies: ["Azure"],
        description: `Target JD strongly requests AWS (${targetEcosystem.scores.aws} pts), but resume remains exclusively Azure-branded despite candidate holding AWS MSI capabilities.`,
        severity: "WARNING",
      });
    } else if (targetCloud === "AZURE" && azureCount === 0 && awsCount >= 5) {
      findings.push({
        location: `Resume Positioning`,
        contradictionType: "TARGET_ECOSYSTEM_DRIFT",
        technologies: ["AWS"],
        description: `Target JD strongly requests Azure (${targetEcosystem.scores.azure} pts), but resume remains exclusively AWS-branded.`,
        severity: "WARNING",
      });
    } else if (targetCloud === "GCP" && gcpCount === 0 && (awsCount >= 5 || azureCount >= 5)) {
      findings.push({
        location: `Resume Positioning`,
        contradictionType: "TARGET_ECOSYSTEM_DRIFT",
        technologies: ["GCP"],
        description: `Target JD strongly requests GCP (${targetEcosystem.scores.gcp} pts), but resume contains no GCP ecosystem presence.`,
        severity: "WARNING",
      });
    }
  }

  const blockingFindings = findings.filter((f) => f.severity === "BLOCKING");
  const warnings = findings.filter((f) => f.severity === "WARNING");

  let score = 100;
  score -= blockingFindings.length * 40;
  score -= warnings.length * 10;
  score = Math.max(0, Math.min(100, score));

  return {
    isCompatible: blockingFindings.length === 0,
    score,
    findings,
    blockingFindings,
    warnings,
  };
}
