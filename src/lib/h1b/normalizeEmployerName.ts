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

/**
 * Normalizes an employer name into a stable identity for exact-match lookup: uppercase, punctuation
 * and whitespace normalized, then trailing corporate-suffix words iteratively stripped. Pure and
 * side-effect-free — deliberately not cached itself (see normalizeEmployerNameCached below for the
 * hot-loop wrapper) so it stays trivial to unit test.
 *
 * "Google LLC", "Google Inc.", "GOOGLE" all resolve to "GOOGLE".
 */
export function normalizeEmployerName(name: string): string {
  const cleaned = name
    .toUpperCase()
    .replace(/[.,'’]/g, "")
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned.split(" ").filter(Boolean);
  while (tokens.length > 1 && SUFFIX_WORDS.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  return tokens.join(" ");
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
