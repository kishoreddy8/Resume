import type { RoleFamilyTier } from "@/lib/rank/forYou";

/**
 * Computes ForYouJobInput.roleFamilyTier from a candidate's declared target-role preferences
 * (candidate_settings.primary_target_role/secondary_target_roles) against a job's title — deliberately
 * kept out of forYou.ts itself (see that module's doc comment: ranking-only, never touches score).
 *
 * Deterministic keyword containment, not a classifier: every significant word in the preference
 * string must appear in the (normalized) job title. This is intentionally conservative — it only
 * ever affects sort order, never fabricates technical evidence or changes Phase 2 scoring, so a
 * false negative (missed synonym) is safe; a false positive would misleadingly promote an unrelated
 * job, which is why containment requires ALL words, not any.
 */

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "or", "for", "in", "on", "at", "to", "i", "ii", "iii"]);

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

/** True only if every significant word of `role` appears somewhere in `jobTitle` (substring match per
 *  word, so "Engineer" also matches "Engineering"). An empty/whitespace-only role never matches
 *  anything — there is no such thing as an unconditional match here. */
export function matchesRoleFamily(jobTitle: string, role: string | null | undefined): boolean {
  if (!role) return false;
  const roleWords = normalizeWords(role);
  if (roleWords.length === 0) return false;
  const titleNormalized = ` ${normalizeWords(jobTitle).join(" ")} `;
  return roleWords.every((w) => titleNormalized.includes(` ${w}`) || titleNormalized.includes(`${w} `));
}

export interface RoleFamilyPreferences {
  primaryTargetRole: string | null;
  secondaryTargetRoles: string[];
}

/** PRIMARY beats SECONDARY beats NONE — matches ROLE_FAMILY_RANK's ordering in forYou.ts. A job that
 *  matches both the primary and a secondary preference is PRIMARY (the stronger tier always wins). */
export function computeRoleFamilyTier(jobTitle: string, prefs: RoleFamilyPreferences): RoleFamilyTier {
  if (matchesRoleFamily(jobTitle, prefs.primaryTargetRole)) return "PRIMARY";
  if (prefs.secondaryTargetRoles.some((role) => matchesRoleFamily(jobTitle, role))) return "SECONDARY";
  return "NONE";
}
