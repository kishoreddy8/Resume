/**
 * Deterministic location compatibility for application-field resolution.
 *
 * Greenhouse (and similar ATS boards) return canonical location strings such as
 * "Dallas, Texas, United States" while the candidate's verified profile stores a compact form such
 * as "Dallas, TX" or "Dallas, Texas". The exact-match executor cannot bridge that gap by default.
 *
 * This module provides TWO things and nothing else:
 *
 *   1. `locationsCompatible` — decides whether a profile location and an ATS option describe the
 *      SAME physical city, using structured city + state comparison.
 *
 *   2. `findCanonicalLocation` — given a profile location and a list of ATS option strings, returns
 *      the one unambiguous option that is compatible, or null when none matches or the match is
 *      ambiguous (two compatible options → cannot safely auto-select).
 *
 * SAFETY RULES:
 *   • City match is case-insensitive exact equality — never prefix, suffix, or substring.
 *   • State is normalised to code (TX / GA / OR …). A mismatch is an immediate false.
 *   • If the ATS option carries a state but the profile does not, we return false: we cannot
 *     confirm the candidate is in Texas just because the city name is Dallas.
 *   • If two or more ATS options are both compatible, null is returned: ambiguity is never resolved
 *     by position or heuristic.
 *
 * These rules mean the normaliser will sometimes return null on a perfectly safe match
 * (e.g. profile "Dallas" with no state, single ATS option "Dallas, Texas, United States").
 * That is correct — Career-Ops never guesses a state the user hasn't confirmed.
 */

/** US state abbreviation → full state name. Kept here so apply/ is independent of jobLocationScope. */
const STATE_CODE_TO_NAME: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

const STATE_NAME_TO_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(STATE_CODE_TO_NAME).map(([code, name]) => [name.toLowerCase(), code])
);

interface ParsedLocation {
  city: string;
  /** Normalised two-letter US state code, or null when no state was recognised. */
  stateCode: string | null;
}

/** Split by comma, trim, ignore empty parts. */
function splitParts(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolve a string to a US state code.
 * Accepts "TX" (code) or "Texas" (full name), case-insensitive.
 */
function toStateCode(s: string): string | null {
  const upper = s.trim().toUpperCase();
  if (STATE_CODE_TO_NAME[upper]) return upper;
  return STATE_NAME_TO_CODE[s.trim().toLowerCase()] ?? null;
}

/**
 * Parse the city and (optional) state from a free-text location string.
 *
 * Understands all of:
 *   "Dallas,TX"                       → { city: "Dallas", stateCode: "TX" }
 *   "Dallas, TX"                      → { city: "Dallas", stateCode: "TX" }
 *   "Dallas, Texas"                   → { city: "Dallas", stateCode: "TX" }
 *   "Dallas, Texas, United States"    → { city: "Dallas", stateCode: "TX" }
 *   "Dallas"                          → { city: "Dallas", stateCode: null }
 */
function parseLocation(raw: string): ParsedLocation {
  const parts = splitParts(raw);
  const city = parts[0] ?? "";
  const statePart = parts[1] ?? null;
  const stateCode = statePart ? toStateCode(statePart) : null;
  return { city, stateCode };
}

/**
 * True when `profileRaw` and `atsCandidateRaw` describe the same physical city.
 *
 * Rules (in order):
 *   1. Cities must match case-insensitively.
 *   2. If the ATS option has a state and the profile does not → false (can't confirm state).
 *   3. If both have a state and the states differ → false.
 *   4. Otherwise → true.
 */
export function locationsCompatible(profileRaw: string, atsCandidateRaw: string): boolean {
  const profile = parseLocation(profileRaw);
  const ats = parseLocation(atsCandidateRaw);

  if (profile.city.toLowerCase() !== ats.city.toLowerCase()) return false;
  if (ats.stateCode && !profile.stateCode) return false;
  if (profile.stateCode && ats.stateCode && profile.stateCode !== ats.stateCode) return false;

  return true;
}

/**
 * Return the single ATS option that is unambiguously compatible with the profile location,
 * or null when no option matches or more than one matches.
 *
 * Example:
 *   profile: "Dallas, TX"
 *   options: ["Dallas, Texas, United States", "Dallas, Georgia, United States"]
 *   → "Dallas, Texas, United States"   (TX disambiguates; Georgia is excluded)
 *
 * Example (ambiguous / no profile state):
 *   profile: "Dallas"
 *   options: ["Dallas, Texas, United States", "Dallas, Georgia, United States"]
 *   → null   (profile has no state → cannot safely confirm either)
 */
export function findCanonicalLocation(profileRaw: string, atsOptions: readonly string[]): string | null {
  const matches = atsOptions.filter((opt) => locationsCompatible(profileRaw, opt));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
