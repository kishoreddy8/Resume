import { token_set_ratio } from "fuzzball";
import { findCandidateSponsors } from "@/db/queries/h1bSponsors";
import type { H1bSignal, H1bSponsor } from "@/types";
import { normalizeEmployerName } from "@/lib/h1b/normalizeEmployerName";
import {
  EXACT_MATCH_SCORE,
  HIGH_CERTIFIED_COUNT,
  MEDIUM_CERTIFIED_COUNT,
  MIN_CANDIDATE_SCORE,
  STRONG_MATCH_MEDIUM_CERTIFIED_COUNT,
  STRONG_MATCH_SCORE,
} from "@/lib/h1b/thresholds";

export interface H1bMatchResult {
  sponsor: H1bSponsor;
  score: number;
  signal: H1bSignal;
}

function scoreToSignal(score: number, certifiedCount: number): H1bSignal {
  if (score >= EXACT_MATCH_SCORE) {
    if (certifiedCount >= HIGH_CERTIFIED_COUNT) return "High";
    if (certifiedCount >= MEDIUM_CERTIFIED_COUNT) return "Medium";
    return "Low";
  }
  if (score >= STRONG_MATCH_SCORE) {
    return certifiedCount >= STRONG_MATCH_MEDIUM_CERTIFIED_COUNT ? "Medium" : "Low";
  }
  if (score >= MIN_CANDIDATE_SCORE) return "Low";
  return "Unknown";
}

/**
 * Matches a company name against the ingested DOL H1B LCA sponsor history.
 * Narrows candidates via an indexed prefix LIKE, then scores each with fuzzball.
 */
export function matchCompanyToSponsor(companyName: string): H1bMatchResult | null {
  const normalized = normalizeEmployerName(companyName);
  if (!normalized) return null;

  // Prefix narrowing needs a real prefix; a short/generic name would match too broadly,
  // so only take the first token as the LIKE prefix and let fuzzball do the real ranking.
  const prefix = normalized.split(" ")[0];
  const candidates = findCandidateSponsors(prefix, 50);
  if (candidates.length === 0) return null;

  let best: { sponsor: H1bSponsor; score: number } | null = null;
  for (const candidate of candidates) {
    const score = token_set_ratio(normalized, candidate.employer_name_normalized);
    if (!best || score > best.score) {
      best = { sponsor: candidate, score };
    }
  }

  if (!best || best.score < MIN_CANDIDATE_SCORE) return null;

  return {
    sponsor: best.sponsor,
    score: best.score,
    signal: scoreToSignal(best.score, best.sponsor.total_lca_certified),
  };
}
