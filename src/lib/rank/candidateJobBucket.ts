import { getJobAgeDays } from "@/lib/jobLifecycle";
import type { Decision } from "@/lib/match/types";
import type { WorkflowStatus } from "@/lib/resumeQuality/types";
import type { PipelineStatus } from "@/types";

/**
 * Phase 4 Stage 3 — Pure Candidate Job Bucket Classifier.
 *
 * Classifies candidate-job pairs into actionable "For You" dashboard buckets using deterministic
 * precedence. Pure, DB-free, React-free: takes already-fetched per-job facts and returns the
 * primary bucket and secondary badge attributes.
 *
 * Precedence Order (exactly one primary bucket per candidate-job pair):
 * 1. INTERVIEWING       — Candidate actively interviewing (candidate_job_state.pipeline_status = 'Interviewing')
 * 2. APPLIED            — Candidate submitted application (candidate_job_state.pipeline_status = 'Applied')
 * 3. [Terminal Check]   — Offer / Employer Rejected are inactive/terminal and do NOT enter actionable buckets
 * 4. READY_TO_APPLY     — Phase 3 Resume Quality Workflow is READY (approved resume available) & unapplied
 * 5. READY_FOR_TAILORING— Phase 2 Match decision is READY_FOR_TAILORING (and unapplied)
 * 6. NEEDS_REVIEW       — Phase 2 Match decision is NEEDS_REVIEW (and unapplied)
 * 7. TOP_MATCH          — Phase 2 Match overallScore >= 90 (and not BLOCKED)
 * 8. NEW_TODAY          — Genuinely fresh posting (ageDays = 0 according to existing lifecycle freshness)
 */

export type CandidateJobBucket =
  | "INTERVIEWING"
  | "APPLIED"
  | "READY_TO_APPLY"
  | "READY_FOR_TAILORING"
  | "NEEDS_REVIEW"
  | "TOP_MATCH"
  | "NEW_TODAY";

export const TOP_MATCH_DEFAULT_MIN_SCORE = 90;

export interface CandidateJobBucketMatch {
  decision: Decision;
  overallScore: number;
  /** True or omitted = current/active match. False = stale (superseded or hash mismatch), which
   *  disqualifies the match from READY_FOR_TAILORING, NEEDS_REVIEW, and TOP_MATCH. */
  isCurrent?: boolean;
}

export interface CandidateJobBucketInput {
  pipelineStatus: PipelineStatus;
  postedAt: string | null;
  firstSeenAt: string;
  match?: CandidateJobBucketMatch;
  latestResumeQualityWorkflow?: {
    status: WorkflowStatus;
  } | null;
  topMatchMinScore?: number;
  now?: Date;
}

export interface CandidateJobBadges {
  isInterviewing: boolean;
  isApplied: boolean;
  isReadyToApply: boolean;
  isReadyForTailoring: boolean;
  isNeedsReview: boolean;
  isTopMatch: boolean;
  isNewToday: boolean;
  isTerminal: boolean;
}

/**
 * Computes the single authoritative primary bucket for a candidate-job pair.
 * Returns null if the job does not meet any actionable bucket criteria or is in a terminal stage.
 */
export function classifyCandidateJobBucket(input: CandidateJobBucketInput): CandidateJobBucket | null {
  // 1. Pipeline status: Interviewing takes highest precedence
  if (input.pipelineStatus === "Interviewing") {
    return "INTERVIEWING";
  }

  // 2. Pipeline status: Applied
  if (input.pipelineStatus === "Applied") {
    return "APPLIED";
  }

  // 3. Terminal stages (Offer, Employer Rejected) are excluded from all active/actionable buckets
  if (input.pipelineStatus === "Offer" || input.pipelineStatus === "Employer Rejected") {
    return null;
  }

  // 4. Ready to Apply: Derived from Phase 3 (latest resume quality workflow is READY)
  if (input.latestResumeQualityWorkflow?.status === "READY") {
    return "READY_TO_APPLY";
  }

  // Stale match safety: ignore match metrics if match is not current
  const match = input.match;
  const isMatchValid = Boolean(match && match.isCurrent !== false);

  // 5. Ready for Tailoring: Authoritative Phase 2 decision
  if (isMatchValid && match?.decision === "READY_FOR_TAILORING") {
    return "READY_FOR_TAILORING";
  }

  // 6. Needs Review: Authoritative Phase 2 decision
  if (isMatchValid && match?.decision === "NEEDS_REVIEW") {
    return "NEEDS_REVIEW";
  }

  // 7. Top Match: High match score (>= 90 by default) and not BLOCKED
  const minScore = input.topMatchMinScore ?? TOP_MATCH_DEFAULT_MIN_SCORE;
  if (isMatchValid && match && match.decision !== "BLOCKED" && match.overallScore >= minScore) {
    return "TOP_MATCH";
  }

  // 8. New Today: Authoritative age = 0 days from posted_at / first_seen_at
  const now = input.now ?? new Date();
  const ageDays = getJobAgeDays({ posted_at: input.postedAt, first_seen_at: input.firstSeenAt }, now);
  if (ageDays === 0) {
    return "NEW_TODAY";
  }

  return null;
}

/**
 * Computes all applicable secondary badges for visual enrichment (e.g. a READY_FOR_TAILORING job
 * that is also NEW_TODAY or has a top match score).
 */
export function computeCandidateJobBadges(input: CandidateJobBucketInput): CandidateJobBadges {
  const now = input.now ?? new Date();
  const ageDays = getJobAgeDays({ posted_at: input.postedAt, first_seen_at: input.firstSeenAt }, now);
  const minScore = input.topMatchMinScore ?? TOP_MATCH_DEFAULT_MIN_SCORE;
  const match = input.match;
  const isMatchValid = Boolean(match && match.isCurrent !== false);

  return {
    isInterviewing: input.pipelineStatus === "Interviewing",
    isApplied: input.pipelineStatus === "Applied",
    isReadyToApply: input.latestResumeQualityWorkflow?.status === "READY",
    isReadyForTailoring: Boolean(isMatchValid && match?.decision === "READY_FOR_TAILORING"),
    isNeedsReview: Boolean(isMatchValid && match?.decision === "NEEDS_REVIEW"),
    isTopMatch: Boolean(isMatchValid && match && match.decision !== "BLOCKED" && match.overallScore >= minScore),
    isNewToday: ageDays === 0,
    isTerminal: input.pipelineStatus === "Offer" || input.pipelineStatus === "Employer Rejected",
  };
}
