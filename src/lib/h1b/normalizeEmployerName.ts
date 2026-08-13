/**
 * Legal-entity / corporate-suffix words stripped from the END of an employer name only — never
 * mid-name. That distinction matters: "Group Health Cooperative" keeps "Group" (it's the first
 * word, not a trailing suffix), while "Acme Holdings Group LLC" correctly peels off "LLC", then
 * "Group", then "Holdings" (each iteration re-checks the new last token, so compound suffixes fully
 * strip). Matching mid-name would risk false-positive identity collisions between two genuinely
 * different companies that happen to share a common word like "Systems" or "Technologies".
 */
const SUFFIX_WORDS = new Set([
  "incorporated",
  "corporation",
  "company",
  "limited",
  "inc",
  "llc",
  "llp",
  "ltd",
  "corp",
  "co",
  "plc",
  "pllc",
  "technologies",
  "technology",
  "systems",
  "group",
  "holdings",
]);

// Domain ownership needs a stricter comparison than DOL-record consolidation. Words such as
// "Technologies", "Systems", "Group", and "Holdings" may be safely peeled for sponsor rollups,
// but they distinguish real legal entities when deciding whether a public website belongs to an
// employer (for example, Quantum Technologies Inc. is not Quantum Corporation).
const LEGAL_SUFFIX_WORDS = new Set([
  "incorporated",
  "corporation",
  "company",
  "limited",
  "inc",
  "llc",
  "llp",
  "ltd",
  "corp",
  "co",
  "plc",
  "pllc",
]);

function cleanAndStripSuffixes(name: string, suffixes: Set<string>): string {
  const cleaned = name
    .toUpperCase()
    .replace(/[.,'’]/g, "")
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned.split(" ").filter(Boolean);
  while (tokens.length > 1 && suffixes.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  return tokens.join(" ");
}

/**
 * Normalizes an employer name into a stable identity for exact-match lookup: uppercase, punctuation
 * and whitespace normalized, then trailing corporate-suffix words iteratively stripped. Pure and
 * side-effect-free — deliberately not cached itself (see normalizeEmployerNameCached below for the
 * hot-loop wrapper) so it stays trivial to unit test.
 *
 * "Google LLC", "Google Inc.", "GOOGLE" all resolve to "GOOGLE".
 */
export function normalizeEmployerName(name: string): string {
  return cleanAndStripSuffixes(name, SUFFIX_WORDS);
}

/** Strict legal-identity normalization for first-party domain ownership checks. */
export function normalizeEmployerLegalName(name: string): string {
  return cleanAndStripSuffixes(name, LEGAL_SUFFIX_WORDS);
}

const normalizeCache = new Map<string, string>();

/**
 * Memoized wrapper for hot loops — ingesting a DOL LCA disclosure CSV means normalizing the same
 * handful of thousands of distinct employer names across millions of case rows. Unbounded cache is
 * fine: employer-name cardinality is bounded (tens/hundreds of thousands at most) and this is
 * scoped to one process's lifetime (an ingest script run, or the app server), not persisted.
 */
export function normalizeEmployerNameCached(name: string): string {
  const cached = normalizeCache.get(name);
  if (cached !== undefined) return cached;
  const normalized = normalizeEmployerName(name);
  normalizeCache.set(name, normalized);
  return normalized;
}

export function clearNormalizeCache(): void {
  normalizeCache.clear();
}
