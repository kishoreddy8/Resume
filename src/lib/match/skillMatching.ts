import { CREDIT } from "./creditTable";
import { findTransferablePair, TRANSFERABLE_SKILLS, type TransferablePair } from "./transferableSkills";
import type { CandidateProfile, MatchType, NormalizedCandidateSkill, RequirementMatch, RequirementUnit } from "./types";

/**
 * Evidence-strength matching engine — the core of Phase 2's deterministic candidate<->JD matching.
 * Pure function: RequirementUnit[] (JD side) x NormalizedCandidateSkill[] (candidate side, already
 * resolved to canonical names — see normalizeCandidateSkills.ts) -> RequirementMatch[].
 *
 * CORRECTION 6 ENFORCEMENT (only JD requirements contribute points): this function's outer loop
 * iterates RequirementUnits ONLY. The candidate profile is consulted purely as a lookup target for
 * each unit — there is no code path here that iterates the candidate's skill list and awards credit
 * for something the JD never asked for. A large Master Skills Inventory full of unrelated
 * technologies cannot inflate a score through this function, structurally.
 */

const EDUCATION_ORDINAL: Record<string, number> = {
  phd: 5,
  "master's": 4,
  "bachelor's": 3,
  "associate's": 2,
  "high school": 1,
};

function educationOrdinal(level: string): number {
  return EDUCATION_ORDINAL[level.trim().toLowerCase()] ?? 0;
}

function candidateBestEducationOrdinal(profile: CandidateProfile): number {
  return profile.education.reduce((max, entry) => Math.max(max, educationOrdinal(entry.level)), 0);
}

function normalizeCertName(name: string): string {
  return name.trim().toLowerCase();
}

interface SingleSkillOutcome {
  matchType: MatchType;
  credit: number;
  evidence?: RequirementMatch["evidence"];
  transferable?: RequirementMatch["transferable"];
}

function matchSingleSkillName(
  canonicalName: string,
  normalizedSkills: NormalizedCandidateSkill[],
  experienceDepthRequired: boolean,
  transferablePairs: TransferablePair[]
): SingleSkillOutcome {
  const employerMatch = normalizedSkills.find((s) => s.canonicalSkillName === canonicalName && s.source === "employer");
  if (employerMatch) {
    return {
      matchType: "MATCHED",
      credit: CREDIT.employerExact,
      evidence: {
        source: "employer",
        rawSkillName: employerMatch.rawSkillName,
        canonicalSkillName: employerMatch.canonicalSkillName,
        employers: employerMatch.attributedTo?.map((a) => a.employer),
        yearsStated: employerMatch.yearsStated,
      },
    };
  }

  const inventoryMatch = normalizedSkills.find((s) => s.canonicalSkillName === canonicalName && s.source === "inventory_only");
  if (inventoryMatch) {
    return {
      matchType: "MATCHED",
      credit: experienceDepthRequired ? CREDIT.inventoryExactExperienceDepthRequired : CREDIT.inventoryExact,
      evidence: {
        source: "inventory_only",
        rawSkillName: inventoryMatch.rawSkillName,
        canonicalSkillName: inventoryMatch.canonicalSkillName,
        yearsStated: inventoryMatch.yearsStated,
      },
    };
  }

  const candidateCanonicalSkills = normalizedSkills.map((s) => s.canonicalSkillName).filter((s): s is string => s !== null);
  const transferablePair = findTransferablePair(candidateCanonicalSkills, canonicalName, transferablePairs);
  if (transferablePair) {
    return {
      matchType: "TRANSFERABLE",
      credit: transferablePair.strength === "strong" ? CREDIT.transferableStrong : CREDIT.transferableModerate,
      transferable: {
        fromRawSkillName: transferablePair.from,
        toCanonicalSkillName: canonicalName,
        strength: transferablePair.strength,
        reason: transferablePair.reason,
      },
    };
  }

  return { matchType: "MISSING", credit: CREDIT.missing };
}

/** Ranks outcomes so an OR-alternative group's unit reflects the BEST outcome across its members —
 *  satisfying any one alternative satisfies the whole unit; it is never split into per-member credit. */
function pickBestOutcome(outcomes: SingleSkillOutcome[]): SingleSkillOutcome {
  return outcomes.reduce((best, current) => (current.credit > best.credit ? current : best));
}

export function matchRequirementUnit(
  unit: RequirementUnit,
  profile: CandidateProfile,
  normalizedSkills: NormalizedCandidateSkill[],
  transferablePairs: TransferablePair[] = TRANSFERABLE_SKILLS
): RequirementMatch {
  // A line the unclaimed-requirement detector produced has no canonical skill to match against by
  // definition — it is genuinely unresolved, never guessed at as MISSING or MATCHED.
  if (unit.fromUnclaimedText) {
    return { requirement: unit, matchType: "UNRESOLVED", credit: CREDIT.unresolved };
  }

  if (unit.kind === "certification") {
    const held = profile.certifications.some((c) => normalizeCertName(c.name) === normalizeCertName(unit.label));
    return held
      ? { requirement: unit, matchType: "MATCHED", credit: CREDIT.employerExact, evidence: { source: "employer", rawSkillName: unit.label, canonicalSkillName: null } }
      : { requirement: unit, matchType: "MISSING", credit: CREDIT.missing };
  }

  if (unit.kind === "education") {
    const requiredOrdinal = educationOrdinal(unit.label.split(" in ")[0]);
    const candidateOrdinal = candidateBestEducationOrdinal(profile);
    return candidateOrdinal >= requiredOrdinal && requiredOrdinal > 0
      ? { requirement: unit, matchType: "MATCHED", credit: CREDIT.employerExact, evidence: { source: "employer", rawSkillName: unit.label, canonicalSkillName: null } }
      : { requirement: unit, matchType: "MISSING", credit: CREDIT.missing };
  }

  // kind === "skill" | "skill_group"
  if (unit.memberSkillNames.length === 0) {
    // Defensive — should not happen for a non-unclaimed skill/skill_group unit, but never silently
    // treat an empty member list as satisfied.
    return { requirement: unit, matchType: "UNRESOLVED", credit: CREDIT.unresolved };
  }
  const outcomes = unit.memberSkillNames.map((name) => matchSingleSkillName(name, normalizedSkills, unit.experienceDepthRequired, transferablePairs));
  const best = pickBestOutcome(outcomes);
  return { requirement: unit, matchType: best.matchType, credit: best.credit, evidence: best.evidence, transferable: best.transferable };
}

export function matchAllRequirementUnits(
  units: RequirementUnit[],
  profile: CandidateProfile,
  normalizedSkills: NormalizedCandidateSkill[],
  transferablePairs: TransferablePair[] = TRANSFERABLE_SKILLS
): RequirementMatch[] {
  return units.map((unit) => matchRequirementUnit(unit, profile, normalizedSkills, transferablePairs));
}
