/** Tunable thresholds for the layered H1B matcher and confidence scorer (fuzzyMatch.ts). */

// Fuzzy tier acceptance floor: below this similarity, no fuzzy match is asserted at all — the
// company falls through to Unknown rather than guessing. Deliberately conservative per "never use
// aggressive fuzzy matching that creates false positives."
export const FUZZY_MIN_ACCEPT_SCORE = 88;

// A fuzzy match at or above this similarity is "near-exact" for confidence purposes — the fuzzy
// tier still can't reach "Very High" regardless of score (see scoreCompanyConfidence), but this is
// required (together with real filing volume) for it to reach "High".
export const FUZZY_HIGH_SCORE = 95;

// Filing-volume thresholds (certified LCA count), applied identically to the exact and alias tiers.
export const CERTIFIED_VERY_HIGH = 50;
export const CERTIFIED_HIGH = 10;
export const CERTIFIED_MEDIUM = 2;
