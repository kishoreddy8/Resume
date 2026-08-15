import { listCandidateJobStates, type CandidateJobStateRow } from "@/db/queries/candidateJobState";
import { getJob, getJobIdByDedupeKey } from "@/db/queries/jobs";
import { getLatestJobMatchResult } from "@/db/queries/jobMatches";
import { createNotificationIfAbsent } from "@/db/queries/notifications";
import type { EvaluatedMatchPair, IncrementalMatchResult } from "@/lib/match/incrementalMatch";
import type { Decision } from "@/lib/match/types";
import { HIGH_VALUE_JOB_MATCH_NOTIFICATION_TYPE, isEligibleForHighValueMatchNotification } from "./eligibility";
import type { JobWithCompany } from "@/types";

/**
 * Phase 4 Stage 4 — notification-generation service. Deliberately separate from React/API code and
 * from Phase 2 itself (never called by evaluateJobMatch/insertJobMatchResult — see
 * src/lib/match/evaluateJobMatch.ts/jobMatches.ts, both untouched by this stage). Consumes Stage 2's
 * IncrementalMatchResult.evaluatedPairs directly, so it only ever evaluates jobs Stage 2 itself just
 * matched — never a full job_match_results scan.
 */

export interface NotificationGenerationFailure {
  candidateId: number;
  dedupeKey: string;
  reason: string;
}

export interface NotificationGenerationResult {
  evaluated: number;
  created: number;
  skipped: number;
  failures: NotificationGenerationFailure[];
}

function emptyResult(): NotificationGenerationResult {
  return { evaluated: 0, created: 0, skipped: 0, failures: [] };
}

function notificationTitle(job: JobWithCompany): string {
  return `${job.title} at ${job.company_name}`;
}

function notificationBody(decision: Decision, overallScore: number): string {
  if (decision === "READY_FOR_TAILORING") {
    return `${overallScore}% match — Ready for Tailoring. New high-quality match found.`;
  }
  return `${overallScore}% match — Needs Review. Strong match requires review.`;
}

/**
 * Evaluates exactly the (candidate, job) pairs Stage 2 just matched (`matching.evaluatedPairs`) —
 * both freshly-created and cache-hit results are considered equally (a cache hit does not bypass
 * eligibility; see eligibility.ts's doc comment), and idempotency is enforced by the database
 * UNIQUE(candidate_id, dedupe_key, type) constraint via createNotificationIfAbsent, not by this
 * function re-checking existence itself. Every pair is isolated in its own try/catch — one pair's
 * failure never drops the notifications already created for other pairs, and never touches
 * `matching`/`scan` results (see src/lib/scan/runScanWithMatching.ts's caller).
 *
 * Batches DB reads to stay O(unique jobs + unique candidates), never O(pairs) queries and never a
 * full jobs/job_match_results table scan, regardless of how many candidates share the same job.
 */
export function generateNotificationsForIncrementalMatches(
  // Phase 4 Stage 5 widened this to also accept just the one field actually read, so the paged
  // candidate rematch (src/lib/match/rematchCandidate.ts) can pass its own evaluated pairs without
  // fabricating the rest of an IncrementalMatchResult. The union (rather than Pick alone) keeps
  // existing callers/tests that construct a full literal IncrementalMatchResult excess-property-
  // check-clean. Existing callers are otherwise unaffected; NO eligibility, dedup or policy change.
  matching: IncrementalMatchResult | Pick<IncrementalMatchResult, "evaluatedPairs">
): NotificationGenerationResult {
  const result = emptyResult();
  const pairs: EvaluatedMatchPair[] = matching.evaluatedPairs;
  if (pairs.length === 0) return result;

  const uniqueDedupeKeys = Array.from(new Set(pairs.map((p) => p.dedupeKey)));
  const jobsByDedupeKey = new Map<string, JobWithCompany>();
  for (const dedupeKey of uniqueDedupeKeys) {
    const jobId = getJobIdByDedupeKey(dedupeKey);
    if (jobId === undefined) continue;
    const job = getJob(jobId);
    if (job) jobsByDedupeKey.set(dedupeKey, job);
  }

  const uniqueCandidateIds = Array.from(new Set(pairs.map((p) => p.candidateId)));
  const statesByCandidateId = new Map<number, Record<string, CandidateJobStateRow>>();
  for (const candidateId of uniqueCandidateIds) {
    statesByCandidateId.set(candidateId, listCandidateJobStates(candidateId, uniqueDedupeKeys));
  }

  for (const pair of pairs) {
    result.evaluated++;
    try {
      const job = jobsByDedupeKey.get(pair.dedupeKey);
      if (!job) {
        result.skipped++;
        continue;
      }

      const matchRow = getLatestJobMatchResult(pair.candidateId, pair.dedupeKey);
      if (!matchRow) {
        result.skipped++;
        continue;
      }

      const state = statesByCandidateId.get(pair.candidateId)?.[pair.dedupeKey];
      const eligible = isEligibleForHighValueMatchNotification({
        decision: matchRow.decision as Decision,
        overallScore: matchRow.overall_score,
        isCurrent: matchRow.status !== "superseded",
        jobIsActive: job.is_active === 1,
        postedAt: job.posted_at,
        firstSeenAt: job.first_seen_at,
        pipelineStatus: state?.pipeline_status ?? "New",
      });

      if (!eligible) {
        result.skipped++;
        continue;
      }

      const created = createNotificationIfAbsent({
        candidateId: pair.candidateId,
        dedupeKey: pair.dedupeKey,
        type: HIGH_VALUE_JOB_MATCH_NOTIFICATION_TYPE,
        title: notificationTitle(job),
        body: notificationBody(matchRow.decision as Decision, matchRow.overall_score),
      });

      if (created) result.created++;
      else result.skipped++; // already existed — idempotent no-op, not a failure
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failures.push({ candidateId: pair.candidateId, dedupeKey: pair.dedupeKey, reason: message });
    }
  }

  return result;
}
