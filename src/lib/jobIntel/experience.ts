import type { ExperienceByTech, ExtractedExperience } from "./types";
import { SKILL_TAXONOMY } from "./skillsTaxonomy";
import { classifyCueLine, escapeRegExp, toLines } from "./textUtils";

const EMPTY: ExtractedExperience = { minYears: null, preferredYears: null, byTech: [], evidence: null };

// "5+ years", "5-8 years", "at least 5 years", "minimum of 3 years" — captures one or two numbers.
const YEARS_PATTERN =
  /(\d+)\s*(?:-|–|to)\s*(\d+)\s*\+?\s*years?|(\d+)\s*\+\s*years?|(?:minimum(?:\s+of)?|at least)\s*(\d+)\s*years?|(\d+)\s*years?/i;

interface ParsedYears {
  min: number;
  max: number | null;
}

function parseYearsFromMatch(m: RegExpMatchArray): ParsedYears | null {
  if (m[1] && m[2]) return { min: Number(m[1]), max: Number(m[2]) }; // "3-5 years"
  if (m[3]) return { min: Number(m[3]), max: null }; // "5+ years"
  if (m[4]) return { min: Number(m[4]), max: null }; // "minimum of 3 years" / "at least 3 years"
  if (m[5]) return { min: Number(m[5]), max: null }; // bare "5 years"
  return null;
}

function lineHasTaxonomySkill(line: string): boolean {
  return SKILL_TAXONOMY.some((entry) =>
    entry.aliases.some((alias) => new RegExp(`(?<![\\w-])${escapeRegExp(alias)}(?![\\w-])`, "i").test(line))
  );
}

/**
 * Overall years of experience: scans line-by-line for a years-pattern. Lines that also name a
 * taxonomy skill are technology-specific statements (handled by extractByTech below) and are only
 * used for the "overall" figure as a last resort, when no skill-free years statement exists at all
 * — otherwise a line like "3+ years PySpark" would wrongly become the overall minimum. Takes the
 * first qualifying statement as "minimum years", and a distinct preferred-cue statement (if any) as
 * "preferred years" (e.g. "5+ years required, 7+ years preferred").
 */
// How close "experience" (or a cue word) must be to the years-match itself to count as the same
// statement — htmlToBlockText only breaks at block-level tags, so a whole paragraph (e.g. a mission
// statement heading fused with unrelated prose by an inline <span>) can land in one "line"; without
// this a distant, unrelated "experience" elsewhere in that paragraph would false-match a company-
// history mention like "...for nearly 130 years..." as if it were an experience requirement.
const PROXIMITY_WINDOW = 50;

function extractOverallYears(lines: string[]): { min: number | null; preferred: number | null; evidence: string | null } {
  const allCandidates: { min: number; max: number | null; line: string; preferred: boolean; hasSkill: boolean }[] = [];
  for (const line of lines) {
    const m = line.match(YEARS_PATTERN);
    if (!m || m.index === undefined) continue;
    const parsed = parseYearsFromMatch(m);
    if (!parsed) continue;
    // A bare "<number> years" mention isn't necessarily an experience requirement — company-history
    // copy ("serving customers for nearly 130 years") matches the same pattern. Only count it if
    // "experience" or a required/preferred cue word appears near the match itself, or the line names
    // a specific technology (handled by extractByTech below, which doesn't need this guard since a
    // tech name right next to a years figure is unambiguous).
    const windowStart = Math.max(0, m.index - PROXIMITY_WINDOW);
    const windowEnd = Math.min(line.length, m.index + m[0].length + PROXIMITY_WINDOW);
    const window = line.slice(windowStart, windowEnd);
    const isExperienceStatement = /experience/i.test(window) || classifyCueLine(window) !== null;
    if (!isExperienceStatement && !lineHasTaxonomySkill(line)) continue;
    const preferred = /preferred|ideally|nice to have|bonus/i.test(window);
    allCandidates.push({ ...parsed, line, preferred, hasSkill: lineHasTaxonomySkill(line) });
  }
  const skillFree = allCandidates.filter((c) => !c.hasSkill);
  const candidates = skillFree.length > 0 ? skillFree : allCandidates;
  if (candidates.length === 0) return { min: null, preferred: null, evidence: null };

  const required = candidates.find((c) => !c.preferred) ?? candidates[0];
  const preferredCandidate = candidates.find((c) => c.preferred && c !== required);

  return {
    min: required.min,
    preferred: preferredCandidate ? preferredCandidate.min : required.max,
    evidence: preferredCandidate ? `${required.line} | ${preferredCandidate.line}` : required.line,
  };
}

/** Technology-specific years: for each taxonomy skill mentioned on a line that also carries a
 *  years-pattern, records that as a tech-tied requirement (e.g. "3+ years PySpark"). */
function extractByTech(lines: string[]): ExperienceByTech[] {
  const results: ExperienceByTech[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const yearsMatch = line.match(YEARS_PATTERN);
    if (!yearsMatch) continue;
    const parsed = parseYearsFromMatch(yearsMatch);
    if (!parsed) continue;
    for (const entry of SKILL_TAXONOMY) {
      if (seen.has(entry.canonical)) continue;
      const hasSkill = entry.aliases.some((alias) =>
        new RegExp(`(?<![\\w-])${escapeRegExp(alias)}(?![\\w-])`, "i").test(line)
      );
      if (hasSkill) {
        results.push({ technology: entry.canonical, years: parsed.min });
        seen.add(entry.canonical);
      }
    }
  }
  return results;
}

export function extractExperience(descriptionHtml: string | null, descriptionText: string | null): ExtractedExperience {
  const lines = toLines(descriptionHtml, descriptionText);
  if (lines.length === 0) return EMPTY;

  const overall = extractOverallYears(lines);
  const byTech = extractByTech(lines);

  if (overall.min === null && byTech.length === 0) return EMPTY;

  return {
    minYears: overall.min,
    preferredYears: overall.preferred,
    byTech,
    evidence: overall.evidence,
  };
}
