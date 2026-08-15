import { requireActiveCandidate } from "@/db/queries/candidates";
import { getMatchAffectingSettings } from "@/db/queries/candidateSettings";
import { listCandidateRematchJobPage } from "@/db/queries/jobs";
import { insertMatchRun } from "@/db/queries/matchRuns";
import type { EvaluatedMatchPair } from "./incrementalMatch";
import {
  generateNotificationsForIncrementalMatches,
  type NotificationGenerationResult,
} from "@/lib/notifications/generateNotifications";
import { FRESHNESS_SECONDARY_MAX_DAYS } from "@/lib/rank/forYou";
import { resolveCandidateMatchIdentity } from "./matchIdentity";
import { resolveJobMatchResult } from "./resolveJobMatch";
import type { evaluateJobMatch } from "./evaluateJobMatch";

/**
 * Phase 4 Stage 5 — candidate-profile-change rematching, as ONE bounded page per call.
 *
 * WHY PAGED. The Stage 5 audit measured Phase 2 at ~20 ms/job for the real 535-skill candidate
 * profile (99.8% of it pure engine CPU, 0.04 ms/job of DB). One candidate's actionable job set is
 * ~19.4k jobs in production, i.e. ~403 s of blocking, single-threaded work — which in a Next.js
 * route would freeze the entire app (every other request plus the scheduler tick) for minutes.
 * So the caller, not the server, owns the loop: each call does a bounded slice and hands back a
 * keyset cursor. No queue, no worker, no broker, no progress table — see rematchCandidateAllPages
 * below for the "just run it to completion" wrapper the CLI uses.
 *
 * This module contains ZERO scoring, eligibility, decision or notification-policy logic. It
 * resolves a bounded job page, then delegates to the existing pieces unchanged:
 * resolveJobMatchResult (cache-hit-or-evaluateJobMatch + insertJobMatchResult) and Stage 4's
 * generateNotificationsForIncrementalMatches.
 */

/** 100 jobs x ~20 ms/job on a full cache miss ≈ 2 s per request — the measured worst case, since a
 *  candidate profile change misses the cache for every pair by definition. */
export const DEFAULT_REMATCH_PAGE_SIZE = 100;
/** 250 x ~20 ms ≈ 5 s. Above this a single request stops being safely bounded on the measured
 *  numbers, so it is a hard ceiling, not a suggestion (the API clamps/rejects, see the route). */
export const MAX_REMATCH_PAGE_SIZE = 250;

/**
 * The actionability window a rematch honours, taken from the existing For You ranking layer
 * (>20 days = STALE and excluded from the default feed) rather than a new Stage 5 constant. Jobs
 * outside it are still reachable through the feed's own protection rule — lifecycle-protected jobs
 * are included regardless of age, see listCandidateRematchJobPage.
 */
export const REMATCH_MAX_AGE_DAYS = FRESHNESS_SECONDARY_MAX_DAYS;

export interface RematchFailure {
  candidateId: number;
  /** null = a page-level failure that prevented any pair from being attempted (currently only an
   *  unusable candidate profile) — never a fabricated dedupe_key for a pair that never ran. */
  dedupeKey: string | null;
  reason: string;
}

export interface RematchCandidatePageResult {
  candidateId: number;
  /** Jobs the bounded page query returned (already filtered by the SQL eligibility rule). */
  jobsConsidered: number;
  pairsAttempted: number;
  resultsCreated: number;
  resultsReused: number;
  failures: RematchFailure[];
  readyForTailoring: number;
  needsReview: number;
  blocked: number;
  notifications: NotificationGenerationResult;
  /** Highest jobs.id processed in this page — feed it back as afterJobId. null when the page was
   *  empty (nothing left to page through). */
  nextCursor: number | null;
  hasMore: boolean;
}

export interface RematchCandidatePageOptions {
  candidateId: number;
  afterJobId?: number;
  limit?: number;
  now?: Date;
  /** Test seam, forwarded to resolveJobMatchResult — see ResolveJobMatchOptions.evaluate. */
  evaluate?: typeof evaluateJobMatch;
}

const EMPTY_NOTIFICATION_RESULT: NotificationGenerationResult = { evaluated: 0, created: 0, skipped: 0, failures: [] };

function emptyPage(candidateId: number): RematchCandidatePageResult {
  return {
    candidateId,
    jobsConsidered: 0,
    pairsAttempted: 0,
    resultsCreated: 0,
    resultsReused: 0,
    failures: [],
    readyForTailoring: 0,
    needsReview: 0,
    blocked: 0,
    notifications: { ...EMPTY_NOTIFICATION_RESULT },
    nextCursor: null,
    hasMore: false,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_REMATCH_PAGE_SIZE;
  return Math.max(1, Math.min(Math.floor(limit), MAX_REMATCH_PAGE_SIZE));
}

/**
 * Rematches ONE bounded page of a candidate's actionable jobs and re-runs Stage 4 notification
 * eligibility over exactly the pairs this page produced a current result for.
 *
 * Candidate isolation: the candidate id is required, validated as active, and threaded explicitly
 * into the job page query, the settings read, every cache key, every persisted row and the
 * notification generator. There is no "all candidates" branch here at all (unlike Stage 2's
 * scan-triggered path, which is job-driven and fans out across candidates by design) — Candidate A's
 * profile change cannot reach Candidate B's results because Candidate B is never resolved.
 *
 * Failure isolation, in three layers: one job's exception is caught per-pair and recorded without
 * stopping the page; a notification-side failure is caught around the whole generation step and can
 * never rewrite an already-successful match page into a thrown error; and because pages are
 * independent, a page that fails outright leaves every earlier page's results and history intact —
 * the caller simply retries from the last cursor it saw. No path here deletes or rewrites match
 * history: insertJobMatchResult's existing immutable-insert + supersede contract is the only writer.
 *
 * @throws if candidateId is not an active candidate — callers validate first (the API returns 404).
 */
export function rematchCandidateJobsPage(options: RematchCandidatePageOptions): RematchCandidatePageResult {
  const { candidateId } = options;
  const candidate = requireActiveCandidate(candidateId);
  if (!candidate) throw new Error(`Candidate ${candidateId} is not an active candidate`);

  const limit = clampLimit(options.limit);
  const now = options.now ?? new Date();
  const result = emptyPage(candidateId);

  const jobs = listCandidateRematchJobPage({
    candidateId,
    afterJobId: options.afterJobId,
    limit,
    maxAgeDays: REMATCH_MAX_AGE_DAYS,
    now,
  });
  result.jobsConsidered = jobs.length;
  result.hasMore = jobs.length === limit;
  result.nextCursor = jobs.length > 0 ? jobs[jobs.length - 1].id : null;
  if (jobs.length === 0) return result;

  const candidateSettings = getMatchAffectingSettings(candidateId);

  // Resolved once for the whole page (see CandidateMatchIdentity). A missing/stale candidate profile
  // is reported as one page-level failure and stops this page cleanly — matching every job in the
  // page individually against a profile the engine will refuse to use would produce N identical
  // failures and burn the whole 19k-job walk for nothing.
  const identity = resolveCandidateMatchIdentity(candidateId, candidateSettings);
  if (identity.status === "unavailable") {
    result.failures.push({ candidateId, dedupeKey: null, reason: identity.reason });
    result.hasMore = false;
    result.nextCursor = null;
    return result;
  }

  const startedAt = new Date().toISOString();
  const evaluatedPairs: EvaluatedMatchPair[] = [];
  const errorMessages: string[] = [];
  let jobsErrored = 0;

  for (const job of jobs) {
    result.pairsAttempted++;
    try {
      const resolution = resolveJobMatchResult({
        job,
        candidateId,
        candidateSettings,
        identity: identity.identity,
        evaluate: options.evaluate,
      });

      if (resolution.status === "unavailable") {
        jobsErrored++;
        errorMessages.push(`candidate ${candidateId} / job ${job.dedupe_key}: ${resolution.reason}`);
        result.failures.push({ candidateId, dedupeKey: job.dedupe_key, reason: resolution.reason });
        continue;
      }

      if (resolution.status === "created") result.resultsCreated++;
      else result.resultsReused++;
      evaluatedPairs.push({ candidateId, dedupeKey: job.dedupe_key });

      if (resolution.decision === "BLOCKED") result.blocked++;
      else if (resolution.decision === "NEEDS_REVIEW") result.needsReview++;
      else result.readyForTailoring++;
    } catch (err) {
      // Same per-pair isolation principle as incrementalMatchAffectedJobs' inner catch.
      jobsErrored++;
      const message = err instanceof Error ? err.message : String(err);
      errorMessages.push(`candidate ${candidateId} / job ${job.dedupe_key}: ${message}`);
      result.failures.push({ candidateId, dedupeKey: job.dedupe_key, reason: message });
    }
  }

  // One match_runs row per PAGE, not per job — match_runs already models "one candidate's batch
  // evaluation execution" (see src/db/queries/matchRuns.ts), and a page is exactly that. No new run
  // table, and no per-job row explosion across a ~194-page full walk.
  insertMatchRun({
    candidateId,
    startedAt,
    finishedAt: new Date().toISOString(),
    jobsEvaluated: jobs.length,
    jobsBlocked: result.blocked,
    jobsNeedsReview: result.needsReview,
    jobsReady: result.readyForTailoring,
    jobsErrored,
    errorSummary: errorMessages.length > 0 ? errorMessages.slice(0, 20).join("; ") : null,
  });

  if (evaluatedPairs.length > 0) {
    // Stage 4, unchanged and authoritative: eligibility policy, the NEEDS_REVIEW threshold, the
    // Applied/Interviewing/Offer/Employer Rejected suppression set and the
    // UNIQUE(candidate_id, dedupe_key, type) dedup all stay entirely inside that service. A job that
    // already notified this candidate simply does not notify again, whatever the new score says.
    try {
      result.notifications = generateNotificationsForIncrementalMatches({ evaluatedPairs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.notifications = {
        evaluated: evaluatedPairs.length,
        created: 0,
        skipped: 0,
        failures: evaluatedPairs.map((pair) => ({ candidateId: pair.candidateId, dedupeKey: pair.dedupeKey, reason: message })),
      };
    }
  }

  return result;
}

export interface RematchCandidateAllPagesResult {
  candidateId: number;
  pages: number;
  jobsConsidered: number;
  pairsAttempted: number;
  resultsCreated: number;
  resultsReused: number;
  failures: RematchFailure[];
  readyForTailoring: number;
  needsReview: number;
  blocked: number;
  notificationsCreated: number;
  notificationFailures: number;
  lastCursor: number | null;
}

export interface RematchCandidateAllPagesOptions {
  candidateId: number;
  limit?: number;
  now?: Date;
  evaluate?: typeof evaluateJobMatch;
  /** Progress callback, invoked after each page — the CLI prints from here. */
  onPage?: (page: RematchCandidatePageResult, pageNumber: number) => void;
  /** Safety valve so a caller can never spin forever on an unexpected cursor bug. */
  maxPages?: number;
  /** Resume point: starts the walk after this job id instead of from the very beginning. Mirrors
   *  rematchCandidateJobsPage's own afterJobId — a caller (or a test isolating its own fixture jobs
   *  from a shared job pool) can resume/scope a full walk exactly like a single page can. */
  startAfterJobId?: number;
}

/**
 * Walks rematchCandidateJobsPage until hasMore is false. This is the ONLY loop over the paged
 * service, shared by scripts/rematch-candidate.ts — the CLI is a thin argv wrapper around this
 * function and implements no matching, selection or notification logic of its own. Never call this
 * from an HTTP handler: a full walk is ~403 s at production scale, which is precisely what the paged
 * API exists to avoid.
 */
export function rematchCandidateAllPages(options: RematchCandidateAllPagesOptions): RematchCandidateAllPagesResult {
  const totals: RematchCandidateAllPagesResult = {
    candidateId: options.candidateId,
    pages: 0,
    jobsConsidered: 0,
    pairsAttempted: 0,
    resultsCreated: 0,
    resultsReused: 0,
    failures: [],
    readyForTailoring: 0,
    needsReview: 0,
    blocked: 0,
    notificationsCreated: 0,
    notificationFailures: 0,
    lastCursor: null,
  };

  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  let afterJobId: number | undefined = options.startAfterJobId;

  for (;;) {
    const page = rematchCandidateJobsPage({
      candidateId: options.candidateId,
      afterJobId,
      limit: options.limit,
      now: options.now,
      evaluate: options.evaluate,
    });

    totals.pages++;
    totals.jobsConsidered += page.jobsConsidered;
    totals.pairsAttempted += page.pairsAttempted;
    totals.resultsCreated += page.resultsCreated;
    totals.resultsReused += page.resultsReused;
    totals.failures.push(...page.failures);
    totals.readyForTailoring += page.readyForTailoring;
    totals.needsReview += page.needsReview;
    totals.blocked += page.blocked;
    totals.notificationsCreated += page.notifications.created;
    totals.notificationFailures += page.notifications.failures.length;
    if (page.nextCursor !== null) totals.lastCursor = page.nextCursor;

    options.onPage?.(page, totals.pages);

    // A page with no cursor cannot be continued from (empty page, or a page-level profile failure),
    // so hasMore alone is never trusted to terminate the loop.
    if (!page.hasMore || page.nextCursor === null || totals.pages >= maxPages) break;
    afterJobId = page.nextCursor;
  }

  return totals;
}
