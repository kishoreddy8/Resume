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

const ALTERNATION_CONNECTOR = /^\s*,?\s*(?:or|\/)\s*$/i;

/** A bare comma between two skills. On its own this is ambiguous — "Python, SQL" is a plain AND
 *  list — so it joins an alternation only when a later connector in the SAME run supplies an
 *  explicit "or"/"/". See groupAlternatives. */
const LIST_COMMA_CONNECTOR = /^\s*,\s*$/;

type ConnectorKind = "ALTERNATION" | "LIST_COMMA" | "BREAK";

/**
 * Groups adjacent matches on one line into OR-alternative groups, so "AWS or Azure" becomes one
 * alternative-group requirement instead of two independent required skills.
 *
 * STAGE 24C — WHY THIS IS RUN-BASED RATHER THAN PAIRWISE. The previous implementation extended a
 * group only while each ADJACENT connector itself contained "or"/"/". In an English 3+ item
 * alternative list the "or" appears exactly once, before the LAST item, so every earlier item was
 * split off as an independent requirement: "Databricks, Snowflake, or Redshift" produced a
 * standalone Required "Databricks" PLUS a "Snowflake OR Redshift" group — i.e. the candidate had to
 * possess Databricks AND one of the other two. That breaks the "required alternatives must remain
 * alternatives" rule on the single most common way a job description writes one, and it failed on
 * this function's own previously-documented example, "AWS, Azure, or GCP".
 *
 * THE RULE NOW: a maximal RUN of matches joined only by alternation connectors and bare list commas
 * collapses into ONE alternative group — but only if at least one connector inside that run is an
 * explicit "or"/"/". A run joined by commas alone stays a set of INDEPENDENT requirements (a plain
 * "Python, SQL, Spark" list is an AND list, not an alternation), and any other connector — notably
 * ", and " — ends the run outright. Conservative in both directions: no alternation is ever invented
 * without an explicit "or"/"/", and none is split apart once one is present.
 */
function groupAlternatives(matches: LineMatch[], line: string): LineMatch[][] {
  if (matches.length === 0) return [];

  // connectors[i] is the text between matches[i] and matches[i + 1].
  const connectors: ConnectorKind[] = [];
  for (let i = 1; i < matches.length; i++) {
    const text = line.slice(matches[i - 1].end, matches[i].start);
    connectors.push(
      ALTERNATION_CONNECTOR.test(text) ? "ALTERNATION" : LIST_COMMA_CONNECTOR.test(text) ? "LIST_COMMA" : "BREAK"
    );
  }

  const groups: LineMatch[][] = [];
  let runStart = 0;
  for (let i = 0; i < matches.length; i++) {
    if (i !== matches.length - 1 && connectors[i] !== "BREAK") continue;
    const run = matches.slice(runStart, i + 1);
    // connectors.slice(runStart, i) is exactly the connectors strictly INSIDE this run.
    const isAlternation = run.length > 1 && connectors.slice(runStart, i).some((c) => c === "ALTERNATION");
    if (isAlternation) groups.push(run);
    else for (const m of run) groups.push([m]);
    runStart = i + 1;
  }
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
