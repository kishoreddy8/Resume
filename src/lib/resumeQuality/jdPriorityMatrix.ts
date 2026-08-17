import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { resolveSkillForReview } from "./reviewers/skillAliases";

/**
 * Stage 21 (Evidence-Grounded Resume Quality V2) — NEXT 1: the JD Priority Matrix. A ranked view of
 * JD requirements, built ONLY from Phase 2's own existing structured extraction (RequirementUnit[] —
 * read-only, never modified, never re-implemented) plus the job's own posted title for role identity.
 * The JD itself is never treated as candidate evidence anywhere in this module — it only produces
 * REQUIREMENTS; whether the candidate satisfies them is decided entirely by evidenceStrength below,
 * computed against the CandidateProfile (Master Resume/Skills Inventory), never the JD.
 *
 * TIER MAPPING — deliberately grounded in criticality (Phase 2's own most granular JD-side signal,
 * itself derived from structured extraction, never keyword frequency) rather than invented free-text
 * parsing:
 *   P0 = the target role's own title (a single value, not a requirement list — see targetRoleTitle)
 *   P1 = criticality "CRITICAL"   — core/must-have technical requirements
 *   P2 = criticality "REQUIRED"   — the closest existing structured proxy for "major responsibility
 *        area" Phase 2 extraction actually carries; Phase 2 does not extract free-text responsibility
 *        prose (job descriptions' duty bullets), so true P2 in the fullest sense the mission describes
 *        is NOT reconstructed here — documented honestly rather than approximated further.
 *   P3 = criticality "PREFERRED"  — preferred technologies
 *   P4 = criticality "OPTIONAL"   — supporting/secondary technologies
 *   P5 = generic/company language — NOT populated from RequirementUnit at all. Phase 2's own
 *        extractor is specifically scoped to skill/education/certification requirements, so it never
 *        emits boilerplate ("fast-paced environment") in the first place; there is no existing
 *        structured source for P5, and inventing a new free-text JD parser was judged out of scope
 *        for this pass (RequirementUnit stays the single source of truth this matrix reads from).
 *
 * Never treats keyword FREQUENCY as importance — a technology mentioned five times in a JD gets
 * exactly the same tier as one mentioned once, because tier is derived solely from criticality, a
 * property Phase 2's own extraction already assigns per-unit, never from occurrence counts.
 */

export const JD_PRIORITY_TIERS = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export type JdPriorityTier = (typeof JD_PRIORITY_TIERS)[number];

export const EVIDENCE_STRENGTHS = ["STRONG", "PARTIAL", "NONE"] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export interface RankedJdRequirement {
  /** Normalized requirement/concept label, e.g. "Snowflake". */
  requirement: string;
  priority: JdPriorityTier;
  memberSkillNames: string[];
  /** REQUIRED/PREFERRED where Phase 2's own requirementLevel deterministically identifies it;
   *  UNSPECIFIED only for units where that field is genuinely absent (never guessed). */
  requiredOrPreferred: "REQUIRED" | "PREFERRED" | "UNSPECIFIED";
  evidenceAvailable: boolean;
  evidenceStrength: EvidenceStrength;
  /** Canonical skill names (a subset of memberSkillNames, resolved) the candidate profile actually
   *  grounds this requirement in — the "supporting evidence IDs/references" the mission asks for,
   *  expressed as the CandidateProfile's own skill/technology names since this codebase has no
   *  separate evidence-ID scheme to reference (see msiComplianceChecks.ts, which resolves the same
   *  way for the identical reason). */
  evidenceReferences: string[];
}

export interface JdPriorityMatrix {
  /** The job posting's own title — P0, role identity. Never derived from RequirementUnit (which has
   *  no concept of "the role itself", only its requirements) and never absent when a title exists. */
  targetRoleTitle: string | null;
  requirements: RankedJdRequirement[];
}

function tierFromCriticality(criticality: RequirementUnit["criticality"]): JdPriorityTier {
  switch (criticality) {
    case "CRITICAL":
      return "P1";
    case "REQUIRED":
      return "P2";
    case "PREFERRED":
      return "P3";
    case "OPTIONAL":
    default:
      return "P4";
  }
}

function requiredOrPreferredOf(unit: RequirementUnit): "REQUIRED" | "PREFERRED" | "UNSPECIFIED" {
  if (unit.requirementLevel === "Required") return "REQUIRED";
  if (unit.requirementLevel === "Preferred") return "PREFERRED";
  return "UNSPECIFIED";
}

/** The candidate's own authoritative canonical skill set, resolved the SAME way
 *  msiComplianceChecks.ts does (reused, not reimplemented) — split into "used at a specific employer"
 *  (STRONG evidence: genuinely hands-on) vs "known but not tied to any employer" (PARTIAL: inventory-
 *  only, e.g. a certification or self-reported skill with no attributed project). */
function candidateEvidenceSets(profile: CandidateProfile): { strong: Set<string>; partial: Set<string> } {
  const strong = new Set<string>();
  const partial = new Set<string>();
  for (const skill of profile.skills) {
    const resolved = resolveSkillForReview(skill.rawSkillName);
    partial.add(resolved?.canonical ?? skill.rawSkillName);
  }
  for (const entry of profile.experience) {
    for (const tech of entry.technologies) {
      const resolved = resolveSkillForReview(tech);
      strong.add(resolved?.canonical ?? tech);
    }
  }
  return { strong, partial };
}

function evaluateRequirementEvidence(
  unit: RequirementUnit,
  candidateProfile: CandidateProfile | undefined
): { strength: EvidenceStrength; references: string[] } {
  if (!candidateProfile) return { strength: "NONE", references: [] };
  const { strong, partial } = candidateEvidenceSets(candidateProfile);

  const resolvedMembers = unit.memberSkillNames.map((name) => resolveSkillForReview(name)?.canonical ?? name);
  const strongMatches = resolvedMembers.filter((name) => strong.has(name));
  if (strongMatches.length > 0) return { strength: "STRONG", references: [...new Set(strongMatches)] };

  const partialMatches = resolvedMembers.filter((name) => partial.has(name));
  if (partialMatches.length > 0) return { strength: "PARTIAL", references: [...new Set(partialMatches)] };

  return { strength: "NONE", references: [] };
}

export function buildJdPriorityMatrix(
  requirements: RequirementUnit[] | undefined,
  targetRoleTitle: string | null,
  candidateProfile: CandidateProfile | undefined
): JdPriorityMatrix {
  const ranked: RankedJdRequirement[] = (requirements ?? []).map((unit) => {
    const evidence = evaluateRequirementEvidence(unit, candidateProfile);
    return {
      requirement: unit.label,
      priority: tierFromCriticality(unit.criticality),
      memberSkillNames: unit.memberSkillNames,
      requiredOrPreferred: requiredOrPreferredOf(unit),
      evidenceAvailable: evidence.strength !== "NONE",
      evidenceStrength: evidence.strength,
      evidenceReferences: evidence.references,
    };
  });

  return { targetRoleTitle, requirements: ranked };
}

/** The P0/P1 subset — the tiers a positioning/headline decision must be built around, per the
 *  mission's own "target role + strongest supported P0/P1 evidence" instruction. Excludes P2-P5
 *  entirely so a secondary technology (however frequently it appears in the JD) can never leak into
 *  the set that determines positioning. */
export function corePriorityRequirements(matrix: JdPriorityMatrix): RankedJdRequirement[] {
  return matrix.requirements.filter((r) => r.priority === "P1");
}
