import { token_sort_ratio } from "fuzzball";
import { findAliasTarget, findCandidateSponsorsByPrefix, findSponsorByNormalizedName } from "@/db/queries/h1bSponsors";
import { normalizeEmployerName } from "@/lib/h1b/normalizeEmployerName";
import {
  CERTIFIED_HIGH,
  CERTIFIED_MEDIUM,
  CERTIFIED_VERY_HIGH,
  FUZZY_HIGH_SCORE,
  FUZZY_MIN_ACCEPT_SCORE,
} from "@/lib/h1b/thresholds";
import type { H1bCompanyConfidenceResult, H1bMatchResult, H1bSponsor } from "@/types";

// Process-local memoization: matching the same company name repeatedly within one process
// lifetime (re-adding a company, a long-running dev server periodically re-matching) shouldn't
// re-run the layered lookup from scratch. clearH1bMatchCache() exists for the (rare, single-user)
// case of ingesting fresh H1B data and re-matching within the SAME process without restarting —
// ingest-h1b.ts and match-h1b.ts are normally separate script invocations, where this doesn't apply.
const matchCache = new Map<string, H1bMatchResult | null>();

export function clearH1bMatchCache(): void {
  matchCache.clear();
}

/**
 * Layered company-to-sponsor matcher. Tries progressively less certain strategies, in strict
 * priority order, and stops at the first one that succeeds — tiers are never combined or averaged:
 *
 *   1. Exact normalized match — O(1) via the unique index on h1b_sponsors, no fuzzy scoring.
 *   2. Approved alias match — a curated, human-maintained mapping (h1b_employer_aliases; empty by
 *      default, never hardcoded here) for name variants normalization alone can't bridge (a former
 *      legal name, a common brand name that differs from the DOL filing name, etc.).
 *   3. High-confidence fuzzy match — a prefix-narrowed candidate set (findCandidateSponsorsByPrefix),
 *      scored with fuzzball's token_sort_ratio, accepted only above FUZZY_MIN_ACCEPT_SCORE.
 *      Deliberately NOT token_set_ratio: that scorer is subset-tolerant (it scores "Acme" vs
 *      "Acme Global Solutions Partners" as a near-perfect match, since one's tokens are a subset
 *      of the other's) — exactly the false-positive shape this matcher must avoid. token_sort_ratio
 *      requires the token sets to actually align, so an unrelated company that merely starts with
 *      the same word scores low, not high.
 *   4. Otherwise: no match — the caller treats this as company confidence "Unknown".
 */
export function matchCompanyToSponsor(companyName: string): H1bMatchResult | null {
  const normalized = normalizeEmployerName(companyName);
  if (!normalized) return null;

  const cached = matchCache.get(normalized);
  if (cached !== undefined) return cached;

  const result = resolveMatch(normalized);
  matchCache.set(normalized, result);
  return result;
}

function resolveMatch(normalized: string): H1bMatchResult | null {
  const exact = findSponsorByNormalizedName(normalized);
  if (exact) {
    return { tier: "exact", sponsor: exact, score: 100, matchedNormalized: normalized };
  }

  const aliasTarget = findAliasTarget(normalized);
  if (aliasTarget) {
    const sponsor = findSponsorByNormalizedName(aliasTarget);
    if (sponsor) {
      return { tier: "alias", sponsor, score: 100, matchedNormalized: aliasTarget };
    }
  }

  // Prefix narrowing needs a real prefix; a short/generic first token would match too broadly, so
  // only take it as the LIKE prefix and let fuzzball do the real ranking within that candidate set.
  const prefix = normalized.split(" ")[0];
  const candidates = findCandidateSponsorsByPrefix(prefix, 50);
  let best: { sponsor: H1bSponsor; score: number } | null = null;
  for (const candidate of candidates) {
    const score = token_sort_ratio(normalized, candidate.employer_name_normalized);
    if (!best || score > best.score) {
      best = { sponsor: candidate, score };
    }
  }
  if (best && best.score >= FUZZY_MIN_ACCEPT_SCORE) {
    return {
      tier: "fuzzy",
      sponsor: best.sponsor,
      score: best.score,
      matchedNormalized: best.sponsor.employer_name_normalized,
    };
  }

  return null;
}

/**
 * Scores a match result into company-level confidence + human-readable evidence. Exact and alias
 * tiers are trusted identity matches, scored purely on certified-filing volume. The fuzzy tier is
 * deliberately capped below that: it can reach "High" only with both a near-exact score
 * (FUZZY_HIGH_SCORE+) and real volume, and can never reach "Very High" at all regardless of volume
 * — an inexact name match should never be presented with the same certainty as a confirmed identity.
 */
export function scoreCompanyConfidence(match: H1bMatchResult | null): H1bCompanyConfidenceResult {
  if (!match) {
    return { confidence: "Unknown", evidence: "No matching employer found in imported DOL H1B/LCA data." };
  }

  const { tier, sponsor, score } = match;
  const certified = sponsor.total_lca_certified;
  const years = sponsor.fiscal_years_covered ?? "unknown fiscal years";
  const tierLabel = tier === "exact" ? "Exact" : tier === "alias" ? "Alias" : `Fuzzy (${score}% similarity)`;
  const evidence = `${tierLabel} match to "${sponsor.employer_name_raw}" — ${certified} certified LCA${
    certified === 1 ? "" : "s"
  } on file (FY ${years}).`;

  if (tier === "fuzzy") {
    if (score >= FUZZY_HIGH_SCORE && certified >= CERTIFIED_HIGH) return { confidence: "High", evidence };
    if (certified >= CERTIFIED_MEDIUM) return { confidence: "Medium", evidence };
    return { confidence: "Low", evidence };
  }

  if (certified >= CERTIFIED_VERY_HIGH) return { confidence: "Very High", evidence };
  if (certified >= CERTIFIED_HIGH) return { confidence: "High", evidence };
  if (certified >= CERTIFIED_MEDIUM) return { confidence: "Medium", evidence };
  if (certified === 0) {
    return {
      confidence: "Low",
      evidence: `${evidence} No certified LCAs on file for this employer (only denied/withdrawn) — thin positive evidence.`,
    };
  }
  return { confidence: "Low", evidence };
}
