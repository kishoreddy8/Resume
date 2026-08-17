import type { ExperienceEntry } from "../../../tools/tailoring-engine/types";
import type { JdPriorityMatrix, JdPriorityTier } from "./jdPriorityMatrix";
import { extractCanonicalSkillsFromText, resolveSkillForReview } from "./reviewers/skillAliases";

/**
 * Stage 21 (Evidence-Grounded Resume Quality V2) — NEXT 4: experience bullet ranking. Scores each
 * EXISTING, already-evidence-grounded bullet (this module never invents bullet text) by how strongly
 * it evidences the JD's own priority requirements, so the reviewer can catch a role's most JD-relevant
 * accomplishment being buried below weaker ones, and the writer prompt can be told which existing
 * accomplishments to lead with.
 *
 * jdRelevanceScore = sum of PRIORITY_WEIGHT for every JD requirement tier a bullet's OWN mentioned
 * technologies belong to (a bullet mentioning a P1 and a P3 technology scores higher than one
 * mentioning only a P3). Redundancy is NOT scored here — it's already covered by the existing
 * duplicate-bullet detection in reviewers/bulletChecks.ts (noDuplicateBulletPhrasing); this module
 * only adds relevance ranking on top, never a second duplicate detector.
 */

const PRIORITY_WEIGHT: Record<JdPriorityTier, number> = { P0: 5, P1: 5, P2: 4, P3: 3, P4: 2, P5: 1 };

export interface RankedBullet {
  employer: string;
  bullet: string;
  index: number; // original position within that employer's bullets, for ordering diagnostics
  jdRelevanceScore: number;
  matchedRequirements: string[];
}

function requirementTierBySkill(matrix: JdPriorityMatrix): Map<string, { tier: JdPriorityTier; label: string }> {
  const map = new Map<string, { tier: JdPriorityTier; label: string }>();
  for (const req of matrix.requirements) {
    for (const member of req.memberSkillNames) {
      const canonical = resolveSkillForReview(member)?.canonical ?? member;
      const existing = map.get(canonical);
      if (!existing || PRIORITY_WEIGHT[req.priority] > PRIORITY_WEIGHT[existing.tier]) {
        map.set(canonical, { tier: req.priority, label: req.requirement });
      }
    }
  }
  return map;
}

export function rankBulletsForEntry(entry: ExperienceEntry, matrix: JdPriorityMatrix): RankedBullet[] {
  const tierBySkill = requirementTierBySkill(matrix);
  return entry.bullets.map((bullet, index) => {
    const skills = extractCanonicalSkillsFromText(bullet);
    let score = 0;
    const matchedRequirements: string[] = [];
    for (const skill of skills) {
      const match = tierBySkill.get(skill);
      if (match) {
        score += PRIORITY_WEIGHT[match.tier];
        matchedRequirements.push(match.label);
      }
    }
    return { employer: entry.company, bullet, index, jdRelevanceScore: score, matchedRequirements };
  });
}

export interface BulletOrderingIssue {
  employer: string;
  description: string;
}

/** A gap of 3 is the smallest DISTINCT-tier difference the weight scale can produce (e.g. P4(2) vs
 *  P2(4) or P1(5)) — smaller gaps are same-tier or adjacent-tier variation, treated as legitimate
 *  narrative-flow ordering rather than a real priority violation. */
const MATERIAL_GAP_THRESHOLD = 3;

/** Soft (non-truthfulness) ordering check: within a role, a later bullet should never score
 *  materially higher than an earlier one when a real JD priority gap exists — i.e. the strongest
 *  JD-relevant accomplishment should not be buried. Deliberately tolerant of ties/near-ties (a
 *  MATERIAL gap, not any gap, since some legitimate orderings are driven by narrative flow, not pure
 *  JD-score). Never suggests rewriting a bullet's TEXT — only that its position could be reconsidered. */
export function evaluateBulletOrdering(experience: ExperienceEntry[], matrix: JdPriorityMatrix): BulletOrderingIssue[] {
  const issues: BulletOrderingIssue[] = [];
  for (const entry of experience) {
    const ranked = rankBulletsForEntry(entry, matrix);
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        if (ranked[j].jdRelevanceScore >= ranked[i].jdRelevanceScore + MATERIAL_GAP_THRESHOLD) {
          issues.push({
            employer: entry.company,
            description: `At ${entry.company}, a later bullet ("${ranked[j].bullet.slice(0, 80)}...", relevance ${ranked[j].jdRelevanceScore}) is materially more JD-relevant than an earlier one ("${ranked[i].bullet.slice(0, 80)}...", relevance ${ranked[i].jdRelevanceScore}) — consider reordering so the strongest evidence leads.`,
          });
        }
      }
    }
  }
  return issues;
}
