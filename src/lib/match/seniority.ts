import { extractSeniority } from "@/lib/jobIntel/seniority";
import type { Seniority } from "@/types";
import type { CandidateExperienceEntry, CandidateSeniorityEstimate } from "./types";

/**
 * Conservative, title-only seniority heuristic (Phase 2 Revision 4 §7). Reuses
 * src/lib/jobIntel/seniority.ts's extractSeniority (imported, not duplicated) — the exact same
 * title-keyword classifier Phase 1 already uses for JD titles, applied here to the candidate's most
 * recent role title. Deliberately does NOT infer seniority from tenure length, bullet content, or
 * leadership language in a role's bullets that isn't itself in the title — that would be
 * manufacturing seniority from responsibilities the Master Resume doesn't explicitly support via a
 * title. If the most recent title carries no recognizable seniority keyword, the result is
 * "Unknown", never guessed.
 */

function mostRecentEntry(experience: CandidateExperienceEntry[]): CandidateExperienceEntry | null {
  if (experience.length === 0) return null;
  // Prefer an explicitly-current role (endDate null); otherwise the entry with the latest endDate.
  const current = experience.find((e) => e.endDate === null);
  if (current) return current;
  return [...experience].sort((a, b) => (b.endDate ?? "").localeCompare(a.endDate ?? ""))[0];
}

export function estimateCandidateSeniority(experience: CandidateExperienceEntry[]): CandidateSeniorityEstimate {
  const mostRecent = mostRecentEntry(experience);
  if (!mostRecent) {
    return { level: "Unknown", derivedFrom: "unknown", note: "No candidate work history available." };
  }
  const extracted = extractSeniority(mostRecent.title);
  if (extracted.level === "Unknown") {
    return {
      level: "Unknown",
      derivedFrom: "unknown",
      note: `Most recent title ("${mostRecent.title}") carries no recognizable seniority keyword — not guessed from tenure or responsibilities.`,
    };
  }
  return {
    level: extracted.level,
    derivedFrom: "most_recent_title",
    note: `Estimated from most recent job title ("${mostRecent.title}") only — a V1 heuristic, not a full seniority assessment. Does not account for scope, impact, or leadership evidence beyond the literal title text.`,
  };
}

// Coarse ordinal for a rough alignment score only — IC track (Staff/Principal) and management track
// (Manager/Director) are not truly linearly comparable, but this is an explicit, documented V1
// approximation, not presented as precise.
const SENIORITY_ORDINAL: Record<Seniority, number> = {
  Intern: 0,
  Entry: 1,
  Junior: 2,
  Mid: 3,
  Senior: 4,
  Staff: 5,
  Lead: 5,
  Principal: 6,
  Manager: 6,
  Director: 7,
  Unknown: -1,
};

/** null = inapplicable (either side Unknown) — never guessed as a neutral middle score; see
 *  scoring.ts's weight-redistribution rule for how a null dimension is handled. */
export function seniorityAlignmentScore(jobLevel: Seniority, candidateLevel: Seniority): number | null {
  if (jobLevel === "Unknown" || candidateLevel === "Unknown") return null;
  const jobOrdinal = SENIORITY_ORDINAL[jobLevel];
  const candidateOrdinal = SENIORITY_ORDINAL[candidateLevel];
  if (candidateOrdinal >= jobOrdinal) return 1.0; // meets or exceeds — never penalized for being overqualified
  const gap = jobOrdinal - candidateOrdinal;
  if (gap === 1) return 0.6;
  return 0.2;
}
