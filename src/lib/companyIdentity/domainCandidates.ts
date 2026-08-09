import { normalizeEmployerName } from "@/lib/h1b/normalizeEmployerName";

/**
 * Layer 2 of the domain-resolution waterfall (see resolveDomain.ts): a SMALL, CONSERVATIVE set of
 * candidate domains generated deterministically from a normalized employer name. Every candidate
 * here is UNTRUSTED input — reaching this list proves nothing about a domain's correctness, only
 * that it's worth attempting verification (verifyDomain.ts) against. This module intentionally does
 * NOT try to be clever: no abbreviation guessing (e.g. never invents "ey.com" for "Ernst & Young"),
 * no acronym expansion, no fuzzy spelling variants — that kind of guessing is exactly what produces
 * false-positive-prone candidates, and the whole point of keeping this dumb is that verifyDomain.ts
 * (not this module) carries the actual evidentiary weight.
 *
 * Reuses normalizeEmployerName verbatim (the same corporate-suffix-stripping identity function the
 * H1B matcher uses) rather than inventing competing normalization logic.
 */

const MIN_COMPACT_LENGTH = 3; // guards against a near-empty/degenerate normalized name producing
// a domain candidate too short/generic to mean anything (e.g. a two-letter fragment).

export function generateDomainCandidates(employerNameRaw: string): string[] {
  const normalized = normalizeEmployerName(employerNameRaw);
  if (!normalized) return [];

  const words = normalized
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return [];

  const compact = words.join("");
  if (compact.length < MIN_COMPACT_LENGTH) return [];

  const hyphenated = words.join("-");

  const candidates = [`${compact}.com`];
  if (hyphenated !== compact) candidates.push(`${hyphenated}.com`);
  return candidates;
}
