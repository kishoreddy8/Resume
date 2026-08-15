import { listCandidates, requireActiveCandidate } from "@/db/queries/candidates";
import { getMatchAffectingSettings } from "@/db/queries/candidateSettings";
import { getJob, getJobIdByDedupeKey } from "@/db/queries/jobs";
import { getJobMatchResult, insertJobMatchResult } from "@/db/queries/jobMatches";
import { insertMatchRun } from "@/db/queries/matchRuns";
import { buildEvaluateJobMatchInput } from "./buildMatchInput";
import { evaluateJobMatch } from "./evaluateJobMatch";

/**
 * Phase 4 Stage 2 — orchestration around the existing, FROZEN Phase 2 engine. This module contains
 * zero scoring/eligibility/decision logic of its own: it resolves affected jobs and active
 * candidates, then calls evaluateJobMatch() + insertJobMatchResult() for every pair, exactly the
 * same two calls src/app/api/jobs/[id]/match/route.ts and src/app/api/jobs/match/batch/route.ts
 * already make (via the shared src/lib/match/buildMatchInput.ts input-assembly helper). See
 * evaluateJobMatch.ts/decision.ts/scoring.ts for the actual matching logic — untouched here.
 *
 * No queue, no parallelism: at current scale (a handful of active candidates x a low-hundreds-job
 * scan delta), simple bounded synchronous iteration is sufficient, matching the existing batch
 * route's own documented rationale for staying synchronous/in-request.
 */

export interface IncrementalMatchFailure {
  candidateId: number;
  dedupeKey: string;
  /** A short machine-readable reason ("missing_candidate_profile", "stale_candidate_profile") or a
   *  caught exception's message — never a raw stack trace (see incrementalMatchAffectedJobs' catch
   *  block, which only ever captures `.message`). */
  reason: string;
}

/** One (candidate, job) pair that produced a current, persisted job_match_results row this run —
 *  whether freshly created or a cache hit (see resultsCreated/resultsReused). Phase 4 Stage 4's
 *  notification generator consumes this directly instead of re-deriving which pairs have a current
 *  result, so it never has to duplicate this module's own candidate/job resolution or re-query
 *  job_match_results from scratch (see src/lib/notifications/generateNotifications.ts). Deliberately
 *  excludes "unavailable" and thrown-exception pairs — those are already in `failures` above and
 *  never produced a usable result.
 */
export interface EvaluatedMatchPair {
  candidateId: number;
  dedupeKey: string;
}

export interface IncrementalMatchResult {
  jobsRequested: number;
  /** Jobs actually found in the DB by dedupe_key — a dedupeKey with no matching jobs row (should not
   *  normally happen, since callers pass dedupeKeys sourced from ScanSummary.affectedJobDedupeKeys,
   *  but handled safely regardless) is silently excluded here, not counted as a failure per pair,
   *  since no candidate pairing was even attempted for it. */
  jobsResolved: number;
  candidatesConsidered: number;
  pairsAttempted: number;
  resultsCreated: number;
  resultsReused: number;
  failures: IncrementalMatchFailure[];
  readyForTailoring: number;
  needsReview: number;
  blocked: number;
  evaluatedPairs: EvaluatedMatchPair[];
}

export interface IncrementalMatchOptions {
  /** Canonical dedupe_key identities — see ScanSummary.affectedJobDedupeKeys. Deduplicated
   *  defensively even though callers are expected to already pass a unique list. */
  dedupeKeys: string[];
  /** Defaults to every active candidate (listCandidates()) when omitted. Explicit candidateIds are
   *  each validated via requireActiveCandidate — an archived/nonexistent id is silently excluded,
   *  never matched. */
  candidateIds?: number[];
}

function emptyResult(jobsRequested: number): IncrementalMatchResult {
  return {
    jobsRequested,
    jobsResolved: 0,
    candidatesConsidered: 0,
    pairsAttempted: 0,
    resultsCreated: 0,
    resultsReused: 0,
    failures: [],
    readyForTailoring: 0,
    needsReview: 0,
    blocked: 0,
    evaluatedPairs: [],
  };
}

/**
 * Evaluates every (affected job) x (active candidate) pair via the existing Phase 2 engine and
 * persists via the existing job_match_results cache/versioning contract unchanged (see
 * insertJobMatchResult's own exact-key hit-or-insert behavior in src/db/queries/jobMatches.ts) — a
 * pair already current under the current engine version/profile/settings/JD-content hash is a cache
 * hit (resultsReused), not a fresh write. One match_runs row is written per candidate processed
 * (reusing the existing table/query layer exactly as the batch route already does — see
 * src/db/queries/matchRuns.ts; NO new "incremental_match_runs" table), since match_runs already
 * models "one candidate's batch-evaluation execution" cleanly and this is exactly that, just
 * triggered automatically instead of via an explicit API call.
 *
 * Failure isolation: a thrown error, or an "unavailable" (missing/stale candidate profile) result,
 * for one (candidate, job) pair is recorded in `failures` and never aborts the remaining pairs —
 * see the try/catch inside the innermost loop below. Old job_match_results rows are never deleted;
 * a failed pair simply produces no new row for that (candidate, dedupeKey, current-hash) key.
 */
export function incrementalMatchAffectedJobs(options: IncrementalMatchOptions): IncrementalMatchResult {
  const dedupeKeys = Array.from(new Set(options.dedupeKeys));
  const result = emptyResult(dedupeKeys.length);

  // Safe no-op: zero affected jobs means nothing to do — no candidate/job resolution, no match_runs
  // rows, no engine calls at all.
  if (dedupeKeys.length === 0) return result;

  const candidates = options.candidateIds
    ? options.candidateIds
        .map((id) => requireActiveCandidate(id))
        .filter((c): c is NonNullable<typeof c> => c !== null)
    : listCandidates();
  result.candidatesConsidered = candidates.length;
  if (candidates.length === 0) return result;

  // Resolved once, reused across every candidate — an indexed dedupe_key lookup per affected job,
  // never a full jobs-table scan, and never re-resolved per candidate.
  const resolvedJobs = dedupeKeys
    .map((dedupeKey) => {
      const jobId = getJobIdByDedupeKey(dedupeKey);
      return jobId === undefined ? undefined : getJob(jobId);
    })
    .filter((job): job is NonNullable<typeof job> => job !== undefined);
  result.jobsResolved = resolvedJobs.length;

  for (const candidate of candidates) {
    const candidateSettings = getMatchAffectingSettings(candidate.id);
    const startedAt = new Date().toISOString();
    let jobsBlocked = 0;
    let jobsNeedsReview = 0;
    let jobsReady = 0;
    let jobsErrored = 0;
    const errorMessages: string[] = [];

    for (const job of resolvedJobs) {
      result.pairsAttempted++;
      try {
        const input = buildEvaluateJobMatchInput(job);
        const evalResult = evaluateJobMatch(input, candidateSettings, candidate.id);

        if (evalResult.status === "unavailable") {
          jobsErrored++;
          const message = evalResult.reason;
          errorMessages.push(`candidate ${candidate.id} / job ${job.dedupe_key}: ${message}`);
          result.failures.push({ candidateId: candidate.id, dedupeKey: job.dedupe_key, reason: message });
          continue;
        }

        // Check hit/miss BEFORE inserting — same reasoning as the single-job/batch routes: insertJobMatchResult
        // itself is hit-or-insert, so a pre-check is the only reliable way to report created vs. reused.
        const existing = getJobMatchResult({
          candidateId: evalResult.data.candidateId,
          dedupeKey: evalResult.data.dedupeKey,
          matchEngineVersion: evalResult.data.matchEngineVersion,
          matchKnowledgeHash: evalResult.data.matchKnowledgeHash,
          candidateProfileHash: evalResult.data.candidateProfileHash,
          candidateSettingsHash: evalResult.data.candidateSettingsHash,
          jdContentHash: evalResult.data.jdContentHash,
        });
        insertJobMatchResult(evalResult.data);
        if (existing) result.resultsReused++;
        else result.resultsCreated++;
        result.evaluatedPairs.push({ candidateId: candidate.id, dedupeKey: job.dedupe_key });

        if (evalResult.data.decision === "BLOCKED") {
          jobsBlocked++;
          result.blocked++;
        } else if (evalResult.data.decision === "NEEDS_REVIEW") {
          jobsNeedsReview++;
          result.needsReview++;
        } else {
          jobsReady++;
          result.readyForTailoring++;
        }
      } catch (err) {
        // One pair failing must never abort the batch — same failure-isolation principle as
        // src/lib/scan.ts's per-company try/catch and the existing batch route's per-job try/catch.
        jobsErrored++;
        const message = err instanceof Error ? err.message : String(err);
        errorMessages.push(`candidate ${candidate.id} / job ${job.dedupe_key}: ${message}`);
        result.failures.push({ candidateId: candidate.id, dedupeKey: job.dedupe_key, reason: message });
      }
    }

    insertMatchRun({
      candidateId: candidate.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      jobsEvaluated: resolvedJobs.length,
      jobsBlocked,
      jobsNeedsReview,
      jobsReady,
      jobsErrored,
      errorSummary: errorMessages.length > 0 ? errorMessages.slice(0, 20).join("; ") : null,
    });
  }

  return result;
}
