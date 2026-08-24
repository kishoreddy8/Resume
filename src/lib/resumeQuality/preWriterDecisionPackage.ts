import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import {
  detectTargetEcosystem,
  renderTargetEcosystemSection,
  type CloudRequirementMode,
  type EmployerCloudAssignment,
  type CloudSignalProvenance,
  type PlatformSignalProvenance,
} from "./targetEcosystem";
import {
  evaluateJdToolCoveragePlan,
  buildCandidateGlobalCapabilitySet,
} from "./jdToolCoverage";
import {
  buildEmployerArchitecturePalettes,
  renderArchitecturePaletteSection,
  type EmployerArchitecturePalette,
} from "./architecturePalette";
import {
  evaluateTechnologyCompatibility,
} from "./technologyCompatibility";
import {
  buildCandidateAccomplishmentPackageSync,
  renderAccomplishmentEvidenceSection,
} from "./accomplishmentEvidence";
import {
  extractWriterJobIntent,
  renderWriterJobIntentSection,
} from "./jobIntent";
import {
  mapJdPrioritiesToCandidateEvidence,
  renderJdEvidenceMappingSection,
} from "./jobEvidenceMapping";
import {
  reconcileJdRequirements,
  canonicalRequirementsToRequirementUnits,
  renderCanonicalRequirementSection,
  getReconciledUnsupportedNames,
  type CanonicalJdRequirement,
  type JdIntelligenceCompleteness,
} from "./jdRequirementReconciler";
import { buildJdPriorityMatrix } from "./jdPriorityMatrix";
import { buildExternalWriterPrompt } from "./handoff/exporter";

export interface PreWriterDecisionPackage {
  candidate: {
    id: number;
    name: string;
  };
  job: {
    id: number | null;
    company: string;
    role: string;
    dedupeKey?: string;
  };
  ecosystemDecision: {
    classification: string;
    primaryPlatform: string | null;
    supportingCloud: string;
    cloudsExplicitlyMentioned: string[];
    cloudRequirementMode: CloudRequirementMode;
    scores: {
      aws: number;
      azure: number;
      gcp: number;
      snowflake: number;
      databricks: number;
    };
    confidence: string;
    reason: string;
  };
  cloudSignals: CloudSignalProvenance[];
  platformSignals: PlatformSignalProvenance[];
  canonicalRequirements: CanonicalJdRequirement[];
  jdIntelligenceCompleteness: JdIntelligenceCompleteness;
  employerCloudAssignments: EmployerCloudAssignment[];
  jdToolCoverage: Array<{
    tool: string;
    priority: string;
    supported: boolean;
    source: string;
    writerAction: "PASS_TO_WRITER" | "DO_NOT_CLAIM";
  }>;
  doNotClaim: string[];
  neutralCapabilitiesSelected: string[];
  employerArchitecturePalettes: EmployerArchitecturePalette[];
  technologySubstitutions: Array<{
    employer: string;
    capabilityFamily: string;
    from: string;
    to: string;
    reason: string;
  }>;
  compatibilityChecks: {
    isCompatible: boolean;
    score: number;
    blockingFindingsCount: number;
    warningsCount: number;
    findings: Array<{
      severity: "BLOCKING" | "WARNING";
      code: string;
      scope: "EMPLOYER" | "PALETTE" | "RESUME" | "SECTION";
      employer?: string;
      field?: string;
      location: string;
      type: string;
      technologies: string[];
      message: string;
      reason: string;
      recommendedAction?: string;
      description: string;
    }>;
    scoreBreakdown: {
      startingScore: number;
      deductions: Array<{
        code: string;
        points: number;
        reason: string;
        findingSeverity: "BLOCKING" | "WARNING";
      }>;
      finalScore: number;
    };
  };
  promptBudget: {
    bytes: number;
    estimatedTokens: number;
  };
}

/**
 * Builds the deterministic pre-writer diagnostic decision package without invoking Claude.
 */
export function buildPreWriterDecisionPackage(params: {
  candidateId: number;
  candidateName: string;
  candidateProfile: CandidateProfile;
  jobId?: number | null;
  companyName: string;
  roleTitle: string;
  dedupeKey?: string;
  jobDescriptionText?: string;
  jobRequirements?: RequirementUnit[];
}): PreWriterDecisionPackage {
  const {
    candidateId,
    candidateName,
    candidateProfile,
    jobId = null,
    companyName,
    roleTitle,
    dedupeKey,
    jobDescriptionText = "",
    jobRequirements = [],
  } = params;

  // 1. Reconcile Raw JD with Structured Requirements (Phase 6.2 Completeness)
  const reconciliation = reconcileJdRequirements({
    rawJd: jobDescriptionText,
    structuredRequirements: jobRequirements,
    candidateProfile,
    roleTitle,
  });

  // PHASE 6.3A — the canonical, reconciled inventory becomes the SINGLE authoritative requirement
  // view for every downstream decision below (this mirrors handoff/exporter.ts's own live-path
  // wiring exactly, so this offline package reflects the same requirement view production actually
  // uses — never a second, independently-ranked view of the same JD).
  const canonicalRequirementUnits = canonicalRequirementsToRequirementUnits(reconciliation.canonicalRequirements);

  // 2. Target Ecosystem & Cloud Allocations
  const ecosystemResult = detectTargetEcosystem({
    company: companyName,
    roleTitle,
    jobDescriptionText,
    jobRequirements: canonicalRequirementUnits,
    candidateProfile,
  });

  // 3. JD Tool Coverage & Global MSI Capabilities
  const coveragePlan = evaluateJdToolCoveragePlan({
    candidateProfile,
    jobRequirements: canonicalRequirementUnits,
  });

  // 4. Narrow Architecture Palettes
  const reconciledUnsupportedNames = getReconciledUnsupportedNames(reconciliation.canonicalRequirements);
  const palettes = buildEmployerArchitecturePalettes({
    candidateProfile,
    targetEcosystem: ecosystemResult,
    coveragePlan,
    jobRequirements: canonicalRequirementUnits,
    authoritativeUnsupportedTools: reconciledUnsupportedNames,
  });

  // 5. Global MSI Neutral Capabilities Selected
  const allNeutral = [
    "Databricks", "Snowflake", "Python", "SQL", "PySpark", "Apache Spark",
    "Delta Lake", "dbt", "Kafka", "Airflow", "Terraform", "Docker", "CI/CD",
    "Git", "Dimensional Modeling", "Data Validation & Quality", "Microsoft Purview",
  ];
  const { canonicalSet } = buildCandidateGlobalCapabilitySet(candidateProfile);
  const neutralSelected = allNeutral.filter((t) => canonicalSet.has(t.toLowerCase()));

  // 6. Build Comprehensive Tool and Capability Coverage Summary
  const jdToolCoverage: PreWriterDecisionPackage["jdToolCoverage"] = reconciliation.canonicalRequirements.map((req) => ({
    tool: req.canonicalName,
    priority: req.priority,
    supported: req.supportedByCandidate,
    source: req.candidateEvidenceSources.join(" + ") || "MSI Capability",
    writerAction: req.writerAction,
  }));

  // PHASE 6.3A — reconciledUnsupportedNames (the reconciler's own writerAction === "DO_NOT_CLAIM")
  // is the sole, authoritative source here. coveragePlan.allUnsupportedTools is deliberately NOT
  // unioned in: since coveragePlan is now driven by the same canonical requirement set, anything it
  // additionally flags as unsupported is exactly the taxonomy-recognition gap
  // canonicalRequirementsToRequirementUnits's doc comment describes (a false positive for a
  // capability/architecture name), never a real gap the reconciler's own broader msiMatchKeys support
  // check would have missed.
  const allDoNotClaim = [...new Set(reconciledUnsupportedNames)];

  // 7. Technology Substitutions
  const substitutions: PreWriterDecisionPackage["technologySubstitutions"] = [];
  for (const pal of palettes) {
    if (pal.employerCloud === "AWS") {
      substitutions.push({
        employer: pal.employer,
        capabilityFamily: "ORCHESTRATION",
        from: "Azure Data Factory",
        to: "AWS Glue",
        reason: `Ecosystem target for ${pal.employer} is AWS. ADF transformed to AWS Glue preserving multi-source ingestion.`,
      });
      substitutions.push({
        employer: pal.employer,
        capabilityFamily: "STORAGE",
        from: "ADLS Gen2",
        to: "Amazon S3",
        reason: `Storage layer aligned with Amazon S3.`,
      });
    } else if (pal.employerCloud === "GCP") {
      substitutions.push({
        employer: pal.employer,
        capabilityFamily: "ORCHESTRATION",
        from: "Azure Data Factory",
        to: "Cloud Data Fusion",
        reason: `Ecosystem target for ${pal.employer} is GCP. ADF transformed to Cloud Data Fusion.`,
      });
      substitutions.push({
        employer: pal.employer,
        capabilityFamily: "STORAGE",
        from: "ADLS Gen2",
        to: "Google Cloud Storage",
        reason: `Storage layer aligned with Google Cloud Storage.`,
      });
    }
  }

  // 8. Simulated Resume Compatibility Check
  const dedupedVisibleSkills = Array.from(
    new Set(palettes.flatMap((p) => [...p.warehouses, ...p.orchestration]))
  ).slice(0, 8);

  const simulatedResume = {
    name: candidateName,
    tagline: "Senior Data Engineer",
    location: "Dallas, TX",
    phone: "9452370560",
    email: "saireddy2898@gmail.com",
    summary: ["Senior Data Engineer building reliable cloud data platforms."],
    skillGroups: [
      {
        label: "Data Warehousing & Cloud Platforms",
        items: dedupedVisibleSkills,
      },
      {
        label: "Architecture & Engineering Practices",
        items: ["Dimensional Modeling", "Data Validation & Quality", "CI/CD", "Git"],
      },
    ],
    experience: palettes.map((p) => ({
      company: p.employer,
      title: p.title,
      dates: `${p.startDate || "2023-01"} - ${p.endDate || "Present"}`,
      startDate: p.startDate || "2023-01",
      endDate: p.endDate || "Present",
      environment: [...p.orchestration, ...p.storage, ...p.warehouses, ...p.languages].slice(0, 6),
      bullets: [
        `Engineered scalable data pipelines using ${p.orchestration[0] || "Airflow"} and ${p.storage[0] || "cloud storage"} to deliver analytics datasets for ${p.employer}.`,
      ],
    })),
    education: [],
    certifications: [],
  };

  const compatResult = evaluateTechnologyCompatibility(simulatedResume, candidateProfile, ecosystemResult);

  // 9. Estimate Prompt Budget
  const accomplishmentPackage = buildCandidateAccomplishmentPackageSync({
    candidateId,
    candidateProfile,
  });
  const jobIntent = extractWriterJobIntent({
    company: companyName,
    roleTitle,
    jobDescriptionText,
    jobRequirements: canonicalRequirementUnits,
  });
  const evidenceMapping = mapJdPrioritiesToCandidateEvidence({
    jobIntent,
    accomplishmentPackage,
  });
  const jdPriorityMatrix = buildJdPriorityMatrix(canonicalRequirementUnits, roleTitle, candidateProfile);

  const promptMd = buildExternalWriterPrompt({
    candidateId,
    candidateName,
    applicationId: 1,
    jobId,
    tailoringRunId: 1,
    workflowId: 1,
    iterationNumber: 1,
    selectedTrack: roleTitle,
    jobIntentSection: renderWriterJobIntentSection(jobIntent),
    accomplishmentEvidenceSection: renderAccomplishmentEvidenceSection(accomplishmentPackage),
    targetEcosystemSection: renderTargetEcosystemSection(ecosystemResult),
    jdToolCoverageSection: renderCanonicalRequirementSection(reconciliation),
    architecturePaletteSection: renderArchitecturePaletteSection(palettes),
    jdEvidenceMappingSection: renderJdEvidenceMappingSection(evidenceMapping),
    jdPriorityMatrix,
  });

  const promptBytes = Buffer.byteLength(promptMd, "utf-8");
  const estimatedTokens = Math.ceil(promptBytes / 4);

  return {
    candidate: {
      id: candidateId,
      name: candidateName,
    },
    job: {
      id: jobId,
      company: companyName,
      role: roleTitle,
      ...(dedupeKey ? { dedupeKey } : {}),
    },
    ecosystemDecision: {
      classification: ecosystemResult.targetEcosystem,
      primaryPlatform: ecosystemResult.primaryPlatform,
      supportingCloud: ecosystemResult.supportingCloud,
      cloudsExplicitlyMentioned: ecosystemResult.cloudsExplicitlyMentioned,
      cloudRequirementMode: ecosystemResult.cloudRequirementMode,
      scores: ecosystemResult.scores,
      confidence: ecosystemResult.confidence,
      reason: ecosystemResult.reasoning,
    },
    cloudSignals: ecosystemResult.cloudSignals ?? [],
    platformSignals: ecosystemResult.platformSignals ?? [],
    canonicalRequirements: reconciliation.canonicalRequirements,
    jdIntelligenceCompleteness: reconciliation.completeness,
    employerCloudAssignments: ecosystemResult.employerCloudAssignments,
    jdToolCoverage,
    doNotClaim: allDoNotClaim,
    neutralCapabilitiesSelected: neutralSelected,
    employerArchitecturePalettes: palettes,
    technologySubstitutions: substitutions,
    compatibilityChecks: {
      isCompatible: compatResult.isCompatible,
      score: compatResult.score,
      blockingFindingsCount: compatResult.blockingFindings.length,
      warningsCount: compatResult.warnings.length,
      findings: compatResult.findings.map((f) => ({
        severity: f.severity,
        code: f.code,
        scope: f.scope,
        employer: f.employer,
        field: f.field,
        location: f.location,
        type: f.contradictionType,
        technologies: f.technologies,
        message: f.message,
        reason: f.reason,
        recommendedAction: f.recommendedAction,
        description: f.description,
      })),
      scoreBreakdown: compatResult.scoreBreakdown,
    },
    promptBudget: {
      bytes: promptBytes,
      estimatedTokens,
    },
  };
}

/**
 * Renders the human-readable Markdown preflight decision report.
 */
export function renderPreWriterDecisionReport(pkg: PreWriterDecisionPackage): string {
  let out = `# Career-Ops Phase 6.2 Pre-Writer Diagnostic Decision Report\n\n`;
  out += `**Candidate:** ${pkg.candidate.name} (ID: ${pkg.candidate.id})\n`;
  out += `**Target Job:** ${pkg.job.role} at **${pkg.job.company}** (ID: ${pkg.job.id ?? "N/A"}${pkg.job.dedupeKey ? ` | Dedupe: ${pkg.job.dedupeKey}` : ""})\n\n`;

  out += `## 1. Target Ecosystem & Signal Provenance Decision\n`;
  out += `- **Classification:** **${pkg.ecosystemDecision.classification}** (Confidence: ${pkg.ecosystemDecision.confidence})\n`;
  out += `- **Primary Platform:** ${pkg.ecosystemDecision.primaryPlatform ?? "(none)"}\n`;
  out += `- **Supporting Cloud:** **${pkg.ecosystemDecision.supportingCloud}**\n`;
  out += `- **Cloud Requirement Mode:** **${pkg.ecosystemDecision.cloudRequirementMode}**\n`;
  out += `- **Clouds Mentioned in JD:** ${pkg.ecosystemDecision.cloudsExplicitlyMentioned.join(", ") || "(none)"}\n`;
  out += `- **Cloud Scores:** AWS: ${pkg.ecosystemDecision.scores.aws}, Azure: ${pkg.ecosystemDecision.scores.azure}, GCP: ${pkg.ecosystemDecision.scores.gcp}, Snowflake: ${pkg.ecosystemDecision.scores.snowflake}, Databricks: ${pkg.ecosystemDecision.scores.databricks}\n`;
  out += `- **Rationale:** ${pkg.ecosystemDecision.reason}\n\n`;

  if (pkg.platformSignals.length > 0) {
    out += `### Platform Signal Provenance:\n`;
    for (const ps of pkg.platformSignals) {
      out += `- **[${ps.platform}]** (${ps.priority}, Contribution: +${ps.scoreContribution}, Source: \`${ps.source}\`): "${ps.rawText}"\n`;
    }
    out += `\n`;
  }

  if (pkg.cloudSignals.length > 0) {
    out += `### Cloud Signal Provenance:\n`;
    for (const cs of pkg.cloudSignals) {
      out += `- **[${cs.provider}]** (${cs.priority}, Contribution: +${cs.scoreContribution}, Source: \`${cs.source}\`): "${cs.rawText}"\n`;
    }
    out += `\n`;
  }

  out += `## 2. Employer-by-Employer Cloud Assignments\n`;
  for (const alloc of pkg.employerCloudAssignments) {
    out += `- **${alloc.employer}:** **${alloc.cloud}** — ${alloc.reason}\n`;
  }
  out += "\n";

  out += `## 3. JD Intelligence Completeness & Canonical Requirement Inventory\n`;
  out += `- **Total Material Requirements:** ${pkg.jdIntelligenceCompleteness.totalMaterialRequirements} (Technologies: ${pkg.jdIntelligenceCompleteness.technologyRequirementsCount}, Capabilities: ${pkg.jdIntelligenceCompleteness.capabilityRequirementsCount}, Architectures: ${pkg.jdIntelligenceCompleteness.architectureRequirementsCount})\n`;
  out += `- **Priority Breakdown:** P1 (Critical): ${pkg.jdIntelligenceCompleteness.p1Count} | P2 (Required): ${pkg.jdIntelligenceCompleteness.p2Count} | P3 (Preferred): ${pkg.jdIntelligenceCompleteness.p3Count} | P4 (Bonus): ${pkg.jdIntelligenceCompleteness.p4Count}\n`;
  out += `- **Candidate Support:** Supported Material: ${pkg.jdIntelligenceCompleteness.supportedMaterialCount}/${pkg.jdIntelligenceCompleteness.totalMaterialRequirements} | Gated (DO_NOT_CLAIM): ${pkg.jdIntelligenceCompleteness.doNotClaimCount}\n`;
  out += `- **Completeness Status:** ${pkg.jdIntelligenceCompleteness.isComplete ? "COMPLETE (0 unresolved gaps)" : "INCOMPLETE"}\n\n`;

  out += `### Canonical Requirements Detail:\n`;
  for (const req of pkg.canonicalRequirements) {
    out += `- **[${req.priority}] ${req.canonicalName}** (\`${req.kind}\` | Source: \`${req.source}\`)\n`;
    out += `  - **Action:** \`${req.writerAction}\` | Expectation: \`${req.coverageExpectation}\`\n`;
    out += `  - **Supported:** ${req.supportedByCandidate ? `YES (${req.candidateEvidenceSources.join(", ")})` : `NO (${req.gatedReason})`}\n`;
  }
  out += "\n";

  out += `## 4. DO_NOT_CLAIM Tools & Gated Capabilities\n`;
  if (pkg.doNotClaim.length === 0) {
    out += `- *(None — all requested tools supported)*\n`;
  } else {
    for (const t of pkg.doNotClaim) {
      out += `- **${t}** (Gated: Absent from Global MSI and candidate experience record)\n`;
    }
  }
  out += "\n";

  out += `## 5. Selected Neutral Capabilities\n`;
  out += `${pkg.neutralCapabilitiesSelected.join(", ")}\n\n`;

  out += `## 6. Approved Narrow Employer Architecture Palettes\n`;
  for (const pal of pkg.employerArchitecturePalettes) {
    out += `### ${pal.employer} (${pal.title}) — [Assigned Cloud: ${pal.employerCloud}]\n`;
    out += `- **Sources:** ${pal.sources.join(", ") || "(none)"}\n`;
    out += `- **Orchestration:** ${pal.orchestration.join(", ") || "(none)"}\n`;
    out += `- **Storage:** ${pal.storage.join(", ") || "(none)"}\n`;
    out += `- **Processing:** ${pal.processing.join(", ") || "(none)"}\n`;
    out += `- **Warehouses:** ${pal.warehouses.join(", ") || "(none)"}\n`;
    out += `- **Languages & DevOps:** ${[...pal.languages, ...pal.devops].join(", ") || "(none)"}\n`;
    if (pal.prohibitedCombinations.length > 0) {
      out += `- **Prohibited Stacks:** ${pal.prohibitedCombinations.join("; ")}\n`;
    }
    out += "\n";
  }

  out += `## 7. Technology Substitutions\n`;
  if (pkg.technologySubstitutions.length === 0) {
    out += `- *(Native stack used directly; no cloud substitutions required)*\n`;
  } else {
    for (const s of pkg.technologySubstitutions) {
      out += `- **${s.employer} [${s.capabilityFamily}]**: \`${s.from}\` -> \`${s.to}\` (${s.reason})\n`;
    }
  }
  out += "\n";

  out += `## 8. Compatibility Findings & Prompt Budget\n`;
  out += `- **Compatibility Verdict:** ${pkg.compatibilityChecks.isCompatible ? "PASS" : "FAIL"} (Score: ${pkg.compatibilityChecks.score}/100, Blocking: ${pkg.compatibilityChecks.blockingFindingsCount}, Warnings: ${pkg.compatibilityChecks.warningsCount})\n`;
  out += `- **Score Breakdown:** Starting: ${pkg.compatibilityChecks.scoreBreakdown.startingScore} pts | Total Deductions: -${pkg.compatibilityChecks.scoreBreakdown.startingScore - pkg.compatibilityChecks.scoreBreakdown.finalScore} pts | Final Score: ${pkg.compatibilityChecks.scoreBreakdown.finalScore}/100\n`;
  if (pkg.compatibilityChecks.scoreBreakdown.deductions.length > 0) {
    out += `  **Deduction Details:**\n`;
    for (const d of pkg.compatibilityChecks.scoreBreakdown.deductions) {
      out += `  - [${d.findingSeverity}] \`${d.code}\`: -${d.points} pts — ${d.reason}\n`;
    }
  }
  if (pkg.compatibilityChecks.findings.length > 0) {
    out += `\n### Detailed Compatibility Findings:\n`;
    for (const f of pkg.compatibilityChecks.findings) {
      out += `- **[${f.severity}] \`${f.code}\`** (Scope: ${f.scope}${f.employer ? ` / ${f.employer}` : ""})\n`;
      out += `  - **Location:** ${f.location}\n`;
      out += `  - **Technologies:** ${f.technologies.join(", ")}\n`;
      out += `  - **Message:** ${f.message}\n`;
      out += `  - **Reason:** ${f.reason}\n`;
      if (f.recommendedAction) {
        out += `  - **Recommended Action:** ${f.recommendedAction}\n`;
      }
    }
  }
  out += `\n- **Active Writer Prompt Bytes:** ${pkg.promptBudget.bytes.toLocaleString()} bytes\n`;
  out += `- **Estimated Active Prompt Tokens:** ~${pkg.promptBudget.estimatedTokens.toLocaleString()} tokens (Target Budget: $\\le 6,500$ tokens)\n`;
  out += `- **Budget Compliance:** ${pkg.promptBudget.estimatedTokens <= 6500 ? "PASS" : "OVER_BUDGET"}\n`;

  return out;
}
