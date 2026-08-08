import type { DescriptionSections, RequirementLevel } from "@/types";
import type { SkillMatch } from "./types";
import { SKILL_TAXONOMY, type SkillTaxonomyEntry } from "./skillsTaxonomy";
import { classifyCueLine, escapeRegExp, extractSnippet } from "./textUtils";

// Longest alias first so e.g. "azure data factory" is tried before the shorter "azure" alias
// (belonging to a different taxonomy entry) can steal part of the match.
const ALL_ALIASES: { entry: SkillTaxonomyEntry; alias: string; regex: RegExp }[] = SKILL_TAXONOMY.flatMap((entry) =>
  entry.aliases.map((alias) => ({
    entry,
    alias,
    regex: new RegExp(`(?<![\\w-])${escapeRegExp(alias)}(?![\\w-])`, "i"),
  }))
).sort((a, b) => b.alias.length - a.alias.length);

interface LineMatch {
  entry: SkillTaxonomyEntry;
  start: number;
  end: number;
}

/** Finds every non-overlapping taxonomy match in one line, longest alias wins on overlap. */
function findMatchesInLine(line: string): LineMatch[] {
  const taken: { start: number; end: number }[] = [];
  const matches: LineMatch[] = [];
  for (const { entry, regex } of ALL_ALIASES) {
    const re = new RegExp(regex.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const overlaps = taken.some((t) => start < t.end && end > t.start);
      if (!overlaps) {
        taken.push({ start, end });
        matches.push({ entry, start, end });
      }
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

const ALTERNATION_CONNECTOR = /^\s*(?:,?\s*(?:or|\/)\s*)\s*$/i;

/** Groups adjacent matches on one line joined only by "or"/"/" (optionally with a comma for
 *  3+ item lists, e.g. "AWS, Azure, or GCP") so "AWS or Azure" becomes one alternative-group
 *  requirement instead of two independent required skills. */
function groupAlternatives(matches: LineMatch[], line: string): LineMatch[][] {
  const groups: LineMatch[][] = [];
  let current: LineMatch[] = [];
  for (let i = 0; i < matches.length; i++) {
    if (current.length === 0) {
      current.push(matches[i]);
      continue;
    }
    const prev = current[current.length - 1];
    const connector = line.slice(prev.end, matches[i].start);
    if (ALTERNATION_CONNECTOR.test(connector)) {
      current.push(matches[i]);
    } else {
      groups.push(current);
      current = [matches[i]];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Counter is scoped to a single extractSkills() call (passed in, never module-level state) so
 *  results stay deterministic — re-running extraction on identical input must produce identical
 *  alternative_group_id values, not ever-growing ones from a shared mutable counter. */
function buildMatchesForLine(
  line: string,
  requirementLevel: RequirementLevel | null,
  source: string,
  counter: { n: number }
): SkillMatch[] {
  const matches = findMatchesInLine(line);
  if (matches.length === 0) return [];
  const level = requirementLevel ?? classifyCueLine(line);
  if (!level) return []; // no requirement-level evidence at all — do not fabricate one

  const groups = groupAlternatives(matches, line);
  const result: SkillMatch[] = [];
  for (const group of groups) {
    const alternativeGroupId = group.length > 1 ? `alt-${source}-${counter.n++}` : null;
    for (const m of group) {
      result.push({
        skillName: m.entry.canonical,
        category: m.entry.category,
        requirementLevel: level,
        alternativeGroupId,
        evidenceSnippet: extractSnippet(line, m.start, m.end - m.start, 40),
      });
    }
  }
  return result;
}

export interface ExtractSkillsInput {
  descriptionText: string | null;
  descriptionHtml: string | null;
  sections: DescriptionSections | null;
}

/**
 * Precedence: explicit section membership (tier 2 — a match inside the Required/Preferred
 * Qualifications bucket is classified accordingly regardless of cue words in that line) beats
 * cue-word classification of the raw description text (tier 3). A skill mention with neither
 * signal is evidence but is never asserted as Required or Preferred — "do not classify every
 * mentioned technology as required."
 */
export function extractSkills(input: ExtractSkillsInput): SkillMatch[] {
  const byName = new Map<string, SkillMatch>();
  const counter = { n: 0 };
  const addAll = (matches: SkillMatch[]) => {
    for (const m of matches) {
      const key = m.skillName.toLowerCase();
      if (!byName.has(key)) byName.set(key, m);
    }
  };

  const { sections } = input;
  if (sections?.qualifications) {
    for (const line of sections.qualifications.split("\n")) {
      addAll(buildMatchesForLine(line, "Required", "qualifications", counter));
    }
  }
  if (sections?.niceToHave) {
    for (const line of sections.niceToHave.split("\n")) {
      addAll(buildMatchesForLine(line, "Preferred", "niceToHave", counter));
    }
  }
  if (sections?.skills) {
    for (const line of sections.skills.split("\n")) {
      addAll(buildMatchesForLine(line, null, "skills", counter));
    }
  }

  // Fallback: anything not already found via a section, scanned from the full description with
  // cue-word classification only (tier 3). Uses descriptionText (single-line) split into rough
  // sentences so cue words stay local to the clause that actually contains them.
  const fallbackText = input.descriptionText ?? "";
  if (fallbackText) {
    const sentences = fallbackText.split(/(?<=[.;])\s+/);
    for (const sentence of sentences) {
      addAll(buildMatchesForLine(sentence, null, "fullText", counter));
    }
  }

  return Array.from(byName.values());
}
