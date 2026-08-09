import { getDb } from "@/db";
import type { H1bSponsor } from "@/types";

/**
 * H1B employer discovery priority — see AGENTS.md-external approved plan §13/§18: SOURCE-DISCOVERY
 * priority only, deterministic, explainable, using only fields that actually exist in
 * h1b_sponsors/employer_identity_resolutions/companies today. Never mixes in a candidate's job
 * match score — this governs "which employer do we try to identify next," fully independent of
 * any candidate's fit for any job that employer might eventually post.
 *
 * FILTER (excluded from `nextPriorityEmployers`'s result set entirely):
 *   - domain_identity_status = 'VERIFIED'         -> already resolved, skip.
 *   - domain_identity_status = 'UNRESOLVED' or 'AMBIGUOUS' -> a settled negative outcome; no
 *     automatic retry (per the approved "hard UNRESOLVED -> no automatic endless retry" rule,
 *     extended the same way to AMBIGUOUS — both need curated intervention or new evidence, not
 *     blind re-querying the same sources with the same result).
 *   - domain_identity_status = 'FAILED_TEMPORARY' -> retry-eligible ONLY after FAILED_TEMPORARY_
 *     RETRY_COOLDOWN_MS has elapsed since attempted_at.
 *   - never attempted (no employer_identity_resolutions row at all) -> always eligible.
 *
 * SORT (exact approved 6-key tuple, applied in this order):
 *   1. most_recent_fiscal_year DESC
 *   2. recent-active filer tier (a coarse bucket on top of #1 — filings within the last
 *      RECENT_FISCAL_YEAR_WINDOW years rank as one tier, older filings as another)
 *   3. total_lca_certified DESC
 *   4. existing H1B filing-confidence/evidence, where a companies row already exists for this
 *      employer (exact/alias match tier outranks fuzzy, which outranks no match) — a tiebreak
 *      only, never a primary key.
 *   5. never-attempted ranks above a FAILED_TEMPORARY retry, all else equal.
 *   6. employer_name_normalized ASC — final deterministic, stable tiebreak.
 */

export const FAILED_TEMPORARY_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
export const RECENT_FISCAL_YEAR_WINDOW_YEARS = 2;

export interface PriorityEmployer extends H1bSponsor {
  domain_identity_status: string | null; // null = never attempted
  attempted_at: string | null;
}

export function nextPriorityEmployers(limit: number, now: Date = new Date()): PriorityEmployer[] {
  const db = getDb();
  const cooldownCutoff = new Date(now.getTime() - FAILED_TEMPORARY_RETRY_COOLDOWN_MS).toISOString();
  const recentFiscalYearThreshold = now.getFullYear() - RECENT_FISCAL_YEAR_WINDOW_YEARS;

  return db
    .prepare(
      `SELECT hs.*, eir.domain_identity_status AS domain_identity_status, eir.attempted_at AS attempted_at
       FROM h1b_sponsors hs
       LEFT JOIN employer_identity_resolutions eir ON eir.h1b_sponsor_id = hs.id
       LEFT JOIN companies c ON c.id = eir.resolved_company_id
       WHERE
         eir.id IS NULL
         OR (eir.domain_identity_status = 'FAILED_TEMPORARY' AND eir.attempted_at <= @cooldownCutoff)
       ORDER BY
         hs.most_recent_fiscal_year DESC,
         CASE WHEN hs.most_recent_fiscal_year >= @recentFiscalYearThreshold THEN 0 ELSE 1 END,
         hs.total_lca_certified DESC,
         CASE c.h1b_match_tier WHEN 'exact' THEN 0 WHEN 'alias' THEN 1 WHEN 'fuzzy' THEN 2 ELSE 3 END,
         CASE WHEN eir.id IS NULL THEN 0 ELSE 1 END,
         hs.employer_name_normalized ASC
       LIMIT @limit`
    )
    .all({ cooldownCutoff, recentFiscalYearThreshold, limit }) as PriorityEmployer[];
}
