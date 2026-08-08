import type { ExtractedEducation } from "./types";
import { classifyCueLine, toLines } from "./textUtils";

const EMPTY: ExtractedEducation = {
  level: null,
  field: null,
  requirement: "Unknown",
  equivalentExperienceAllowed: false,
  evidence: null,
};

// Ordered most-senior-first purely for readability; matching itself just takes whichever appears.
const DEGREE_PATTERNS: { level: string; regex: RegExp }[] = [
  { level: "PhD", regex: /\b(ph\.?d\.?|doctorate)\b/i },
  { level: "Master's", regex: /\b(master'?s degree|master'?s|m\.?s\.?|mba)\b/i },
  { level: "Bachelor's", regex: /\b(bachelor'?s degree|bachelor'?s|b\.?s\.?|b\.?a\.?)\b/i },
  { level: "Associate's", regex: /\b(associate'?s degree|associate'?s)\b/i },
  { level: "High School", regex: /\b(high school diploma|high school)\b/i },
];

const EQUIVALENT_EXPERIENCE = /or\s+equivalent\s+(?:work\s+)?experience/i;
// Non-greedy capture bounded by a lookahead (not consumed) so stop-words like "is"/"required" never
// end up folded into the captured field name — e.g. "in Computer Science is required" captures just
// "Computer Science".
const FIELD_FOLLOW_ON =
  /\bin\s+([A-Za-z][A-Za-z&,/]*(?:\s+[A-Za-z][A-Za-z&,/]*){0,4}?)(?=[.,;]|\s+(?:is|are|or equivalent|with|and|will|who|required|preferred)\b|$)/i;

export function extractEducation(descriptionHtml: string | null, descriptionText: string | null): ExtractedEducation {
  const lines = toLines(descriptionHtml, descriptionText);
  for (const line of lines) {
    const degreeMatch = DEGREE_PATTERNS.find((d) => d.regex.test(line));
    if (!degreeMatch) continue;

    const equivalentAllowed = EQUIVALENT_EXPERIENCE.test(line);
    const fieldMatch = line.match(FIELD_FOLLOW_ON);
    // Requirement level comes only from an explicit cue word — never fabricated from the mere
    // presence of a degree mention. "or equivalent experience" is tracked as its own independent
    // flag (equivalentAllowed) rather than folded into Required/Preferred: "Bachelor's degree or
    // equivalent experience" still names a degree, just with an alternate path to satisfy it, which
    // is a different fact than whether the degree itself is Required or Preferred.
    const requirement = classifyCueLine(line) ?? "Unknown";

    return {
      level: degreeMatch.level,
      field: fieldMatch ? fieldMatch[1].trim() : null,
      requirement,
      equivalentExperienceAllowed: equivalentAllowed,
      evidence: line,
    };
  }
  return EMPTY;
}
