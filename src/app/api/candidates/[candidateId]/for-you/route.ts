import { NextRequest, NextResponse } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { listCandidateJobStates } from "@/db/queries/candidateJobState";
import { getRankingPreferences } from "@/db/queries/candidateSettings";
import { listJobs } from "@/db/queries/jobs";
import { listLatestDecisionsForDedupeKeys } from "@/db/queries/jobMatches";
import { listLatestResumeQualityWorkflowsForDedupeKeys } from "@/db/queries/resumeQualityWorkflows";
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
import type { JobWithCompany, TailoringApprovalType } from "@/types";

/**
 * Phase 4 Stage 3 — Candidate-scoped Actionable "For You" Job Feed Route.
 *
 * Gathers candidate-scoped facts (jobs, latest match results, candidate job states, ranking
 * preferences, and Phase 3 resume quality workflows) in batched SQL queries with zero N+1 behavior.
 * Computes derived primary buckets and secondary badges, provides dynamic bucket counts, and
 * supports rich filtering and deterministic bucket-specific sorting.
 *
 * Fully backward-compatible with Phase 2.5 callers while exposing rich additive metadata.
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
  primaryBucket: CandidateJobBucket | null;
  badges: CandidateJobBadges;
  hasReadyResume: boolean;
  tailoringApproval?: ForYouTailoringApproval | null;
}

export interface ForYouResponseEntry {
  job: JobWithCompany;
  ranking: ForYouRanking;
}

export interface ForYouApiResponse {
  candidateId: number;
  preferences: ReturnType<typeof getRankingPreferences>;
  bucketCounts: ForYouBucketCounts;
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
  const roleFamilyFilter = searchParams.get("roleFamily")?.toUpperCase();
  const locationFilter = searchParams.get("location")?.toLowerCase().trim();
  const searchFilter = searchParams.get("search")?.toLowerCase().trim();
  const skillsFilter = searchParams.get("skills")?.toLowerCase().trim();
  const freshnessFilter = searchParams.get("freshness")?.toLowerCase().trim();

  // 1. Batch fetch candidate jobs and dependencies (Zero N+1 queries)
  const jobs = listJobs({ activeOnly: true, candidateId });
  const dedupeKeys = jobs.map((j) => j.dedupe_key);
  const matchSummaries = listLatestDecisionsForDedupeKeys(candidateId, dedupeKeys);
  const candidateStates = listCandidateJobStates(candidateId, dedupeKeys);
  const qualityWorkflows = listLatestResumeQualityWorkflowsForDedupeKeys(candidateId, dedupeKeys);
  const preferences = getRankingPreferences(candidateId);
  const now = new Date();

  // 2. Build enriched items with primary bucket classification and badges
  interface EnrichedItem {
    forYouInput: ForYouJobInput;
    job: JobWithCompany;
    primaryBucket: CandidateJobBucket | null;
    badges: CandidateJobBadges;
    hasReadyResume: boolean;
    tailoringApproval: ForYouTailoringApproval | null;
  }

  const allEnriched: EnrichedItem[] = [];

  for (const job of jobs) {
    const match = matchSummaries[job.dedupe_key];
    const state = candidateStates[job.dedupe_key];
    const workflow = qualityWorkflows[job.dedupe_key];

    // Check if match is stale (superseded)
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

    allEnriched.push({
      forYouInput,
      job,
      primaryBucket,
      badges,
      hasReadyResume,
      tailoringApproval,
    });
  }

  // 3. Filter out not-interested jobs for candidate (matching rankForYou's gate)
  const eligibleItems = allEnriched.filter((item) => !item.forYouInput.notInterested);

  // 4. Compute dynamic bucket counts across all eligible candidate items (Disjoint, zero duplicates)
  const bucketCounts: ForYouBucketCounts = {
    all: eligibleItems.length,
    newToday: 0,
    topMatches: 0,
    readyForTailoring: 0,
    needsReview: 0,
    readyToApply: 0,
    applied: 0,
    interviewing: 0,
  };

  for (const item of eligibleItems) {
    if (item.primaryBucket === "NEW_TODAY") bucketCounts.newToday++;
    else if (item.primaryBucket === "TOP_MATCH") bucketCounts.topMatches++;
    else if (item.primaryBucket === "READY_FOR_TAILORING") bucketCounts.readyForTailoring++;
    else if (item.primaryBucket === "NEEDS_REVIEW") bucketCounts.needsReview++;
    else if (item.primaryBucket === "READY_TO_APPLY") bucketCounts.readyToApply++;
    else if (item.primaryBucket === "APPLIED") bucketCounts.applied++;
    else if (item.primaryBucket === "INTERVIEWING") bucketCounts.interviewing++;
  }

  // 5. Apply filtering (bucket, minScore, location, search, skills, freshness)
  let filtered = eligibleItems;

  if (normalizedBucket && normalizedBucket !== "ALL") {
    filtered = filtered.filter((item) => item.primaryBucket === normalizedBucket);
  }

  if (minScore !== null) {
    filtered = filtered.filter((item) => {
      const score = item.forYouInput.match?.overallScore;
      return score !== undefined && score >= minScore;
    });
  }

  if (roleFamilyFilter && (roleFamilyFilter === "PRIMARY" || roleFamilyFilter === "SECONDARY" || roleFamilyFilter === "NONE")) {
    filtered = filtered.filter((item) => item.forYouInput.roleFamilyTier === roleFamilyFilter);
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
  // Default sorting: if viewing a specific bucket tab, use bucket-specific sort rules; otherwise default to rankForYou.
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

    return {
      job: item.job,
      ranking: {
        freshnessTier,
        roleFamilyTier: item.forYouInput.roleFamilyTier,
        decision: item.forYouInput.match?.decision ?? null,
        overallScore: item.forYouInput.match?.overallScore ?? null,
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
    entries,
  });
}
