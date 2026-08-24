import type {
  CoverLetterContent,
  ResumeContent,
} from "./types";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { VerifiedCandidateContact } from "./candidateContact";
import type { RepairPlan } from "./repairScope";
import type { CandidateAccomplishmentPackage } from "./accomplishmentEvidence";
import type { WriterJobIntent } from "./jobIntent";
import type { JdEvidenceMappingResult } from "./jobEvidenceMapping";
import { deriveProfessionalIdentity } from "./professionalIdentity";

/**
 * MINIMAL REPAIR CONTEXT COMPILER (Phase 5 Hardening)
 *
 * Assembles a dedicated, minimal, path-specific writer context for surgical TARGETED_REPAIR passes.
 * Unlike INITIAL_GENERATION (which receives rich full-resume accomplishment evidence and broad
 * styling contracts), TARGETED_REPAIR receives ONLY:
 * 1. The exact editable paths authorized for modification.
 * 2. Current text and specific reviewer findings for those paths.
 * 3. Bounded, employer-scoped accomplishment evidence and JD priorities matching those paths.
 * 4. A concise truthfulness and metric-inference contract.
 * 5. A strict JSON PATCH output schema.
 *
 * Crucially, companion files (previous_resume_content.json, master_resume_reference.json, etc.)
 * remain available on disk for the importer and audit inspection, but are NOT named as required
 * reading in writer_prompt.md, keeping Claude context within ~1,500-2,500 tokens.
 */

export interface BuildRepairWriterPromptParams {
  candidateId: number;
  candidateName: string;
  applicationId: number;
  jobId: number | null;
  tailoringRunId: number;
  workflowId: number;
  iterationNumber: number;
  targetRoleTitle?: string | null;
  companyName?: string | null;
  candidateContact?: VerifiedCandidateContact | null;
  repairPlan: RepairPlan;
  currentResume: ResumeContent | null;
  currentCoverLetter?: CoverLetterContent | null;
  candidateProfile?: CandidateProfile;
  jobRequirements?: RequirementUnit[];
  jobIntent?: WriterJobIntent;
  accomplishmentPackage?: CandidateAccomplishmentPackage;
  evidenceMapping?: JdEvidenceMappingResult;
  resolvedFindingKeys?: string[];
  contextManifestSection?: string;
  instructionsScopeNote?: string;
  coverLetterContextOmitted?: boolean;
}

/**
 * Normalizes a path string to standard dot-notation (e.g., 'resume.summary[0]' or 'summary[0]').
 */
export function normalizePathKey(path: string): string {
  return path.startsWith("resume.") ? path.slice(7) : path;
}

/**
 * Safely extracts the current value for a given editable path from the baseline resume.
 */
export function extractCurrentPathValue(resume: ResumeContent | null, path: string): string | object | null {
  if (!resume) return null;
  const norm = normalizePathKey(path);

  if (norm === "summary[0]" || norm === "summary") {
    return resume.summary && resume.summary.length > 0 ? resume.summary[0] : "";
  }
  if (norm === "skillGroups") {
    return resume.skillGroups ?? [];
  }
  if (norm === "tagline") {
    return resume.tagline ?? "";
  }

  // Parse experience paths e.g. experience[0].projectDescription, experience[1].bullets[2], experience[0].environment
  const expMatch = norm.match(/^experience\[(\d+)\]\.(projectDescription|environment|bullets\[(\d+)\]|bullets|title|company)/);
  if (expMatch) {
    const expIdx = parseInt(expMatch[1], 10);
    const role = resume.experience && resume.experience[expIdx];
    if (!role) return null;

    const subField = expMatch[2];
    if (subField === "projectDescription") return role.projectDescription ?? "";
    if (subField === "environment") return role.environment ?? [];
    if (subField === "title") return role.title ?? "";
    if (subField === "company") return role.company ?? "";

    const bulletMatch = subField.match(/^bullets\[(\d+)\]$/);
    if (bulletMatch) {
      const bIdx = parseInt(bulletMatch[1], 10);
      return role.bullets && role.bullets[bIdx] !== undefined ? role.bullets[bIdx] : "";
    }
    if (subField === "bullets") return role.bullets ?? [];
  }

  return null;
}

/**
 * Resolves the employer index and name from an editable path.
 */
export function getEmployerForPath(resume: ResumeContent | null, path: string): { index: number; name: string } | null {
  if (!resume || !resume.experience) return null;
  const norm = normalizePathKey(path);
  const match = norm.match(/^experience\[(\d+)\]/);
  if (!match) return null;
  const idx = parseInt(match[1], 10);
  const exp = resume.experience[idx];
  return exp ? { index: idx, name: exp.company } : null;
}

/**
 * Builds the minimal, surgical TARGETED_REPAIR prompt.
 */
export function buildRepairWriterPrompt(params: BuildRepairWriterPromptParams): string {
  const {
    candidateId,
    candidateName,
    applicationId,
    jobId,
    tailoringRunId,
    workflowId,
    iterationNumber,
    targetRoleTitle = "Senior Data Engineer",
    companyName = "Target Employer",
    candidateContact,
    repairPlan,
    currentResume,
    candidateProfile,
    jobIntent,
    accomplishmentPackage,
    evidenceMapping,
    resolvedFindingKeys = [],
    contextManifestSection,
    instructionsScopeNote,
    coverLetterContextOmitted,
  } = params;

  const rawEditablePaths = repairPlan.editablePaths && repairPlan.editablePaths.length > 0
    ? repairPlan.editablePaths
    : (repairPlan.operations || []).map((o) => o.editablePath);

  // Deduplicate and normalize editable paths
  const editablePaths = Array.from(new Set(rawEditablePaths));
  const normalizedPaths = editablePaths.map(normalizePathKey);

  const lines: string[] = [
    `# External Resume Writer Agent Task — Iteration ${iterationNumber} (Surgical Repair)`,
    "",
    `**Writer mode: TARGETED_REPAIR.**`,
    `Target Role: **${targetRoleTitle}** at **${companyName}**`,
    `Candidate: **${candidateName}**`,
    "",
  ];

  if (candidateContact) {
    lines.push("## CANDIDATE CONTACT DETAILS — VERIFIED HARD FACTS, REPRODUCE EXACTLY");
    lines.push("");
    lines.push(`- Name: ${candidateContact.name}`);
    lines.push(`- Email: ${candidateContact.email}`);
    lines.push(`- Phone: ${candidateContact.phone}`);
    lines.push(`- Location: ${candidateContact.location}`);
    if (candidateContact.linkedin) lines.push(`- LinkedIn: ${candidateContact.linkedin}`);
    if (candidateContact.github) lines.push(`- GitHub: ${candidateContact.github}`);
    lines.push("");
    lines.push("Hard facts: reproduce contact details exactly; never invent one that is missing or substitute placeholders.");
    lines.push("");
  }

  if (instructionsScopeNote) {
    lines.push(`- Canonical tailoring instructions: ${instructionsScopeNote}`);
    lines.push("");
  }

  if (coverLetterContextOmitted) {
    lines.push("- Cover letter: This repair does not touch the cover letter and no finding concerns it — previous_cover_letter_content.json is not included in this package. Do not reference or invent cover-letter content.");
    lines.push("");
  }

  if (contextManifestSection) {
    lines.push(contextManifestSection);
  }

  lines.push("## 1. SURGICAL REPAIR MANDATE & AUTHORIZED PATHS");
  lines.push("");
  lines.push("**Surgical repair, PATCH mode — return ONLY the changed values, never the full document**:");
  lines.push("- You are performing a targeted, surgical PATCH repair of specific authorized paths. You must output **PATCH operations only** modifying the exact paths listed below. All other sections of the resume are frozen.");
  lines.push("");
  lines.push("### Authorized Editable Paths & Current Content to Fix:");

  for (const rawPath of editablePaths) {
    const norm = normalizePathKey(rawPath);
    const fullPath = rawPath.startsWith("resume.") || rawPath.startsWith("coverLetter.") ? rawPath : `resume.${norm}`;
    const currentVal = extractCurrentPathValue(currentResume, norm);
    const empInfo = getEmployerForPath(currentResume, norm);
    const empHeader = empInfo ? ` (Employer: **${empInfo.name}**)` : "";

    lines.push(`#### Path: \`${norm}\` (full \`${fullPath}\`)${empHeader}`);

    if (typeof currentVal === "string") {
      lines.push(`- **Current Text**: "${currentVal}"`);
    } else if (Array.isArray(currentVal)) {
      lines.push(`- **Current Items**: ${JSON.stringify(currentVal)}`);
    } else if (currentVal !== null) {
      lines.push(`- **Current Structure**:\n\`\`\`json\n${JSON.stringify(currentVal, null, 2)}\n\`\`\``);
    }

    // Attach corresponding findings / root operations
    const baseSection = norm.replace(/\[\d+\]/g, "").split(".").pop() || norm;
    const relevantOps = (repairPlan.operations || []).filter(
      (op) => normalizePathKey(op.editablePath) === norm || normalizePathKey(op.editablePath) === rawPath
    );
    const relevantRoots = (repairPlan.rootFindings || []).filter(
      (rf) => relevantOps.some((op) => op.rootFinding === rf.key) ||
              rf.description.toLowerCase().includes(norm.toLowerCase()) ||
              rf.description.toLowerCase().includes(baseSection.toLowerCase()) ||
              (rf.evidenceSource && rf.evidenceSource.some((s) => s.toLowerCase().includes(baseSection.toLowerCase()))) ||
              (empInfo && rf.description.toLowerCase().includes(empInfo.name.toLowerCase()))
    );
    const relevantResumeFindings = (repairPlan.resumeFindings || []).filter(
      (f) => f.toLowerCase().includes(norm.toLowerCase()) ||
             f.toLowerCase().includes(baseSection.toLowerCase()) ||
             (empInfo && f.toLowerCase().includes(empInfo.name.toLowerCase()))
    );

    if (relevantOps.length > 0 || relevantRoots.length > 0 || relevantResumeFindings.length > 0) {
      lines.push("- **Specific Repair Instructions / Findings**:");
      for (const op of relevantOps) {
        lines.push(`  - **[${op.operation}]**: ${op.reason}`);
      }
      for (const rf of relevantRoots) {
        if (!relevantOps.some((op) => op.reason === rf.reason)) {
          lines.push(`  - **[Finding]**: ${rf.description} (${rf.reason})`);
        }
      }
      for (const rfStr of relevantResumeFindings) {
        if (!relevantRoots.some((r) => r.description === rfStr) && !relevantOps.some((o) => o.reason === rfStr)) {
          lines.push(`  - **[Feedback]**: ${rfStr}`);
        }
      }
    } else {
      lines.push("- **Specific Repair Instructions**: Refine and tailor this path to directly address feedback while preserving truthfulness.");
    }
    lines.push("");
  }

  // 2. Path-Specific Scoped Evidence
  lines.push("## 2. SCOPED EVIDENCE FOR AUTHORIZED PATHS");
  lines.push("");

  const hasSummary = normalizedPaths.some((p) => p.startsWith("summary"));
  const hasSkills = normalizedPaths.some((p) => p.startsWith("skillGroups"));
  const experiencePaths = normalizedPaths.filter((p) => p.startsWith("experience["));

  // Summary-specific scoped evidence
  if (hasSummary) {
    lines.push("### Evidence & Guidance for `summary[0]`");
    if (candidateProfile) {
      const identity = deriveProfessionalIdentity(candidateProfile);
      if (identity) {
        lines.push(`- **Verified Professional Identity**: ${identity.identity} (${candidateProfile.totalYearsExperience ?? 5}+ years verified experience).`);
      }
    }
    if (jobIntent) {
      lines.push(`- **Target Hiring Mission**: ${jobIntent.primaryMission}`);
    }
    if (evidenceMapping && evidenceMapping.mappings.length > 0) {
      lines.push("- **Top Mapped Proof Points** (use these to anchor the summary):");
      for (const m of evidenceMapping.mappings.slice(0, 3)) {
        lines.push(`  - **${m.jdPriority}**: At ${m.employer}, ${m.candidateEvidenceText}`);
      }
    } else if (accomplishmentPackage && accomplishmentPackage.employers.length > 0) {
      lines.push("- **Top Mapped Proof Points** (use these to anchor the summary):");
      for (const emp of accomplishmentPackage.employers.slice(0, 2)) {
        if (emp.verifiedAccomplishments.length > 0) {
          const acc = emp.verifiedAccomplishments[0];
          lines.push(`  - **${acc.category.toUpperCase()}**: At ${emp.employer}, ${acc.rawText}`);
        }
      }
    }
    lines.push("- **Summary Register & Structure Constraints**:");
    lines.push("  - Exactly 3-4 concise sentences: (1) Verified Identity & target domain, (2) Core architecture ownership, (3) Concrete delivery impact, (4) Defining supported tools.");
    lines.push("  - Max 7 total named technologies; max 4 named technologies per sentence.");
    lines.push("  - Write in polished executive resume register (complete sentences, no fragments, no marketing fluff).");
    lines.push("");
  }

  // SkillGroups-specific scoped evidence
  if (hasSkills) {
    lines.push("### Evidence & Guidance for `skillGroups`");
    if (jobIntent) {
      const critical = jobIntent.criticalCapabilities.map((c) => c.name).join(", ");
      const required = jobIntent.requiredCapabilities.map((c) => c.name).join(", ");
      lines.push(`- **Target Job Critical Priorities**: ${critical}`);
      if (required) lines.push(`- **Target Job Required Priorities**: ${required}`);
    }
    if (candidateProfile) {
      const allCandidateTech = Array.from(
        new Set([
          ...(candidateProfile.skills?.map((s: { rawSkillName: string }) => s.rawSkillName) ?? []),
          ...(candidateProfile.experience?.flatMap((e: { technologies: string[] }) => e.technologies) ?? []),
        ])
      ).filter(Boolean).slice(0, 25);
      lines.push(`- **Candidate Verified Available Skills (Global MSI + Experience)**: ${allCandidateTech.join(", ")}`);
    }
    lines.push("- **Skill Groups Constraints**:");
    lines.push("  - Target 15-22 distinct high-value skills across ATS-safe categories.");
    lines.push("  - Deduplicate aliases (e.g. use Azure Data Factory, not both ADF and Azure Data Factory).");
    lines.push("  - Order categories by target role relevance.");
    lines.push("");
  }

  // Employer-specific scoped evidence
  if (experiencePaths.length > 0) {
    const affectedEmployers = new Map<number, string>();
    for (const p of experiencePaths) {
      const info = getEmployerForPath(currentResume, p);
      if (info) affectedEmployers.set(info.index, info.name);
    }

    for (const [expIdx, empName] of affectedEmployers.entries()) {
      lines.push(`### Evidence for Employer: **${empName}**`);
      const empPkg = accomplishmentPackage?.employers.find((e: { employer: string }) => e.employer.toLowerCase() === empName.toLowerCase());
      const roleProfile = candidateProfile?.experience.find((e: { employer: string }) => e.employer.toLowerCase() === empName.toLowerCase());

      if (empPkg) {
        lines.push(`- **Title & Dates**: ${empPkg.title} (${empPkg.dates})`);
        lines.push(`- **Verified Engineering Context**: ${empPkg.projectContext}`);
        lines.push(`- **Strongest Accomplishment Proof Points**:`);
        for (const [idx, acc] of empPkg.verifiedAccomplishments.slice(0, 3).entries()) {
          const metric = acc.explicitMetricEvidence ? ` [Verified Metric: ${acc.explicitMetricEvidence}]` : "";
          lines.push(`  ${idx + 1}. **[${acc.category.toUpperCase()}]** ${acc.rawText}${metric}`);
        }
      } else if (roleProfile) {
        lines.push(`- **Title & Dates**: ${roleProfile.title} (${roleProfile.startDate || ""} - ${roleProfile.endDate || "Present"})`);
        lines.push(`- **Supported Technologies**: ${roleProfile.technologies.slice(0, 10).join(", ")}`);
      }

      // Check specific path requirements for this employer
      const empPaths = normalizedPaths.filter((p) => getEmployerForPath(currentResume, p)?.index === expIdx);
      for (const p of empPaths) {
        if (p.includes("projectDescription")) {
          lines.push(`- **Project Description Rule**: Exactly 1-2 concise sentences naming domain, business context, and architecture scope. Max 4 named technologies drawn from approved architecture.`);
        } else if (p.includes("environment")) {
          lines.push(`- **Environment Rule**: Compact list of 5-8 defining technologies for ${empName}.`);
        } else if (p.includes("bullets")) {
          lines.push(`- **Bullet Standard**: Engineering Action + System Context + Purpose/Outcome. Vary opening verbs.`);
        }
      }
      lines.push("");
    }
  }

  // 3. Compact Truthfulness & Metric Policy Contract
  lines.push("## 3. TRUTHFULNESS & REPAIR CONTRACT");
  lines.push("");
  lines.push("- **Surgical Scope**: Return modifications for ONLY the authorized editable paths above. Collateral edits to other paths will cause the repair to fail.");
  lines.push("- **Factual Grounding**: Hard career facts (employers, titles, dates, degrees) are immutable.");
  lines.push("- **Employer Attribution**: Maintain strict technology boundaries. Never claim an Azure employer responsibility as AWS (or vice-versa) unless evidenced for that employer.");
  lines.push("- **Metric Policy**: Faithful to explicit metrics where present. You MAY generate a conservative, defensible metric when existing CareerOps policy permits it, context supports it, and it strengthens the accomplishment. Never invent extreme scale or artificial precision.");
  if (resolvedFindingKeys.length > 0) {
    lines.push(`- **Resolved Findings (Do Not Regress)**: ${resolvedFindingKeys.join(", ")}`);
  }
  lines.push("");

  // 4. Strict JSON PATCH Output Schema
  lines.push("## 4. STRICT JSON PATCH OUTPUT SCHEMA (writer_output.json)");
  lines.push("");
  lines.push("Write `writer_output.json` to this directory with schema version 2 in PATCH mode:");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({
    schemaVersion: 2,
    outputMode: "PATCH",
    candidateId,
    applicationId,
    jobId,
    tailoringRunId,
    workflowId,
    iterationNumber,
    operations: editablePaths.map((p) => ({
      document: "resume",
      path: normalizePathKey(p),
      replacement: "<the repaired string or structure for this path>"
    })),
    agentMetadata: {
      provider: "claude-code | antigravity | local | other",
      model: "your-model-identifier",
      completedAt: new Date().toISOString()
    }
  }, null, 2));
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}
