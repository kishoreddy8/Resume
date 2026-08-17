import type { CandidateProfile } from "@/lib/match/types";
import type { JdPriorityMatrix, JdPriorityTier } from "./jdPriorityMatrix";
import { resolveSkillForReview } from "./reviewers/skillAliases";

/**
 * Stage 21 (Evidence-Grounded Resume Quality V2) — NEXT 3: deterministic, traceable skill
 * prioritization. Ranks ONLY skills the candidate actually has evidence for (from CandidateProfile —
 * never the JD) against the JD Priority Matrix — an unsupported JD skill can never enter this ranking,
 * which is what makes "do not fabricate skills to raise ATS coverage" structural rather than a rule
 * to remember.
 *
 * score = priorityWeight(JD tier) × evidenceWeight(STRONG/PARTIAL) × recencyMultiplier
 *   priorityWeight: P1=5, P2=4, P3=3, P4=2, not-in-JD=1 (still a real candidate skill, just JD-irrelevant)
 *   evidenceWeight: STRONG=3 (used at a specific employer), PARTIAL=2 (known but no attributed project)
 *   recencyMultiplier: 1.2 if used at the candidate's most recent employer (by experience end/start
 *     date), else 1.0 — "recent experience receives greater importance, but relevance still matters"
 *     is satisfied by multiplying recency on TOP of priority/evidence rather than letting it override
 *     them outright: a P4 skill used yesterday can never outrank a P1 skill used two years ago, since
 *     1.2x can't close a gap of an entire priority or evidence tier.
 * "role relevance" (the mission's 3rd named factor) is deliberately not a 5th independent number here
 * — the JD priority tier IS the role-relevance signal (it is JD-derived, unlike evidence/recency which
 * are candidate-derived), so folding a second one in would double-count the same information.
 */

const PRIORITY_WEIGHT: Record<JdPriorityTier | "NOT_IN_JD", number> = {
  P0: 5, // not actually used for skills (P0 is the role title, not a skill tier) — kept for type completeness
  P1: 5,
  P2: 4,
  P3: 3,
  P4: 2,
  P5: 1,
  NOT_IN_JD: 1,
};

export interface RankedSkill {
  skill: string;
  jdPriority: JdPriorityTier | "NOT_IN_JD";
  evidenceStrength: "STRONG" | "PARTIAL";
  recentlyUsed: boolean;
  score: number;
}

function mostRecentEmployerTechnologies(profile: CandidateProfile): Set<string> {
  const withDates = profile.experience.filter((e) => e.startDate !== null || e.endDate === null);
  if (withDates.length === 0) return new Set();
  // "Most recent" = currently held (endDate null) first, else the latest startDate.
  const sorted = [...withDates].sort((a, b) => {
    if (a.endDate === null && b.endDate !== null) return -1;
    if (b.endDate === null && a.endDate !== null) return 1;
    return (b.startDate ?? "").localeCompare(a.startDate ?? "");
  });
  const mostRecent = sorted[0];
  return new Set(mostRecent.technologies.map((t) => resolveSkillForReview(t)?.canonical ?? t));
}

export function rankCandidateSkills(candidateProfile: CandidateProfile, matrix: JdPriorityMatrix): RankedSkill[] {
  const strong = new Set<string>();
  const partial = new Set<string>();
  for (const skill of candidateProfile.skills) {
    partial.add(resolveSkillForReview(skill.rawSkillName)?.canonical ?? skill.rawSkillName);
  }
  for (const entry of candidateProfile.experience) {
    for (const tech of entry.technologies) {
      strong.add(resolveSkillForReview(tech)?.canonical ?? tech);
    }
  }

  const jdTierBySkill = new Map<string, JdPriorityTier>();
  for (const req of matrix.requirements) {
    for (const member of req.memberSkillNames) {
      const canonical = resolveSkillForReview(member)?.canonical ?? member;
      // If the same skill appears in multiple requirement units at different tiers, keep the HIGHER
      // (numerically lower Pn) tier — a skill that is CRITICAL anywhere in the JD is CRITICAL.
      const existing = jdTierBySkill.get(canonical);
      if (!existing || PRIORITY_WEIGHT[req.priority] > PRIORITY_WEIGHT[existing]) {
        jdTierBySkill.set(canonical, req.priority);
      }
    }
  }

  const recentSet = mostRecentEmployerTechnologies(candidateProfile);
  const allEvidencedSkills = new Set([...strong, ...partial]);

  const ranked: RankedSkill[] = [...allEvidencedSkills].map((skill) => {
    const evidenceStrength: "STRONG" | "PARTIAL" = strong.has(skill) ? "STRONG" : "PARTIAL";
    const jdPriority = jdTierBySkill.get(skill) ?? "NOT_IN_JD";
    const recentlyUsed = recentSet.has(skill);
    const evidenceWeight = evidenceStrength === "STRONG" ? 3 : 2;
    const score = PRIORITY_WEIGHT[jdPriority] * evidenceWeight * (recentlyUsed ? 1.2 : 1.0);
    return { skill, jdPriority, evidenceStrength, recentlyUsed, score };
  });

  ranked.sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));
  return ranked;
}

/** The recommended skill ORDER (canonical names, highest-ranked first) — the raw material the writer
 *  prompt hands the LLM and the reviewer checks the actual resume.skillGroups ordering against. */
export function recommendedSkillOrder(candidateProfile: CandidateProfile, matrix: JdPriorityMatrix): string[] {
  return rankCandidateSkills(candidateProfile, matrix).map((r) => r.skill);
}
