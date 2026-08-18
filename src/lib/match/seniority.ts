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

/**
 * Stage 24C — JD levels that are categorically incompatible with an already-professional candidate,
 * with the minimum EVIDENCED tenure that establishes that incompatibility and the alignment score
 * the mismatch earns.
 *
 * WHY THIS EXISTS. Candidate 1's most recent title is "Data Engineer", which carries no seniority
 * keyword, so estimateCandidateSeniority correctly reports Unknown and seniorityAlignmentScore
 * returned null — inapplicable — for EVERY job level. Measured directly: a "Data Engineer Intern"
 * posting scored identically to a "Senior Data Engineer" posting (role alignment 1.00 in both cases,
 * because "Intern" is a level word the role-identity parser strips by design), with no seniority
 * signal to separate them. An internship requisition was therefore fully eligible to reach
 * READY_FOR_TAILORING for a candidate with years of continuous professional employment.
 *
 * This rule NEVER claims a candidate seniority level and never touches candidate titles. It fires
 * only when the JOB's own seniority is explicit (Intern/Entry) and CareerOps already holds
 * independent evidence the candidate is past that level — either a candidate title that itself
 * states a higher level, or total years of professional experience derived deterministically from
 * the Master Resume's own dated employment history (experienceDuration.ts's interval-union math,
 * which returns null rather than guessing). With neither kind of evidence available the behaviour is
 * unchanged: the dimension stays inapplicable rather than inventing a penalty.
 */
export const JOB_LEVEL_INCOMPATIBILITY: { level: Seniority; minYearsEvidenced: number; score: number }[] = [
  { level: "Intern", minYearsEvidenced: 1, score: 0 },
  { level: "Entry", minYearsEvidenced: 3, score: 0.2 },
];

/** null = inapplicable (either side Unknown) — never guessed as a neutral middle score; see
 *  scoring.ts's weight-redistribution rule for how a null dimension is handled.
 *
 *  `candidateYearsExperience` is the deterministic interval-union total from
 *  experienceDuration.ts (null = not computable from the stated dates, never a guess). It is used
 *  ONLY by the Stage 24C Intern/Entry incompatibility rule above — it can never raise a score. */
export function seniorityAlignmentScore(
  jobLevel: Seniority,
  candidateLevel: Seniority,
  candidateYearsExperience: number | null = null
): number | null {
  const incompatible = JOB_LEVEL_INCOMPATIBILITY.find((rule) => rule.level === jobLevel);
  if (incompatible) {
    const evidencedByTenure =
      candidateYearsExperience !== null && candidateYearsExperience >= incompatible.minYearsEvidenced;
    const evidencedByTitle =
      candidateLevel !== "Unknown" && SENIORITY_ORDINAL[candidateLevel] > SENIORITY_ORDINAL[incompatible.level];
    if (evidencedByTenure || evidencedByTitle) return incompatible.score;
  }

  if (jobLevel === "Unknown" || candidateLevel === "Unknown") return null;
  const jobOrdinal = SENIORITY_ORDINAL[jobLevel];
  const candidateOrdinal = SENIORITY_ORDINAL[candidateLevel];
  if (candidateOrdinal >= jobOrdinal) return 1.0; // meets or exceeds — never penalized for being overqualified
  const gap = jobOrdinal - candidateOrdinal;
  if (gap === 1) return 0.6;
  return 0.2;
}
