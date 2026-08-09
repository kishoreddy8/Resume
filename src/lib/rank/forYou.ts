import type { Decision } from "@/lib/match/types";
import type { H1bJobConfidence, SponsorshipPolarity } from "@/types";

/**
 * Phase 2.5 — deterministic "For You" ranking (see CAREER_OPS_HANDOFF.md's Phase 2.5 design record
 * §3/§4/§11/§16). Pure, DB-free, no AI: takes already-fetched per-job facts and returns a sorted
 * copy. Every constant below is named and calibratable without restructuring the sort — see
 * SCORE_BAND_WIDTH's own comment for why a band, not raw score, is the fit key.
 *
 * NEVER changes Phase 2 scoring/eligibility — this only orders jobs whose overallScore/decision
 * were already computed exactly as before. Ranking preference (role family) never touches those
 * inputs; it only participates in the SORT KEY.
 */

/** Rounds overallScore down to the nearest multiple of this width before comparing fit — lets
 *  sponsorship priority (a real, requested signal) decide between "comparably strong" candidates
 *  (e.g. 92 vs 88, same 80s band) without ever letting it override a genuinely large fit gap (e.g.
 *  92 vs 55, different bands — band always wins). Named/exported so it can be recalibrated without
 *  touching the comparator itself. */
export const SCORE_BAND_WIDTH = 10;

/** 0–10 days = primary, 11–20 = secondary, unknown = its own tier (never conflated with primary),
 *  >20 = stale/excluded from the default For You view. See CAREER_OPS_HANDOFF.md's Phase 2.5 design
 *  record §14/§19 — this is a ranking/display rule only, independent of Phase 1's lifecycle sweep. */
export const FRESHNESS_PRIMARY_MAX_DAYS = 10;
export const FRESHNESS_SECONDARY_MAX_DAYS = 20;

export type FreshnessTier = "PRIMARY" | "SECONDARY" | "UNKNOWN_DATE" | "STALE";
export type RoleFamilyTier = "PRIMARY" | "SECONDARY" | "NONE";

export interface ForYouMatch {
  decision: Decision;
  overallScore: number;
  employerEvidencedShare: number;
  requirementCoverage: number;
}

export interface ForYouJobInput {
  jobId: number;
  dedupeKey: string;
  title: string;
  /** ISO string or null — null means genuinely unknown, never substituted with first_seen_at. */
  postedAt: string | null;
  h1bCombinedConfidence: H1bJobConfidence;
  /** Job-level explicit JD sponsorship language (src/lib/h1b/*) — distinct from
   *  h1bCombinedConfidence, needed to tell "explicit JD positive" apart from "silent + strong
   *  historical" even though both can produce the same combined confidence label. */
  sponsorshipMentioned: boolean;
  sponsorshipPolarity: SponsorshipPolarity;
  /** Absent = NOT_EVALUATED for this candidate (no job_match_results row yet) — never fabricated. */
  match?: ForYouMatch;
  /** From candidate_job_state; absent/false = not excluded. */
  notInterested: boolean;
  /** Precomputed by the caller from candidate_settings.primaryTargetRole/secondaryTargetRoles
   *  against this job's title/category — kept out of this module so it stays free of any keyword-
   *  matching policy, matching the "ranking-only, never touches score" boundary. */
  roleFamilyTier: RoleFamilyTier;
}

export interface RankedForYouJob extends ForYouJobInput {
  freshnessTier: FreshnessTier;
  decisionRank: number;
  sponsorshipTier: number;
}

const ROLE_FAMILY_RANK: Record<RoleFamilyTier, number> = { PRIMARY: 0, SECONDARY: 1, NONE: 2 };

/** READY(0) < NEEDS_REVIEW(1) < NOT_EVALUATED(2) < BLOCKED(3) — see design record §11/§12: a
 *  not-yet-evaluated job must never be fabricated a score, but also must not be buried behind a
 *  confirmed BLOCKED job. */
function decisionRank(match: ForYouMatch | undefined): number {
  if (!match) return 2;
  if (match.decision === "READY_FOR_TAILORING") return 0;
  if (match.decision === "NEEDS_REVIEW") return 1;
  return 3; // BLOCKED
}

/** explicit_positive(0) < silent+strong history(1) < silent+weaker history(2) < unknown(3) <
 *  explicit_negative(4) — see design record §4. Explicit JD language always outranks historical
 *  inference, matching src/lib/h1b/combineSignal.ts's own "JD always overrides" philosophy, just
 *  applied to ranking instead of the confidence computation itself (which stays untouched). */
function sponsorshipTier(job: Pick<ForYouJobInput, "h1bCombinedConfidence" | "sponsorshipMentioned" | "sponsorshipPolarity">): number {
  if (job.sponsorshipMentioned && job.sponsorshipPolarity === "positive") return 0;
  if (job.h1bCombinedConfidence === "Not Sponsoring") return 4;
  if (job.h1bCombinedConfidence === "Very High" || job.h1bCombinedConfidence === "High") return 1;
  if (job.h1bCombinedConfidence === "Medium" || job.h1bCombinedConfidence === "Low") return 2;
  return 3; // Unknown
}

/** Never substitutes first_seen_at for a missing posted_at — a null date gets its own tier, not a
 *  fabricated freshness. See design record §14/§19/PART T. */
export function computeFreshnessTier(postedAt: string | null, now: Date = new Date()): FreshnessTier {
  if (postedAt === null) return "UNKNOWN_DATE";
  const posted = new Date(postedAt);
  if (Number.isNaN(posted.getTime())) return "UNKNOWN_DATE";
  const ageDays = Math.floor((now.getTime() - posted.getTime()) / (24 * 60 * 60 * 1000));
  if (ageDays < 0) return "UNKNOWN_DATE"; // future-dated: don't trust it as fresh, don't guess
  if (ageDays <= FRESHNESS_PRIMARY_MAX_DAYS) return "PRIMARY";
  if (ageDays <= FRESHNESS_SECONDARY_MAX_DAYS) return "SECONDARY";
  return "STALE";
}

const FRESHNESS_RANK: Record<FreshnessTier, number> = { PRIMARY: 0, SECONDARY: 1, UNKNOWN_DATE: 2, STALE: 3 };

function scoreBand(match: ForYouMatch | undefined): number {
  if (!match) return -1; // NOT_EVALUATED: no score to band — freshness decides within this tier
  return Math.floor(match.overallScore / SCORE_BAND_WIDTH);
}

export interface ForYouOptions {
  /** Excludes STALE (>20 day) jobs entirely — the "All Jobs" view should pass true to include them. */
  includeStale?: boolean;
  now?: Date;
}

/**
 * Returns jobs sorted per the approved key order (design record §3/§16):
 * validity/not-interested gate -> role-family tier -> decision rank -> score band -> sponsorship
 * tier -> exact overall score -> employer-evidenced share -> requirement coverage -> freshness ->
 * posted_at -> id (final deterministic tie-break).
 */
export function rankForYou(jobs: ForYouJobInput[], options: ForYouOptions = {}): RankedForYouJob[] {
  const now = options.now ?? new Date();

  const enriched: RankedForYouJob[] = jobs
    .filter((job) => !job.notInterested)
    .map((job) => ({
      ...job,
      freshnessTier: computeFreshnessTier(job.postedAt, now),
      decisionRank: decisionRank(job.match),
      sponsorshipTier: sponsorshipTier(job),
    }))
    .filter((job) => options.includeStale || job.freshnessTier !== "STALE");

  enriched.sort((a, b) => {
    const roleFamilyDiff = ROLE_FAMILY_RANK[a.roleFamilyTier] - ROLE_FAMILY_RANK[b.roleFamilyTier];
    if (roleFamilyDiff !== 0) return roleFamilyDiff;

    const decisionDiff = a.decisionRank - b.decisionRank;
    if (decisionDiff !== 0) return decisionDiff;

    // scoreBand is ascending (higher number = stronger fit) — want the stronger band FIRST, so b-a.
    const bandDiff = scoreBand(b.match) - scoreBand(a.match);
    if (bandDiff !== 0) return bandDiff;

    const sponsorshipDiff = a.sponsorshipTier - b.sponsorshipTier;
    if (sponsorshipDiff !== 0) return sponsorshipDiff;

    const scoreDiff = (b.match?.overallScore ?? -1) - (a.match?.overallScore ?? -1);
    if (scoreDiff !== 0) return scoreDiff;

    const employerShareDiff = (b.match?.employerEvidencedShare ?? -1) - (a.match?.employerEvidencedShare ?? -1);
    if (employerShareDiff !== 0) return employerShareDiff;

    const coverageDiff = (b.match?.requirementCoverage ?? -1) - (a.match?.requirementCoverage ?? -1);
    if (coverageDiff !== 0) return coverageDiff;

    const freshnessDiff = FRESHNESS_RANK[a.freshnessTier] - FRESHNESS_RANK[b.freshnessTier];
    if (freshnessDiff !== 0) return freshnessDiff;

    const aPostedMs = a.postedAt ? new Date(a.postedAt).getTime() : 0;
    const bPostedMs = b.postedAt ? new Date(b.postedAt).getTime() : 0;
    if (aPostedMs !== bPostedMs) return bPostedMs - aPostedMs;

    return b.jobId - a.jobId;
  });

  return enriched;
}
