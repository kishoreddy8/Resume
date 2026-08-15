import { getJobAgeDays } from "@/lib/jobLifecycle";
import type { Decision } from "@/lib/match/types";
import type { PipelineStatus } from "@/types";

/**
 * Phase 4 Stage 4 — pure notification-eligibility policy. Deliberately separate from
 * src/lib/rank/candidateJobBucket.ts: feed-bucket classification and new-match-notification
 * eligibility are related but not identical concerns (see that module's own precedence list —
 * READY_TO_APPLY, TOP_MATCH, and NEW_TODAY are feed/lifecycle concepts, not new-match-notification
 * triggers per this stage's explicit scope). No DB access, no React — takes already-fetched facts.
 */

export const HIGH_VALUE_JOB_MATCH_NOTIFICATION_TYPE = "HIGH_VALUE_JOB_MATCH";

/**
 * A NEEDS_REVIEW result notifies only when its overallScore is well above the plain
 * READY_FOR_TAILORING score floor (src/lib/match/scoring.ts's READINESS_THRESHOLDS.minScore = 80) —
 * i.e. a NEEDS_REVIEW verdict driven by a secondary dimension (coverage, employer-evidenced share,
 * a critical gap, insufficient JD signal), not a fundamentally weak match. 90 matches the existing
 * TOP_MATCH_DEFAULT_MIN_SCORE precedent already established in candidateJobBucket.ts, verified
 * against the real Phase 2 threshold above before choosing it, not asserted blindly.
 */
export const NEEDS_REVIEW_NOTIFICATION_MIN_SCORE = 90;

/**
 * Same freshness window already used elsewhere in the app: src/lib/ats/jobFreshness.ts's
 * isJobFreshForIngestion default (maxAgeDays=20) and the For You feed's own stale-job filter
 * (src/app/api/candidates/[candidateId]/for-you/route.ts). Reusing the existing app-wide freshness
 * concept rather than inventing a new one for notifications specifically.
 */
export const NOTIFICATION_FRESHNESS_MAX_DAYS = 20;

/** A candidate who has already advanced a job past "just discovered/interested" has no need for a
 *  new-match notification about it — matches the Stage 4 spec's explicit minimum suppression set. */
const NON_NOTIFIABLE_PIPELINE_STATUSES: readonly PipelineStatus[] = ["Applied", "Interviewing", "Offer", "Employer Rejected"];

export interface NotificationEligibilityInput {
  decision: Decision;
  overallScore: number;
  /** False for a superseded/stale job_match_results row — see jobMatches.ts's `status` column.
   *  Defaults to true (current) when omitted, matching how a freshly-computed incremental-match
   *  result is always the current row by construction. */
  isCurrent?: boolean;
  jobIsActive: boolean;
  postedAt: string | null;
  firstSeenAt: string;
  pipelineStatus: PipelineStatus;
  now?: Date;
}

/**
 * The single eligibility gate for a HIGH_VALUE_JOB_MATCH notification. Every rule maps directly to
 * one bullet in the Stage 4 spec's "Exact Notification Eligibility" section:
 *   - non-current (superseded/stale) match results never notify
 *   - an inactive job never notifies
 *   - a job outside the freshness window never notifies
 *   - BLOCKED never notifies
 *   - READY_FOR_TAILORING always qualifies (once the checks above pass)
 *   - NEEDS_REVIEW qualifies only at/above NEEDS_REVIEW_NOTIFICATION_MIN_SCORE
 *   - Applied/Interviewing/Offer/Employer Rejected suppress (New/Interested remain notifiable)
 * Duplicate-notification prevention (candidate_id + dedupe_key + type) is NOT this function's
 * concern — that's the database UNIQUE constraint's job (see schema.sql / createNotificationIfAbsent).
 */
export function isEligibleForHighValueMatchNotification(input: NotificationEligibilityInput): boolean {
  if (input.isCurrent === false) return false;
  if (!input.jobIsActive) return false;
  if (NON_NOTIFIABLE_PIPELINE_STATUSES.includes(input.pipelineStatus)) return false;

  const now = input.now ?? new Date();
  const ageDays = getJobAgeDays({ posted_at: input.postedAt, first_seen_at: input.firstSeenAt }, now);
  if (ageDays > NOTIFICATION_FRESHNESS_MAX_DAYS) return false;

  if (input.decision === "BLOCKED") return false;
  if (input.decision === "READY_FOR_TAILORING") return true;
  if (input.decision === "NEEDS_REVIEW") return input.overallScore >= NEEDS_REVIEW_NOTIFICATION_MIN_SCORE;
  return false;
}
