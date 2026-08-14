import type { RequiredCorrection } from "../types";
import type { ExperienceEntry } from "../../../../tools/tailoring-engine/types";
import { findBannedLanguage } from "./bannedLanguage";

/**
 * Deterministic, objective bullet-quality heuristics — never a semantic/business-impact judgment
 * (that stays out of scope for Stage 8, per the spec's "Do NOT try to semantically judge business
 * impact with AI. Only flag objective/heuristic issues.").
 */

const GENERIC_OPENERS = [
  /^responsible for\b/i,
  /^worked on\b/i,
  /^helped with\b/i,
  /^helped\b/i,
  /^assisted with\b/i,
  /^involved in\b/i,
  /^participated in\b/i,
];

const MIN_WORDS = 5;
const MAX_WORDS = 40;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeForDuplicateCheck(text: string): string {
  return text.trim().toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");
}

/** First word of a bullet, used for "too many consecutive bullets with the same opening verb"
 *  within one role — mirrors the source instructions' own "don't start more than two consecutive
 *  bullets in the same role with the same verb" rule. */
function openingWord(text: string): string {
  return text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^\w]/g, "") ?? "";
}

export interface BulletCheckResult {
  genericBullets: string[];
  corrections: RequiredCorrection[];
  /** Deduction contribution to recruiterReadabilityScore — the caller combines this with other
   *  readability-affecting checks. */
  readabilityDeductions: number;
}

export function evaluateBulletChecks(experience: ExperienceEntry[]): BulletCheckResult {
  const genericBullets: string[] = [];
  const corrections: RequiredCorrection[] = [];
  let readabilityDeductions = 0;

  const allBulletsNormalized = new Map<string, string[]>(); // normalized -> original bullets (for cross-role duplicate detection)

  for (const role of experience) {
    let consecutiveSameVerb = 1;
    let lastVerb = "";

    role.bullets.forEach((bullet, i) => {
      const trimmed = bullet.trim();
      if (trimmed.length === 0) return;

      // Generic openers.
      if (GENERIC_OPENERS.some((re) => re.test(trimmed))) {
        genericBullets.push(trimmed);
        corrections.push({ priority: "MEDIUM", description: `Generic bullet opener in ${role.company || `role #${i + 1}`}: "${trimmed}"` });
        readabilityDeductions += 5;
      }

      // Length heuristics.
      const words = wordCount(trimmed);
      if (words < MIN_WORDS) {
        genericBullets.push(trimmed);
        corrections.push({ priority: "LOW", description: `Very short bullet in ${role.company}: "${trimmed}"` });
        readabilityDeductions += 3;
      } else if (words > MAX_WORDS) {
        corrections.push({ priority: "LOW", description: `Overly long/run-on bullet in ${role.company} (${words} words): "${trimmed}"` });
        readabilityDeductions += 3;
      }

      // Banned language.
      const banned = findBannedLanguage(trimmed);
      if (banned.length > 0) {
        corrections.push({
          priority: "MEDIUM",
          description: `Banned AI-sounding language (${banned.join(", ")}) in ${role.company}: "${trimmed}"`,
        });
        readabilityDeductions += 5 * banned.length;
      }

      // Repeated opening verb, consecutive within the same role.
      const verb = openingWord(trimmed);
      if (verb && verb === lastVerb) {
        consecutiveSameVerb += 1;
        if (consecutiveSameVerb > 2) {
          corrections.push({
            priority: "MEDIUM",
            description: `More than two consecutive bullets in ${role.company} start with "${verb}".`,
          });
          readabilityDeductions += 5;
        }
      } else {
        consecutiveSameVerb = 1;
      }
      lastVerb = verb;

      // Duplicate/near-duplicate bullet text, including across employers.
      const normalized = normalizeForDuplicateCheck(trimmed);
      const existing = allBulletsNormalized.get(normalized) ?? [];
      if (existing.length > 0) {
        corrections.push({
          priority: "HIGH",
          description: `Duplicate or near-identical bullet text: "${trimmed}" (also appears in ${existing.length} other role(s)).`,
        });
        readabilityDeductions += 10;
      }
      allBulletsNormalized.set(normalized, [...existing, role.company]);
    });
  }

  return { genericBullets, corrections, readabilityDeductions };
}
