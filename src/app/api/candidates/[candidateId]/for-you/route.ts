import { NextRequest, NextResponse } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { listCandidateJobStates } from "@/db/queries/candidateJobState";
import { getRankingPreferences } from "@/db/queries/candidateSettings";
import { listJobs } from "@/db/queries/jobs";
import { listLatestDecisionsForDedupeKeys } from "@/db/queries/jobMatches";
import { computeRoleFamilyTier } from "@/lib/rank/roleFamily";
import { rankForYou, type ForYouJobInput, type FreshnessTier, type RoleFamilyTier } from "@/lib/rank/forYou";
import { isLifecycleProtected } from "@/lib/jobLifecycle";
import type { Decision } from "@/lib/match/types";
import type { JobWithCompany } from "@/types";

/**
 * Candidate-scoped For You ranking — plumbing only (see CAREER_OPS_PHASE_2_5_CHECKPOINT.md §6 stage 1).
 * src/lib/rank/forYou.ts's algorithm/key order is untouched; this route's only job is to gather
 * already-computed per-job facts (job row, latest match result, candidate_job_state, ranking
 * preferences) and hand them to rankForYou exactly as documented on ForYouJobInput.
 *
 * Never fabricates a match score: a job with no job_match_results row for this candidate is passed
 * through with `match: undefined`, which rankForYou/decisionRank treats as NOT_EVALUATED.
 */

const DEFAULT_LIMIT = 200;

export interface ForYouRanking {
  freshnessTier: FreshnessTier;
  roleFamilyTier: RoleFamilyTier;
  /** null = NOT_EVALUATED for this candidate — never a fabricated decision/score. */
  decision: Decision | null;
  overallScore: number | null;
}

export interface ForYouResponseEntry {
  job: JobWithCompany;
  ranking: ForYouRanking;
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

  const jobs = listJobs({ activeOnly: true, candidateId });
  const dedupeKeys = jobs.map((j) => j.dedupe_key);
  const matchSummaries = listLatestDecisionsForDedupeKeys(candidateId, dedupeKeys);
  const candidateStates = listCandidateJobStates(candidateId, dedupeKeys);
  const preferences = getRankingPreferences(candidateId);

  const jobById = new Map<number, JobWithCompany>(jobs.map((j) => [j.id, j]));

  const inputs: ForYouJobInput[] = jobs.map((job) => {
    const match = matchSummaries[job.dedupe_key];
    const state = candidateStates[job.dedupe_key];
    return {
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
  });

  const ranked = rankForYou(inputs, { includeStale }).slice(0, limit);

  const entries: ForYouResponseEntry[] = ranked
    .map((r) => {
      const job = jobById.get(r.jobId);
      if (!job) return null;
      return {
        job,
        ranking: {
          freshnessTier: r.freshnessTier,
          roleFamilyTier: r.roleFamilyTier,
          decision: r.match?.decision ?? null,
          overallScore: r.match?.overallScore ?? null,
        },
      };
    })
    .filter((e): e is ForYouResponseEntry => e !== null);

  return NextResponse.json({ candidateId, preferences, entries });
}
