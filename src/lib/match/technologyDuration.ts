/**
 * Detects an EXPLICIT, technology-specific years-of-experience figure stated in a requirement
 * unit's own evidence text — e.g. "4+ years Databricks", "5 years Azure Data Factory", "minimum 4
 * years PySpark", "at least 5 years experience with ADF". This is TARGET evidence (what the JD
 * asked for), never candidate evidence — see tailoringIntelligence/plan.ts's DistributedEvidence
 * guidance, which reads this purely to decide whether a technology deserves distributed-evidence
 * emphasis, and NEVER to claim the candidate has this many years anywhere.
 *
 * WHY evidenceSnippets IS ALREADY THE SAFETY BOUNDARY. This function is deliberately generic — it
 * does not take a technology name and does not require one to appear near the number. That is safe
 * ONLY because its caller (requirementUnits.ts's collapseSkillUnits, unclaimedRequirementDetector.ts)
 * already scopes `evidenceSnippets` to ONE specific skill/skill-group's own JD text — a short
 * (~80-character) window built around that exact skill's own match position on its own line/bullet
 * (see jobIntel/textUtils.ts's extractSnippet). A separate JD sentence stating an OVERALL career
 * total ("10+ years of overall software engineering experience") is a different line with a
 * different skill match position, so it never becomes part of a specific technology's own snippet
 * under normal JD structure.
 *
 * THE ONE CASE THAT NEEDS AN EXPLICIT GUARD. A JD occasionally states both an overall total and a
 * specific technology requirement close together on the SAME line/bullet — e.g. "10 years overall
 * experience; Databricks required". If that whole line becomes one skill's evidence snippet, "10"
 * would sit inside this technology's own snippet even though the JD is not asking for 10 years of
 * Databricks. OVERALL_QUALIFIER below is that guard: when a years figure and a career-total word
 * ("overall", "total", "combined", "career") appear in the SAME snippet, this returns null for that
 * snippet rather than risk turning a career total into a fabricated technology-specific claim — the
 * exact regression the canonical Master Skills Inventory rule's "overall YOE is not technology-
 * specific duration" distinction exists to prevent.
 */

const TECHNOLOGY_SPECIFIC_YEARS = [
  // "4+ years", "5 years", "minimum 4 years", "at least 5 years" — an optional qualifier, the
  // number, an optional "+", and the word year(s). Deliberately does not require "of experience" or
  // a technology name adjacent — evidenceSnippets is already technology-scoped by the caller.
  /\b(?:minimum|at least|over|more than)?\s*(\d{1,2})\+?\s*years?\b/i,
];

const OVERALL_QUALIFIER = /\b(overall|total|combined|career)\b/i;

const MIN_TECHNOLOGY_YEARS = 1;
const MAX_TECHNOLOGY_YEARS = 40;

/**
 * Returns the FIRST plausible technology-specific years figure across the given snippets, or null
 * when none is stated — null is the honest, common case (most JD skill mentions carry no duration
 * qualifier at all), never guessed at.
 */
export function extractTechnologySpecificYears(evidenceSnippets: string[]): number | null {
  for (const snippet of evidenceSnippets) {
    if (!snippet) continue;
    for (const pattern of TECHNOLOGY_SPECIFIC_YEARS) {
      const match = snippet.match(pattern);
      if (!match) continue;
      if (OVERALL_QUALIFIER.test(snippet)) continue; // a career total, not this technology's own duration
      const years = Number(match[1]);
      if (!Number.isFinite(years)) continue;
      if (years < MIN_TECHNOLOGY_YEARS || years > MAX_TECHNOLOGY_YEARS) continue;
      return years;
    }
  }
  return null;
}
