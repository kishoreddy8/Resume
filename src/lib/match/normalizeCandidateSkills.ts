import { SKILL_TAXONOMY } from "@/lib/jobIntel/skillsTaxonomy";
import { escapeRegExp } from "@/lib/jobIntel/textUtils";
import type { SkillCategory } from "@/types";
import type { CandidateProfile, NormalizedCandidateSkill } from "./types";

/**
 * Resolves CandidateSkillEntry.rawSkillName against the CURRENT SKILL_TAXONOMY — computed fresh on
 * every call, never persisted. This is deliberate (see Phase 2 Revision 4 §2): the Master Skills
 * Inventory outranks the taxonomy as source of truth. `rawSkillName` is the candidate's real,
 * authoritative knowledge; the taxonomy is just today's normalization vocabulary. A skill the
 * taxonomy doesn't recognize yet is NEVER dropped — it stays in the profile, unmatched, and starts
 * resolving automatically the moment SKILL_TAXONOMY gains a covering alias, with zero changes to
 * candidate-profile.json and no re-run of build-candidate-profile required.
 */

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

// Longest alias first — mirrors src/lib/jobIntel/skills.ts's own ordering rationale, so a longer,
// more specific alias is preferred over a shorter one that happens to be contained within it.
const ALL_ALIASES = SKILL_TAXONOMY.flatMap((entry) => entry.aliases.map((alias) => ({ entry, alias }))).sort(
  (a, b) => b.alias.length - a.alias.length
);

export function resolveCanonicalSkill(rawSkillName: string): { canonical: string; category: SkillCategory } | null {
  const normalized = normalize(rawSkillName);

  // Tier 1: the raw name IS a known alias, exactly (after normalization) — e.g. "python" === "python".
  for (const { entry, alias } of ALL_ALIASES) {
    if (normalized === alias) return { canonical: entry.canonical, category: entry.category };
  }
  // Tier 2: the raw name CONTAINS a known alias as a whole word/phrase — e.g. "Azure Data Factory
  // (ADF)" contains the alias "azure data factory". Still a real match, not a fuzzy guess.
  for (const { entry, alias } of ALL_ALIASES) {
    const regex = new RegExp(`(?<![\\w-])${escapeRegExp(alias)}(?![\\w-])`, "i");
    if (regex.test(normalized)) return { canonical: entry.canonical, category: entry.category };
  }
  return null;
}

export function normalizeCandidateSkills(profile: CandidateProfile): NormalizedCandidateSkill[] {
  return profile.skills.map((entry) => {
    const resolved = resolveCanonicalSkill(entry.rawSkillName);
    return { ...entry, canonicalSkillName: resolved?.canonical ?? null, category: resolved?.category ?? null };
  });
}

/** Diagnostic list for the match result (§2's "surfaced diagnostically" requirement) — the concrete
 *  signal for deliberately growing SKILL_TAXONOMY over time. */
export function unrecognizedCandidateSkillNames(normalized: NormalizedCandidateSkill[]): string[] {
  return normalized.filter((s) => s.canonicalSkillName === null).map((s) => s.rawSkillName);
}
