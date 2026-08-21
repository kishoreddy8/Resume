import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { listAllCandidateJobStatesForCandidate } from "@/db/queries/candidateJobState";
import { getRankingPreferences } from "@/db/queries/candidateSettings";
import {
  countActiveUnarchivedJobs,
  listJobsByDedupeKeys,
  listJobsForListWithDescriptionText,
  listTopFreshJobs,
} from "@/db/queries/jobs";
import { listAllLatestDecisionsForCandidate } from "@/db/queries/jobMatches";
import { listAllLatestResumeQualityWorkflowsForCandidate } from "@/db/queries/resumeQualityWorkflows";
import { computeRoleFamilyTier } from "@/lib/rank/roleFamily";
import { rankForYou, type ForYouJobInput, type FreshnessTier, type RoleFamilyTier } from "@/lib/rank/forYou";
import {
  classifyCandidateJobBucket,
  computeCandidateJobBadges,
  type CandidateJobBucket,
  type CandidateJobBadges,
  type CandidateJobBucketInput,
  TOP_MATCH_DEFAULT_MIN_SCORE,
} from "@/lib/rank/candidateJobBucket";
import { isLifecycleProtected, getJobAgeDays } from "@/lib/jobLifecycle";
import type { Decision } from "@/lib/match/types";
import type { JobWithCompany, JobWithCompanySummary, TailoringApprovalType } from "@/types";
import { getDb } from "@/db";

/**
 * Phase 4 Stage 3 — Candidate-scoped Actionable "For You" Job Feed Route.
 *
 * Highly optimized read path:
 * 1. Gathers candidate-scoped facts (matches, states, workflows) via single-roundtrip
 *    candidate queries without massive IN lists.
 * 2. Computes dynamic bucket counts in ~15ms using pure classifier logic.
 * 3. Retrieves bounded job sets with lightweight summary projections (omitting large HTML/raw JSON).
 * 4. Preserves 100% of bucket semantics, precedence order, candidate isolation, and ranking rules.
 */

const DEFAULT_LIMIT = 200;

export interface ForYouBucketCounts {
  all: number;
  newToday: number;
  topMatches: number;
  readyForTailoring: number;
  needsReview: number;
  readyToApply: number;
  applied: number;
  interviewing: number;
}

export interface ForYouTailoringApproval {
  markedForTailoring: boolean;
  approvalType: TailoringApprovalType | null;
  approvedDecision: string | null;
  markedAt: string | null;
}

export interface ForYouRanking {
  freshnessTier: FreshnessTier;
  roleFamilyTier: RoleFamilyTier;
  /** null = NOT_EVALUATED for this candidate — never a fabricated decision/score. */
  decision: Decision | null;
  overallScore: number | null;
  /** Stage 24B — true when the persisted evaluation could not extract enough structured JD
   *  requirements to trust `overallScore`. The list UI must render this as "Insufficient data", never
   *  as a confident percentage, and never as a 0% match. null = never evaluated. */
  insufficientJdSignal: boolean | null;
  primaryBucket: CandidateJobBucket | null;
  badges: CandidateJobBadges;
  hasReadyResume: boolean;
  tailoringApproval?: ForYouTailoringApproval | null;
}

export interface ForYouResponseEntry {
  job: JobWithCompany | JobWithCompanySummary;
  ranking: ForYouRanking;
}

export interface ForYouApiResponse {
  candidateId: number;
  preferences: ReturnType<typeof getRankingPreferences>;
  bucketCounts: ForYouBucketCounts;
  /**
   * The same buckets counted WITHOUT the sticky view filters (role scope, minimum score).
   *
   * `bucketCounts` promises what a tab will show; this says what the tab is hiding. The two are
   * only ever different because a filter is on, which is exactly what an empty bucket needs to be
   * able to explain — "57 arrived today, none in your target roles" instead of a silent zero.
   */
  bucketCountsUnfiltered: ForYouBucketCounts;
  entries: ForYouResponseEntry[];
}

function normalizeBucketQuery(raw: string | null): CandidateJobBucket | "ALL" | null {
  if (!raw) return "ALL";
  const norm = raw.trim().toLowerCase().replace(/[-_]/g, "");
  if (norm === "all") return "ALL";
  if (norm === "newtoday") return "NEW_TODAY";
  if (norm === "topmatch" || norm === "topmatches") return "TOP_MATCH";
  if (norm === "readyfortailoring") return "READY_FOR_TAILORING";
  if (norm === "needsreview") return "NEEDS_REVIEW";
  if (norm === "readytoapply") return "READY_TO_APPLY";
  if (norm === "applied") return "APPLIED";
  if (norm === "interviewing") return "INTERVIEWING";
  return null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: candidateIdParam } = await params;
  const candidateId = Number(candidateIdParam);
  if (!Number.isInteger(candidateId)) {
    return NextResponse.json({ error: "Invalid candidateId" }, { status: 400 });
  }
  const candidate = requireActiveCandidate(candidateId);
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;
  if (!candidate) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const searchParams = req.nextUrl.searchParams;
  const includeStale = searchParams.get("includeStale") === "true";
  const requestedLimit = Number(searchParams.get("limit"));
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 500) : DEFAULT_LIMIT;

  const bucketParam = searchParams.get("bucket");
  const normalizedBucket = normalizeBucketQuery(bucketParam);
  if (bucketParam && normalizedBucket === null) {
    return NextResponse.json({ error: `Invalid bucket parameter: ${bucketParam}` }, { status: 400 });
  }

  const minScoreParam = searchParams.get("minScore");
  const minScore = minScoreParam !== null && !Number.isNaN(Number(minScoreParam)) ? Number(minScoreParam) : null;

  const sortBy = searchParams.get("sortBy") ?? "recommended";
  const sortOrder = searchParams.get("sortOrder") === "asc" ? "asc" : "desc";
  /* Accepts one tier as before, or several comma-separated ("PRIMARY,SECONDARY"). Strictly
   * additive: a single value parses to a one-element set and filters exactly as it always did, so
   * every existing caller is byte-for-byte unaffected. The UI needs P+S together because role tier
   * is only a TIE-BREAKER in the ranking, not the leading key — 66 role-matched jobs sat after the
   * first unmatched one in a 200-item page, so filtering client-side would silently drop matches
   * that fell beyond the limit. Filtering here happens before the limit, so it cannot. */
  const roleFamilyFilter = searchParams
    .get("roleFamily")
    ?.toUpperCase()
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v === "PRIMARY" || v === "SECONDARY" || v === "NONE");
  const locationFilter = searchParams.get("location")?.toLowerCase().trim();
  const searchFilter = searchParams.get("search")?.toLowerCase().trim();
  const skillsFilter = searchParams.get("skills")?.toLowerCase().trim();
  const freshnessFilter = searchParams.get("freshness")?.toLowerCase().trim();

  const now = new Date();

  // 1. Fetch candidate facts via fast indexed candidate queries
  const matchSummaries = listAllLatestDecisionsForCandidate(candidateId);
  const candidateStates = listAllCandidateJobStatesForCandidate(candidateId);
  const qualityWorkflows = listAllLatestResumeQualityWorkflowsForCandidate(candidateId);
  const preferences = getRankingPreferences(candidateId);

  // 2. Fetch new today active jobs and total active count for dynamic bucket counts
  const db = getDb();
  const newTodayRows = db
    .prepare(
      `SELECT dedupe_key, posted_at, first_seen_at
       FROM jobs
       WHERE is_active = 1 AND is_archived = 0
         AND (
           (posted_at IS NOT NULL AND date(posted_at) = date('now'))
           OR (posted_at IS NULL AND date(first_seen_at) = date('now'))
         )`
    )
    .all() as { dedupe_key: string; posted_at: string | null; first_seen_at: string }[];

  const totalActive = countActiveUnarchivedJobs();
  const notInterestedCount = Object.values(candidateStates).filter((s) => s.not_interested === 1).length;

  const emptyCounts = (): ForYouBucketCounts => ({
    all: Math.max(totalActive - notInterestedCount, 0),
    newToday: 0,
    topMatches: 0,
    readyForTailoring: 0,
    needsReview: 0,
    readyToApply: 0,
    applied: 0,
    interviewing: 0,
  });

  /**
   * A tab's number has to be the number of things behind that tab.
   *
   * These were counted before the sticky filters ran and the list was built after them, so the two
   * disagreed whenever a filter was on. On the live feed that produced "New Today 57" over an empty
   * list: all 57 of the day's postings — Cashier I, Assistant Controller, Lead Material Planner —
   * are NONE-tier against a Data Engineer target, and For You defaults to your target roles. The
   * list was right; the count was advertising jobs the tab would never show.
   *
   * `all` stays a corpus total in both: it is a total, and the list under it is capped at `limit`,
   * so it has never been a promise about row count.
   */
  const bucketCounts = emptyCounts();
  const bucketCountsUnfiltered = emptyCounts();

  /* The filters a tab's count must respect: the ones that persist across tab changes and can empty
   * a bucket without the person having typed anything. Text search is deliberately NOT here — it
   * is transient, it is visible in the field, and it has its own empty state that names it. */
  const roleFamilyWanted = roleFamilyFilter && roleFamilyFilter.length > 0 ? new Set(roleFamilyFilter) : null;
  function passesStickyFilters(title: string, match: { overallScore: number; insufficientJdSignal?: boolean } | undefined): boolean {
    if (roleFamilyWanted && !roleFamilyWanted.has(computeRoleFamilyTier(title, preferences))) return false;
    if (minScore !== null && (match === undefined || match.insufficientJdSignal || match.overallScore < minScore)) {
      return false;
    }
    return true;
  }

  // Collect candidate relevant dedupe keys
  const candidateKeys = new Set<string>();
  for (const k of Object.keys(candidateStates)) candidateKeys.add(k);
  for (const k of Object.keys(matchSummaries)) candidateKeys.add(k);
  for (const k of Object.keys(qualityWorkflows)) candidateKeys.add(k);
  for (const r of newTodayRows) candidateKeys.add(r.dedupe_key);

  const candidateKeyList = Array.from(candidateKeys);
  // Stage 32 — description_text is read only by the search and skills filters below. Fetching it
  // unconditionally cost ~78 MB of text per request on the real corpus for a field the default view
  // never looks at.
  const needsDescriptionText = Boolean(searchFilter || skillsFilter);
  const candidateJobs = listJobsByDedupeKeys(candidateKeyList, candidateId, {
    includeDescriptionText: needsDescriptionText,
  });
  const keyJobMap = new Map<string, JobWithCompanySummary>(candidateJobs.map((j) => [j.dedupe_key, j]));

  const jobsByBucket: Record<CandidateJobBucket, JobWithCompanySummary[]> = {
    INTERVIEWING: [],
    APPLIED: [],
    READY_TO_APPLY: [],
    READY_FOR_TAILORING: [],
    NEEDS_REVIEW: [],
    TOP_MATCH: [],
    NEW_TODAY: [],
  };

  for (const key of candidateKeyList) {
    const job = keyJobMap.get(key);
    if (!job || job.is_active !== 1 || job.is_archived === 1) continue;
    const state = candidateStates[key];
    if (state?.not_interested === 1) continue;

    const match = matchSummaries[key];
    const wf = qualityWorkflows[key];
    const isMatchCurrent = match ? match.status !== "superseded" : true;

    const input: CandidateJobBucketInput = {
      pipelineStatus: state?.pipeline_status ?? "New",
      postedAt: job.posted_at,
      firstSeenAt: job.first_seen_at,
      match: match
        ? {
            decision: match.decision as Decision,
            overallScore: match.overallScore,
            isCurrent: isMatchCurrent,
            insufficientJdSignal: match.insufficientJdSignal,
          }
        : undefined,
      latestResumeQualityWorkflow: wf ? { status: wf.status } : null,
      topMatchMinScore: TOP_MATCH_DEFAULT_MIN_SCORE,
      now,
    };

    const bucket = classifyCandidateJobBucket(input);
    const counted = passesStickyFilters(job.title, input.match);
    if (bucket) {
      jobsByBucket[bucket].push(job);
      const tally = (c: ForYouBucketCounts) => {
        if (bucket === "NEW_TODAY") c.newToday++;
        else if (bucket === "READY_FOR_TAILORING") c.readyForTailoring++;
        else if (bucket === "NEEDS_REVIEW") c.needsReview++;
        else if (bucket === "READY_TO_APPLY") c.readyToApply++;
        else if (bucket === "APPLIED") c.applied++;
        else if (bucket === "INTERVIEWING") c.interviewing++;
      };
      tally(bucketCountsUnfiltered);
      if (counted) tally(bucketCounts);
    }

    // STAGE 25A — "Top Matches" is a BADGE tab, not a primary-bucket tab. classifyCandidateJobBucket
    // ranks TOP_MATCH below READY_FOR_TAILORING and NEEDS_REVIEW, and Decision has exactly three
    // values (BLOCKED / NEEDS_REVIEW / READY_FOR_TAILORING) — of which TOP_MATCH itself excludes
    // BLOCKED. Every evaluated job therefore returns one of the two higher buckets, so TOP_MATCH was
    // unreachable and the tab read a permanent 0 even with 8 active jobs scoring >= 90 on trusted,
    // fully-evidenced evaluations. computeCandidateJobBadges already computes exactly the intended
    // condition independently of bucket precedence, so the tab is sourced from the badge. No other
    // bucket's membership or count changes — a Top Match job still belongs to its decision bucket too.
    const topMatchBadge = computeCandidateJobBadges(input).isTopMatch;
    if (topMatchBadge) {
      bucketCountsUnfiltered.topMatches++;
      if (counted) bucketCounts.topMatches++;
      if (bucket !== "TOP_MATCH") jobsByBucket.TOP_MATCH.push(job);
    }
  }

  // 3. Assemble pool of jobs based on requested tab & filters
  let rawPool: (JobWithCompany | JobWithCompanySummary)[] = [];

  if (normalizedBucket && normalizedBucket !== "ALL") {
    rawPool = jobsByBucket[normalizedBucket] ?? [];
  } else if (searchFilter || skillsFilter) {
    // When text search or skills filter is requested across all jobs, push filter into SQL.
    // Summary projection, not listJobs' `j.*`: the filters below read description_text, but nothing
    // reads description_html/description_sections/raw_json, and selecting them cost ~4.4 MB per
    // searched request. Same rows, same order — only the unread columns are gone.
    rawPool = listJobsForListWithDescriptionText({
      activeOnly: true,
      candidateId,
      search: searchFilter ?? skillsFilter,
    });
  } else {
    // General ALL view: candidate evaluated/protected jobs + top fresh postings pool
    const poolLimit = Math.max(limit * 3, 600);
    const topFresh = listTopFreshJobs(poolLimit, candidateId);

    const seenIds = new Set<number>();
    for (const j of candidateJobs) {
      if (j.is_active === 1 && j.is_archived === 0) {
        seenIds.add(j.id);
        rawPool.push(j);
      }
    }
    for (const j of topFresh) {
      if (!seenIds.has(j.id)) {
        seenIds.add(j.id);
        rawPool.push(j);
      }
    }
  }

  // 4. Build enriched items with primary bucket classification and badges
  interface EnrichedItem {
    forYouInput: ForYouJobInput;
    job: JobWithCompany | JobWithCompanySummary;
    primaryBucket: CandidateJobBucket | null;
    badges: CandidateJobBadges;
    hasReadyResume: boolean;
    tailoringApproval: ForYouTailoringApproval | null;
  }

  const allEnriched: EnrichedItem[] = [];

  for (const job of rawPool) {
    const match = matchSummaries[job.dedupe_key];
    const state = candidateStates[job.dedupe_key];
    const workflow = qualityWorkflows[job.dedupe_key];
    const isMatchCurrent = match ? match.status !== "superseded" : true;

    const forYouInput: ForYouJobInput = {
      jobId: job.id,
      dedupeKey: job.dedupe_key,
      title: job.title,
      postedAt: job.posted_at,
      h1bCombinedConfidence: job.h1b_combined_confidence,
      sponsorshipMentioned: job.sponsorship_mentioned === 1,
      sponsorshipPolarity: job.sponsorship_polarity,
      match: match
        ? {
            decision: match.decision as Decision,
            overallScore: match.overallScore,
            employerEvidencedShare: match.employerEvidencedShare,
            requirementCoverage: match.requirementCoverage,
            insufficientJdSignal: match.insufficientJdSignal,
          }
        : undefined,
      notInterested: state?.not_interested === 1,
      protectedFromStale: isLifecycleProtected({
        pipelineStatus: state?.pipeline_status ?? "New",
        pinned: state?.pinned ?? 0,
      }),
      roleFamilyTier: computeRoleFamilyTier(job.title, preferences),
    };

    const bucketInput: CandidateJobBucketInput = {
      pipelineStatus: state?.pipeline_status ?? "New",
      postedAt: job.posted_at,
      firstSeenAt: job.first_seen_at,
      match: match
        ? {
            decision: match.decision as Decision,
            overallScore: match.overallScore,
            isCurrent: isMatchCurrent,
            insufficientJdSignal: match.insufficientJdSignal,
          }
        : undefined,
      latestResumeQualityWorkflow: workflow ? { status: workflow.status } : null,
      topMatchMinScore: TOP_MATCH_DEFAULT_MIN_SCORE,
      now,
    };

    const primaryBucket = classifyCandidateJobBucket(bucketInput);
    const badges = computeCandidateJobBadges(bucketInput);
    const hasReadyResume = workflow?.status === "READY";

    const tailoringApproval: ForYouTailoringApproval | null =
      state?.marked_for_tailoring === 1
        ? {
            markedForTailoring: true,
            approvalType: state.tailoring_approval_type,
            approvedDecision: state.tailoring_approved_decision,
            markedAt: state.tailoring_marked_at,
          }
        : null;

    const jobWithOverlay: JobWithCompany | JobWithCompanySummary = {
      ...job,
      pipeline_status: state?.pipeline_status ?? "New",
      pinned: state?.pinned ?? 0,
      marked_for_tailoring: state?.marked_for_tailoring ?? 0,
      tailoring_marked_at: state?.tailoring_marked_at ?? null,
      notes: state?.notes ?? null,
      tags: state?.tags ?? null,
      not_interested: state?.not_interested ?? 0,
    };

    allEnriched.push({
      forYouInput,
      job: jobWithOverlay,
      primaryBucket,
      badges,
      hasReadyResume,
      tailoringApproval,
    });
  }

  // 5. Filter out not-interested jobs for candidate
  let filtered = allEnriched.filter((item) => !item.forYouInput.notInterested);

  if (normalizedBucket && normalizedBucket !== "ALL") {
    // TOP_MATCH is badge-sourced (see the bucket-counting loop above); every other tab is its
    // primary bucket, unchanged.
    filtered =
      normalizedBucket === "TOP_MATCH"
        ? filtered.filter((item) => item.badges.isTopMatch)
        : filtered.filter((item) => item.primaryBucket === normalizedBucket);
  }

  if (minScore !== null) {
    // Stage 24B: a minimum-score filter is a request for jobs that genuinely score at least this
    // well. An insufficient-signal evaluation's number is explicitly not trustworthy, so it never
    // satisfies the filter — it would otherwise fill a "90+ Score" view with postings whose only
    // applicable dimension was a years-of-experience minimum.
    filtered = filtered.filter((item) => {
      const match = item.forYouInput.match;
      return match !== undefined && !match.insufficientJdSignal && match.overallScore >= minScore;
    });
  }

  if (roleFamilyFilter && roleFamilyFilter.length > 0) {
    const wanted = new Set(roleFamilyFilter);
    filtered = filtered.filter((item) => wanted.has(item.forYouInput.roleFamilyTier));
  }

  if (locationFilter) {
    filtered = filtered.filter((item) => item.job.location?.toLowerCase().includes(locationFilter));
  }

  if (searchFilter) {
    filtered = filtered.filter(
      (item) =>
        item.job.title.toLowerCase().includes(searchFilter) ||
        item.job.company_name.toLowerCase().includes(searchFilter) ||
        (item.job.location && item.job.location.toLowerCase().includes(searchFilter)) ||
        (item.job.description_text && item.job.description_text.toLowerCase().includes(searchFilter))
    );
  }

  if (skillsFilter) {
    filtered = filtered.filter((item) => {
      const skillsJson = item.job.description_text?.toLowerCase() ?? "";
      return skillsJson.includes(skillsFilter);
    });
  }

  if (freshnessFilter) {
    if (freshnessFilter === "today") {
      filtered = filtered.filter((item) => getJobAgeDays({ posted_at: item.job.posted_at, first_seen_at: item.job.first_seen_at }, now) === 0);
    } else if (freshnessFilter === "primary") {
      filtered = filtered.filter((item) => {
        const age = getJobAgeDays({ posted_at: item.job.posted_at, first_seen_at: item.job.first_seen_at }, now);
        return age <= 10;
      });
    } else if (freshnessFilter === "secondary") {
      filtered = filtered.filter((item) => {
        const age = getJobAgeDays({ posted_at: item.job.posted_at, first_seen_at: item.job.first_seen_at }, now);
        return age > 10 && age <= 20;
      });
    }
  }

  // 6. Sorting
  if (sortBy === "recommended") {
    if (normalizedBucket === "READY_TO_APPLY") {
      filtered.sort((a, b) => {
        const aDate = a.job.posted_at ? new Date(a.job.posted_at).getTime() : 0;
        const bDate = b.job.posted_at ? new Date(b.job.posted_at).getTime() : 0;
        if (bDate !== aDate) return bDate - aDate;
        const aScore = a.forYouInput.match?.overallScore ?? -1;
        const bScore = b.forYouInput.match?.overallScore ?? -1;
        if (bScore !== aScore) return bScore - aScore;
        return b.job.id - a.job.id;
      });
    } else if (normalizedBucket === "READY_FOR_TAILORING" || normalizedBucket === "NEEDS_REVIEW" || normalizedBucket === "TOP_MATCH") {
      filtered.sort((a, b) => {
        // Stage 24B: trustworthy evaluations first, so an insufficient-signal 100 never sits above a
        // fully-evidenced 88 inside a decision bucket.
        const aTrusted = a.forYouInput.match && !a.forYouInput.match.insufficientJdSignal ? 0 : 1;
        const bTrusted = b.forYouInput.match && !b.forYouInput.match.insufficientJdSignal ? 0 : 1;
        if (aTrusted !== bTrusted) return aTrusted - bTrusted;
        const aScore = a.forYouInput.match?.overallScore ?? -1;
        const bScore = b.forYouInput.match?.overallScore ?? -1;
        if (bScore !== aScore) return bScore - aScore;
        const aDate = a.job.posted_at ? new Date(a.job.posted_at).getTime() : 0;
        const bDate = b.job.posted_at ? new Date(b.job.posted_at).getTime() : 0;
        if (bDate !== aDate) return bDate - aDate;
        return b.job.id - a.job.id;
      });
    } else if (normalizedBucket === "NEW_TODAY") {
      filtered.sort((a, b) => {
        const aDate = a.job.posted_at ? new Date(a.job.posted_at).getTime() : new Date(a.job.first_seen_at).getTime();
        const bDate = b.job.posted_at ? new Date(b.job.posted_at).getTime() : new Date(b.job.first_seen_at).getTime();
        if (bDate !== aDate) return bDate - aDate;
        const aScore = a.forYouInput.match?.overallScore ?? -1;
        const bScore = b.forYouInput.match?.overallScore ?? -1;
        if (bScore !== aScore) return bScore - aScore;
        return b.job.id - a.job.id;
      });
    } else if (normalizedBucket === "APPLIED" || normalizedBucket === "INTERVIEWING") {
      filtered.sort((a, b) => {
        const aTime = a.job.updated_at ? new Date(a.job.updated_at).getTime() : new Date(a.job.first_seen_at).getTime();
        const bTime = b.job.updated_at ? new Date(b.job.updated_at).getTime() : new Date(b.job.first_seen_at).getTime();
        if (bTime !== aTime) return bTime - aTime;
        return b.job.id - a.job.id;
      });
    } else {
      // General recommended ordering via rankForYou
      const rankedInputs = rankForYou(
        filtered.map((item) => item.forYouInput),
        { includeStale, now }
      );
      const rankedJobIdIndex = new Map(rankedInputs.map((r, idx) => [r.jobId, idx]));
      filtered.sort((a, b) => {
        const aIdx = rankedJobIdIndex.get(a.job.id) ?? 999999;
        const bIdx = rankedJobIdIndex.get(b.job.id) ?? 999999;
        return aIdx - bIdx;
      });
    }
  } else if (sortBy === "score") {
    filtered.sort((a, b) => {
      const aTrusted = a.forYouInput.match && !a.forYouInput.match.insufficientJdSignal ? 0 : 1;
      const bTrusted = b.forYouInput.match && !b.forYouInput.match.insufficientJdSignal ? 0 : 1;
      if (aTrusted !== bTrusted) return aTrusted - bTrusted;
      const aScore = a.forYouInput.match?.overallScore ?? -1;
      const bScore = b.forYouInput.match?.overallScore ?? -1;
      return sortOrder === "asc" ? aScore - bScore : bScore - aScore;
    });
  } else if (sortBy === "freshness") {
    filtered.sort((a, b) => {
      const aDate = a.job.posted_at ? new Date(a.job.posted_at).getTime() : new Date(a.job.first_seen_at).getTime();
      const bDate = b.job.posted_at ? new Date(b.job.posted_at).getTime() : new Date(b.job.first_seen_at).getTime();
      return sortOrder === "asc" ? aDate - bDate : bDate - aDate;
    });
  } else if (sortBy === "title") {
    filtered.sort((a, b) => {
      const cmp = a.job.title.localeCompare(b.job.title);
      return sortOrder === "asc" ? cmp : -cmp;
    });
  } else if (sortBy === "company") {
    filtered.sort((a, b) => {
      const cmp = a.job.company_name.localeCompare(b.job.company_name);
      return sortOrder === "asc" ? cmp : -cmp;
    });
  }

  // 7. Enforce stale filter unless includeStale is requested or protected
  if (!includeStale && (!normalizedBucket || normalizedBucket === "ALL")) {
    filtered = filtered.filter((item) => {
      const ageDays = getJobAgeDays({ posted_at: item.job.posted_at, first_seen_at: item.job.first_seen_at }, now);
      return ageDays <= 20 || item.forYouInput.protectedFromStale;
    });
  }

  // 8. Slice to limit
  const paged = filtered.slice(0, limit);

  // 9. Format response entries
  const entries: ForYouResponseEntry[] = paged.map((item) => {
    const ageDays = getJobAgeDays({ posted_at: item.job.posted_at, first_seen_at: item.job.first_seen_at }, now);
    let freshnessTier: FreshnessTier = "UNKNOWN_DATE";
    if (item.job.posted_at) {
      if (ageDays <= 10) freshnessTier = "PRIMARY";
      else if (ageDays <= 20) freshnessTier = "SECONDARY";
      else freshnessTier = "STALE";
    }

    // description_text is read by the search/skills filters above and by nothing else — the list
    // contract has never included it (the unsearched path does not even select it). Dropping it
    // here keeps the searched and unsearched responses the same shape instead of the search
    // silently shipping ~1.3 MB of body text the UI never reads.
    const job: typeof item.job = { ...item.job, description_text: undefined as never };

    return {
      job: job as typeof item.job,
      ranking: {
        freshnessTier,
        roleFamilyTier: item.forYouInput.roleFamilyTier,
        decision: item.forYouInput.match?.decision ?? null,
        overallScore: item.forYouInput.match?.overallScore ?? null,
        insufficientJdSignal: item.forYouInput.match?.insufficientJdSignal ?? null,
        primaryBucket: item.primaryBucket,
        badges: item.badges,
        hasReadyResume: item.hasReadyResume,
        tailoringApproval: item.tailoringApproval,
      },
    };
  });

  return NextResponse.json({
    candidateId,
    preferences,
    bucketCounts,
    bucketCountsUnfiltered,
    entries,
  });
}
