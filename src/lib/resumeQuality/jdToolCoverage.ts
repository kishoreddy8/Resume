import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../../../tools/tailoring-engine/types";
import { extractCanonicalSkillsFromText, resolveSkillForReview } from "./reviewers/skillAliases";
import { classifyTechnology } from "./technologyClassification";

export type JdToolSupportStatus = "SUPPORTED" | "NOT_SUPPORTED";
export type WriterToolDirective = "PASS_TO_WRITER" | "DO_NOT_CLAIM";

export interface JdToolCoverageItem {
  name: string;
  canonical: string;
  category?: string;
  priority: "P1" | "P2" | "P3" | "P4";
  criticality: string;
  status: JdToolSupportStatus;
  directive: WriterToolDirective;
  candidateEvidenceSources: string[];
}

export interface JdToolCoveragePlan {
  supportedP1: JdToolCoverageItem[];
  supportedP2: JdToolCoverageItem[];
  supportedP3: JdToolCoverageItem[];
  supportedP4: JdToolCoverageItem[];
  unsupportedTools: JdToolCoverageItem[];
  allSupportedTools: string[];
  allUnsupportedTools: string[];
  coverageSummary: {
    totalJdTools: number;
    supportedCount: number;
    unsupportedCount: number;
    p1SupportedRatio: number;
  };
}

export interface PostWriterJdToolCoverageResult {
  coveredP1Tools: string[];
  missingP1Tools: string[];
  coveredP2Tools: string[];
  missingP2Tools: string[];
  unsupportedToolsClaimed: string[];
  coverageScore: number;
}

function normalizeKey(str: string): string {
  return str.trim().toLowerCase();
}

/**
 * Builds candidate global authoritative capability pool (Union of MSI + Experience).
 */
export function buildCandidateGlobalCapabilitySet(profile: CandidateProfile): {
  canonicalSet: Set<string>;
  sourceMap: Map<string, string[]>;
} {
  const canonicalSet = new Set<string>();
  const sourceMap = new Map<string, string[]>();

  const addSkill = (raw: string, source: string) => {
    if (!raw || raw.trim().length === 0) return;
    const resolved = resolveSkillForReview(raw);
    const entry = classifyTechnology(raw);
    const canonical = entry?.canonical ?? resolved?.canonical ?? raw.trim();
    const key = normalizeKey(canonical);

    canonicalSet.add(key);
    canonicalSet.add(normalizeKey(raw));

    const existingSources = sourceMap.get(key) ?? [];
    if (!existingSources.includes(source)) {
      existingSources.push(source);
    }
    sourceMap.set(key, existingSources);
  };

  // 1. MSI Skills
  for (const s of profile.skills ?? []) {
    addSkill(s.rawSkillName, `MSI (${s.source})`);
  }

  // 2. Experience technologies
  for (const exp of profile.experience ?? []) {
    for (const tech of exp.technologies ?? []) {
      addSkill(tech, `Experience at ${exp.employer}`);
    }
  }

  return { canonicalSet, sourceMap };
}

/**
 * Evaluates JD tool coverage against candidate global capability set.
 */
export function evaluateJdToolCoveragePlan(params: {
  candidateProfile: CandidateProfile;
  jobRequirements?: RequirementUnit[];
}): JdToolCoveragePlan {
  const { candidateProfile, jobRequirements = [] } = params;
  const { canonicalSet, sourceMap } = buildCandidateGlobalCapabilitySet(candidateProfile);

  const supportedP1: JdToolCoverageItem[] = [];
  const supportedP2: JdToolCoverageItem[] = [];
  const supportedP3: JdToolCoverageItem[] = [];
  const supportedP4: JdToolCoverageItem[] = [];
  const unsupportedTools: JdToolCoverageItem[] = [];

  const seenKeys = new Set<string>();

  for (const req of jobRequirements) {
    const priority: "P1" | "P2" | "P3" | "P4" =
      req.criticality === "CRITICAL"
        ? "P1"
        : req.criticality === "REQUIRED" || req.requirementLevel === "Required"
        ? "P2"
        : req.criticality === "PREFERRED"
        ? "P3"
        : "P4";

    const termsToTest = [req.label, ...(req.memberSkillNames ?? [])].filter(
      (t): t is string => Boolean(t && t.trim().length > 0)
    );

    for (const term of termsToTest) {
      const resolved = resolveSkillForReview(term);
      const entry = classifyTechnology(term);
      const canonical = entry?.canonical ?? resolved?.canonical ?? term.trim();
      const key = normalizeKey(canonical);

      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const isSupported = canonicalSet.has(key) || canonicalSet.has(normalizeKey(term));
      const sources = sourceMap.get(key) ?? sourceMap.get(normalizeKey(term)) ?? [];

      const item: JdToolCoverageItem = {
        name: term.trim(),
        canonical,
        category: entry?.category ?? req.categories?.[0],
        priority,
        criticality: req.criticality,
        status: isSupported ? "SUPPORTED" : "NOT_SUPPORTED",
        directive: isSupported ? "PASS_TO_WRITER" : "DO_NOT_CLAIM",
        candidateEvidenceSources: sources,
      };

      if (!isSupported) {
        unsupportedTools.push(item);
      } else if (priority === "P1") {
        supportedP1.push(item);
      } else if (priority === "P2") {
        supportedP2.push(item);
      } else if (priority === "P3") {
        supportedP3.push(item);
      } else {
        supportedP4.push(item);
      }
    }
  }

  const allSupported = [
    ...supportedP1.map((i) => i.canonical),
    ...supportedP2.map((i) => i.canonical),
    ...supportedP3.map((i) => i.canonical),
    ...supportedP4.map((i) => i.canonical),
  ];
  const allUnsupported = unsupportedTools.map((i) => i.canonical);

  const totalJdTools = allSupported.length + allUnsupported.length;
  const p1Total = supportedP1.length + unsupportedTools.filter((i) => i.priority === "P1").length;
  const p1SupportedRatio = p1Total > 0 ? supportedP1.length / p1Total : 1.0;

  return {
    supportedP1,
    supportedP2,
    supportedP3,
    supportedP4,
    unsupportedTools,
    allSupportedTools: [...new Set(allSupported)],
    allUnsupportedTools: [...new Set(allUnsupported)],
    coverageSummary: {
      totalJdTools,
      supportedCount: allSupported.length,
      unsupportedCount: allUnsupported.length,
      p1SupportedRatio,
    },
  };
}

/**
 * Writer-facing JD Tool Coverage Section.
 */
export function renderJdToolCoverageSection(plan: JdToolCoveragePlan): string {
  let out = `## JD TOOL COVERAGE GUIDANCE\n\n`;

  out += `**SUPPORTED JD TECHNOLOGIES (Pass to Writer):**\n`;
  if (plan.supportedP1.length > 0) {
    out += `- **P1 Critical (Highest Priority):** ${plan.supportedP1.map((i) => i.canonical).join(", ")}\n`;
  }
  if (plan.supportedP2.length > 0) {
    out += `- **P2 Required (Strong Priority):** ${plan.supportedP2.map((i) => i.canonical).join(", ")}\n`;
  }
  if (plan.supportedP3.length > 0) {
    out += `- **P3 Preferred (Supporting):** ${plan.supportedP3.map((i) => i.canonical).join(", ")}\n`;
  }
  out += `\n*Distribution Rule:* Distribute supported tools naturally across Summary, Skills, Project Descriptions, Bullets, and Environment lines.\n\n`;

  if (plan.unsupportedTools.length > 0) {
    out += `**UNSUPPORTED JD TECHNOLOGIES (DO_NOT_CLAIM — Zero Evidence):**\n`;
    out += `- **Strict Guardrail:** Requested by JD but absent from candidate records. **DO NOT CLAIM OR INVENT:** ${plan.unsupportedTools.map((i) => i.canonical).join(", ")}\n\n`;
  }

  return out;
}

/**
 * Validates post-writer resume coverage against the JD Tool Coverage plan.
 */
export function evaluatePostWriterJdToolCoverage(
  resume: ResumeContent,
  plan: JdToolCoveragePlan
): PostWriterJdToolCoverageResult {
  const fullText = [
    ...(resume.summary ?? []),
    ...resume.skillGroups.flatMap((g) => g.items),
    ...resume.experience.flatMap((e) => [
      e.projectDescription ?? "",
      ...(e.environment ?? []),
      ...e.bullets,
    ]),
  ].join("\n");

  const claimedCanonical = extractCanonicalSkillsFromText(fullText);
  const textLower = fullText.toLowerCase();

  const isCovered = (canonical: string) => {
    return claimedCanonical.has(canonical) || textLower.includes(canonical.toLowerCase());
  };

  const coveredP1 = plan.supportedP1.filter((i) => isCovered(i.canonical)).map((i) => i.canonical);
  const missingP1 = plan.supportedP1.filter((i) => !isCovered(i.canonical)).map((i) => i.canonical);

  const coveredP2 = plan.supportedP2.filter((i) => isCovered(i.canonical)).map((i) => i.canonical);
  const missingP2 = plan.supportedP2.filter((i) => !isCovered(i.canonical)).map((i) => i.canonical);

  const unsupportedClaimed = plan.unsupportedTools
    .filter((i) => isCovered(i.canonical))
    .map((i) => i.canonical);

  const p1Ratio = plan.supportedP1.length > 0 ? coveredP1.length / plan.supportedP1.length : 1.0;
  const p2Ratio = plan.supportedP2.length > 0 ? coveredP2.length / plan.supportedP2.length : 1.0;

  const coverageScore = Math.round((p1Ratio * 0.7 + p2Ratio * 0.3) * 100);

  return {
    coveredP1Tools: coveredP1,
    missingP1Tools: missingP1,
    coveredP2Tools: coveredP2,
    missingP2Tools: missingP2,
    unsupportedToolsClaimed: unsupportedClaimed,
    coverageScore,
  };
}
