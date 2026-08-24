import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { resolveSkillForReview } from "./reviewers/skillAliases";
import {
  buildEmployerEvidenceMap,
  type EmployerEvidence,
  type EmployerEvidenceMap,
} from "./employerEvidence";

/**
 * Phase 2 — Deterministic JD-Specific Evidence Scoping.
 *
 * ARCHITECTURAL PRINCIPLE:
 * Filter what the writer sees — never filter what Career-Ops knows.
 *
 * The complete Master Resume, Master Skills Inventory, and CandidateProfile remain 100% available
 * to deterministic validators, audit systems, and quality gates. This module produces a bounded,
 * highly-relevant VIEW of candidate evidence specifically tailored to the target job description,
 * drastically reducing writer prompt/context tokens while preserving truthfulness, chronology, and
 * employer-specific evidence boundaries.
 */

export interface SelectedEmployerEvidence {
  employer: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  supported: string[];
  availableViaMsi: string[];
  prohibitedTargetSkills: string[];
  inventoryReachesRole: boolean;
}

export interface SelectedWriterEvidence {
  targetPriorities: {
    targetRoleTitle: string | null;
    p1Critical: string[];
    p2Required: string[];
    p3Preferred: string[];
    p4Optional: string[];
  };
  globalRelevantSkills: {
    primary: string[];
    secondary: string[];
    supporting: string[];
    all: string[];
  };
  employers: SelectedEmployerEvidence[];
  scopedEmployerMap: EmployerEvidenceMap;
  diagnostics: EvidenceScopingDiagnostics;
}

export interface EvidenceScopingDiagnostics {
  totalSkillsConsidered: number;
  totalSkillsSelected: number;
  totalEvidenceItemsConsidered: number;
  totalEvidenceItemsSelected: number;
  perEmployerCounts: Record<string, { supported: number; available: number; prohibited: number }>;
  boundedFallbackUsed: boolean;
  approximateEvidenceBytes: number;
  approximateEvidenceTokens: number;
}

export interface SelectWriterEvidenceInput {
  candidateProfile: CandidateProfile;
  jobRequirements?: RequirementUnit[];
  targetRoleTitle?: string | null;
  /** Minimum target skill count when JD requirements exist (default: 15) */
  minSkills?: number;
  /** Maximum target skill count (default: 35) */
  maxSkills?: number;
}

const DEFAULT_MIN_SKILLS = 15;
const DEFAULT_MAX_SKILLS = 35;

/** Standard core engineering foundational terms that provide essential supporting context */
const CORE_DATA_ENGINEERING_FOUNDATIONS = new Set([
  "data engineering",
  "etl",
  "data pipelines",
  "data warehousing",
  "dimensional modeling",
  "data modeling",
  "pyspark",
  "spark",
  "delta lake",
  "medallion architecture",
  "cdc",
  "scd type 2",
  "data quality",
  "ci/cd",
  "git",
  "azure devops",
  "sql",
  "python",
  "rest apis",
]);

const CORE_SOFTWARE_ENGINEERING_FOUNDATIONS = new Set([
  "software engineering",
  "git",
  "ci/cd",
  "rest apis",
  "unit testing",
  "microservices",
  "sql",
  "python",
  "typescript",
  "javascript",
]);

/**
 * Normalizes a term for case-insensitive deterministic lookup.
 */
function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Deterministically selects and ranks candidate evidence against structured JD requirements.
 */
export function selectWriterEvidence(input: SelectWriterEvidenceInput): SelectedWriterEvidence {
  const {
    candidateProfile,
    jobRequirements = [],
    targetRoleTitle = null,
    minSkills = DEFAULT_MIN_SKILLS,
    maxSkills = DEFAULT_MAX_SKILLS,
  } = input;

  const titleLower = normalizeKey(targetRoleTitle ?? "");
  const isDataRole = titleLower.includes("data") || titleLower.includes("analytics") || titleLower.includes("warehouse");
  const foundationalSkills = isDataRole ? CORE_DATA_ENGINEERING_FOUNDATIONS : CORE_SOFTWARE_ENGINEERING_FOUNDATIONS;

  // 1. Extract and rank structured JD requirements by priority tier
  const p1Set = new Set<string>();
  const p2Set = new Set<string>();
  const p3Set = new Set<string>();
  const p4Set = new Set<string>();
  const jdSkillLookup = new Map<string, { priority: "P1" | "P2" | "P3" | "P4"; category?: string }>();

  for (const req of jobRequirements) {
    const tier: "P1" | "P2" | "P3" | "P4" =
      req.criticality === "CRITICAL"
        ? "P1"
        : req.criticality === "REQUIRED"
        ? "P2"
        : req.criticality === "PREFERRED"
        ? "P3"
        : "P4";

    const targetSet = tier === "P1" ? p1Set : tier === "P2" ? p2Set : tier === "P3" ? p3Set : p4Set;

    for (const name of req.memberSkillNames) {
      if (!name || name.trim().length === 0) continue;
      targetSet.add(name.trim());
      const resolved = resolveSkillForReview(name);
      const canonical = resolved?.canonical ?? name.trim();
      jdSkillLookup.set(normalizeKey(canonical), { priority: tier, category: req.categories[0] });
      jdSkillLookup.set(normalizeKey(name), { priority: tier, category: req.categories[0] });
    }

    if (req.label && req.label.trim().length > 0) {
      targetSet.add(req.label.trim());
      const resolved = resolveSkillForReview(req.label);
      const canonical = resolved?.canonical ?? req.label.trim();
      jdSkillLookup.set(normalizeKey(canonical), { priority: tier, category: req.categories[0] });
      jdSkillLookup.set(normalizeKey(req.label), { priority: tier, category: req.categories[0] });
    }
  }

  // 2. Index candidate skills and their employer attribution
  const candidateSkillsMap = new Map<
    string,
    {
      raw: string;
      canonical: string;
      category?: string;
      employerCount: number;
      isRecent: boolean;
      sources: Set<string>;
    }
  >();

  let totalSkillsConsidered = 0;
  let totalEvidenceItemsConsidered = 0;

  for (const s of candidateProfile.skills ?? []) {
    totalSkillsConsidered += 1;
    const raw = s.rawSkillName.trim();
    if (!raw) continue;
    const resolved = resolveSkillForReview(raw);
    const canonical = resolved?.canonical ?? raw;
    const key = normalizeKey(canonical);

    let entry = candidateSkillsMap.get(key);
    if (!entry) {
      entry = {
        raw,
        canonical,
        category: resolved?.category,
        employerCount: 0,
        isRecent: false,
        sources: new Set(),
      };
      candidateSkillsMap.set(key, entry);
    }

    entry.sources.add(s.source);
    for (const attr of s.attributedTo ?? []) {
      entry.employerCount += 1;
      if (candidateProfile.experience?.[0]?.employer && attr.employer === candidateProfile.experience[0].employer) {
        entry.isRecent = true;
      }
    }
  }

  for (const exp of candidateProfile.experience ?? []) {
    for (const tech of exp.technologies ?? []) {
      totalEvidenceItemsConsidered += 1;
      const raw = tech.trim();
      if (!raw) continue;
      const resolved = resolveSkillForReview(raw);
      const canonical = resolved?.canonical ?? raw;
      const key = normalizeKey(canonical);

      let entry = candidateSkillsMap.get(key);
      if (!entry) {
        entry = {
          raw,
          canonical,
          category: resolved?.category,
          employerCount: 0,
          isRecent: false,
          sources: new Set(),
        };
        candidateSkillsMap.set(key, entry);
      }

      entry.employerCount += 1;
      if (candidateProfile.experience?.[0]?.employer && exp.employer === candidateProfile.experience[0].employer) {
        entry.isRecent = true;
      }
    }
  }

  // 3. Score candidate skills against JD requirements
  interface ScoredCandidateSkill {
    canonical: string;
    raw: string;
    score: number;
    tier: "P1" | "P2" | "P3" | "P4" | "SUPPORTING" | "UNMATCHED";
    employerCount: number;
    isRecent: boolean;
  }

  const scoredSkills: ScoredCandidateSkill[] = [];

  for (const [key, entry] of candidateSkillsMap.entries()) {
    let baseScore = 0;
    let tier: ScoredCandidateSkill["tier"] = "UNMATCHED";

    const jdMatch = jdSkillLookup.get(key);
    if (jdMatch) {
      tier = jdMatch.priority;
      if (jdMatch.priority === "P1") baseScore = 100;
      else if (jdMatch.priority === "P2") baseScore = 80;
      else if (jdMatch.priority === "P3") baseScore = 60;
      else baseScore = 40;
    } else if (foundationalSkills.has(key)) {
      tier = "SUPPORTING";
      baseScore = 30;
    } else if (
      entry.category &&
      (entry.category === "Data Engineering" || entry.category === "Warehousing" || entry.category === "Cloud")
    ) {
      tier = "SUPPORTING";
      baseScore = 20;
    }

    if (baseScore > 0) {
      let finalScore = baseScore;
      if (entry.sources.size > 0) finalScore += 5;
      if (entry.isRecent) finalScore += 5;

      scoredSkills.push({
        canonical: entry.canonical,
        raw: entry.raw,
        score: finalScore,
        tier,
        employerCount: entry.employerCount,
        isRecent: entry.isRecent,
      });
    }
  }

  // 4. Handle bounded safe fallback if JD matching produced fewer than minSkills (e.g. no JD requirements or minimal match)
  let boundedFallbackUsed = false;
  const targetThreshold = jobRequirements.length === 0 ? minSkills : Math.min(5, minSkills);

  if (scoredSkills.length < targetThreshold) {
    boundedFallbackUsed = true;
    for (const [key, entry] of candidateSkillsMap.entries()) {
      if (!scoredSkills.some((s) => normalizeKey(s.canonical) === key)) {
        // Global MSI and employer-evidenced skills are full candidate capability evidence
        let fallbackScore = 20;
        if (entry.isRecent) fallbackScore += 5;
        scoredSkills.push({
          canonical: entry.canonical,
          raw: entry.raw,
          score: fallbackScore,
          tier: "SUPPORTING",
          employerCount: entry.employerCount,
          isRecent: entry.isRecent,
        });
      }
    }
  }

  // Sort deterministically: highest score first, then alphabetical tie-breaker
  scoredSkills.sort((a, b) => b.score - a.score || a.canonical.localeCompare(b.canonical));

  // Cap selected skills to maxSkills
  const selectedSkillsList = scoredSkills.slice(0, maxSkills);

  // Categorize into Primary, Secondary, Supporting
  const primary: string[] = [];
  const secondary: string[] = [];
  const supporting: string[] = [];

  for (const s of selectedSkillsList) {
    if (s.score >= 85 || s.tier === "P1") {
      primary.push(s.canonical);
    } else if (s.score >= 45 || s.tier === "P2" || s.tier === "P3") {
      secondary.push(s.canonical);
    } else {
      supporting.push(s.canonical);
    }
  }

  // If primary is empty, promote highest scoring items
  if (primary.length === 0 && secondary.length > 0) {
    primary.push(...secondary.splice(0, Math.min(5, secondary.length)));
  }

  const allSelectedSkills = [...new Set([...primary, ...secondary, ...supporting])].sort((a, b) =>
    a.localeCompare(b)
  );

  // 5. Build full authoritative employer evidence map, then project it
  const rawEmployerMap = buildEmployerEvidenceMap(candidateProfile);
  const selectedKeySet = new Set(allSelectedSkills.map((s) => normalizeKey(s)));

  const employers: SelectedEmployerEvidence[] = [];
  const perEmployerCounts: Record<string, { supported: number; available: number; prohibited: number }> = {};
  let totalEvidenceItemsSelected = 0;

  const scopedEmployers: EmployerEvidence[] = rawEmployerMap.employers.map((emp) => {
    // A. Supported: retain supported technologies that are in selected skills, plus top 5 role-specific items
    const supportedSelected = emp.supported.filter((t) => selectedKeySet.has(normalizeKey(t)));
    const supportedOther = emp.supported.filter((t) => !selectedKeySet.has(normalizeKey(t))).slice(0, 5);
    const supported = [...new Set([...supportedSelected, ...supportedOther])].sort((a, b) => a.localeCompare(b));

    // B. Available via MSI: scoped strictly to the selected technology universe
    const availableViaMsi = emp.availableViaMsi
      .filter((t) => selectedKeySet.has(normalizeKey(t)))
      .sort((a, b) => a.localeCompare(b));

    // C. Prohibited Here (Negative Constraints): target-aware compression!
    // Include only prohibited technologies that are in the selected pool or JD requirements
    const prohibitedTargetSkills = emp.prohibitedHere
      .filter((t) => selectedKeySet.has(normalizeKey(t)) || jdSkillLookup.has(normalizeKey(t)))
      .sort((a, b) => a.localeCompare(b));

    totalEvidenceItemsSelected += supported.length;
    perEmployerCounts[emp.employer] = {
      supported: supported.length,
      available: availableViaMsi.length,
      prohibited: prohibitedTargetSkills.length,
    };

    const expEntry = candidateProfile.experience.find((e) => e.employer === emp.employer);

    employers.push({
      employer: emp.employer,
      title: emp.title,
      startDate: expEntry?.startDate ?? null,
      endDate: expEntry?.endDate ?? null,
      supported,
      availableViaMsi,
      prohibitedTargetSkills,
      inventoryReachesRole: emp.inventoryReachesRole,
    });

    return {
      employer: emp.employer,
      title: emp.title,
      supported,
      availableViaMsi,
      prohibitedHere: prohibitedTargetSkills,
      inventoryReachesRole: emp.inventoryReachesRole,
    };
  });

  const scopedEmployerMap: EmployerEvidenceMap = {
    employers: scopedEmployers,
    inventoryOnlyCount: rawEmployerMap.inventoryOnlyCount,
  };

  const renderedMsi = renderProjectedMasterSkillsInventory({
    targetPriorities: {
      targetRoleTitle,
      p1Critical: [...p1Set].sort(),
      p2Required: [...p2Set].sort(),
      p3Preferred: [...p3Set].sort(),
      p4Optional: [...p4Set].sort(),
    },
    globalRelevantSkills: {
      primary,
      secondary,
      supporting,
      all: allSelectedSkills,
    },
    employers,
    scopedEmployerMap,
    diagnostics: {
      totalSkillsConsidered,
      totalSkillsSelected: allSelectedSkills.length,
      totalEvidenceItemsConsidered,
      totalEvidenceItemsSelected,
      perEmployerCounts,
      boundedFallbackUsed,
      approximateEvidenceBytes: 0,
      approximateEvidenceTokens: 0,
    },
  });

  const approximateEvidenceBytes = Buffer.byteLength(renderedMsi, "utf-8");
  const approximateEvidenceTokens = Math.ceil(approximateEvidenceBytes / 4);

  const diagnostics: EvidenceScopingDiagnostics = {
    totalSkillsConsidered,
    totalSkillsSelected: allSelectedSkills.length,
    totalEvidenceItemsConsidered,
    totalEvidenceItemsSelected,
    perEmployerCounts,
    boundedFallbackUsed,
    approximateEvidenceBytes,
    approximateEvidenceTokens,
  };

  return {
    targetPriorities: {
      targetRoleTitle,
      p1Critical: [...p1Set].sort(),
      p2Required: [...p2Set].sort(),
      p3Preferred: [...p3Set].sort(),
      p4Optional: [...p4Set].sort(),
    },
    globalRelevantSkills: {
      primary,
      secondary,
      supporting,
      all: allSelectedSkills,
    },
    employers,
    scopedEmployerMap,
    diagnostics,
  };
}

/**
 * Renders the compact, JD-relevant writer-facing Master Skills Inventory markdown projection.
 */
export function renderProjectedMasterSkillsInventory(selected: SelectedWriterEvidence): string {
  const { globalRelevantSkills, targetPriorities } = selected;
  const roleTitle = targetPriorities.targetRoleTitle ? ` (${targetPriorities.targetRoleTitle})` : "";

  let out = `# Master Skills Inventory — Relevant Candidate Profile${roleTitle}\n\n`;
  out +=
    "The skills listed below are authoritative, verified candidate competencies selected for high relevance to this target role. " +
    "Every technology is grounded in candidate evidence. Use these to structure the resume's skill groups and emphasize relevant experience.\n\n";

  if (globalRelevantSkills.primary.length > 0) {
    out += `## Primary Core Technologies (P0 / P1 Must-Have Alignment)\n`;
    out += `${globalRelevantSkills.primary.map((s) => `- ${s}`).join("\n")}\n\n`;
  }

  if (globalRelevantSkills.secondary.length > 0) {
    out += `## Secondary & Architecture Capabilities (P2 / P3 Alignment)\n`;
    out += `${globalRelevantSkills.secondary.map((s) => `- ${s}`).join("\n")}\n\n`;
  }

  if (globalRelevantSkills.supporting.length > 0) {
    out += `## Supporting & Operational Stack (P4 & Foundation)\n`;
    out += `${globalRelevantSkills.supporting.map((s) => `- ${s}`).join("\n")}\n\n`;
  }

  return out;
}
