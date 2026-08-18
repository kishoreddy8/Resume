import { getDb } from "@/db";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getMatchAffectingSettings } from "@/db/queries/candidateSettings";
import { getJob } from "@/db/queries/jobs";
import { resolveCandidateMatchIdentity, type CandidateMatchIdentity } from "./matchIdentity";
import { resolveJobMatchResult } from "./resolveJobMatch";

export interface AutomaticEvaluationResult {
  candidateId: number;
  candidatesFound: number;
  processed: number;
  evaluated: number;
  cached: number;
  unavailable: number;
  errored: number;
  blocked: number;
  needsReview: number;
  ready: number;
  errors: Array<{ jobId: number; error: string }>;
}

/**
 * Selects jobs genuinely needing (re-)evaluation for one candidate. Three independent reasons, all
 * evaluated against the candidate's CURRENT matching identity:
 *   1. No job_match_results row at all for this candidate (Stage 24A).
 *   2. The latest row was computed under a DIFFERENT matching identity — a different
 *      MATCH_ENGINE_VERSION, matchKnowledgeHash, candidateProfileHash or candidateSettingsHash.
 *      Those are exactly the four cache-key components that are constant across all jobs in one pass
 *      (see matchIdentity.ts), so they compare as SQL literals here rather than per-row work.
 *   3. The job row itself changed after the latest evaluation was written (j.updated_at >
 *      latest.created_at) — the JD-content half of the cache key, detected without hashing 19k
 *      descriptions in SQL. resolveJobMatchResult still does the exact jdContentHash comparison per
 *      job, so a touched-but-unchanged JD costs one cache hit, never a wrong result.
 *
 * STAGE 24B — WHY (2) HAD TO BE ADDED. Stage 24A selected only "no row at all" plus a narrow
 * insufficient_jd_signal=1 AND job-updated case. Any job whose latest evaluation was meaningful
 * (insufficient_jd_signal=0) was never re-selected by the automatic tick, for any reason. That meant
 * a MATCH_ENGINE_VERSION bump, a scoring-weight change, a rebuilt candidate profile, or a changed
 * candidate eligibility setting would invalidate the cache correctly — and then no automatic run
 * would ever act on that invalidation. Stage 24B changes the engine version and the scoring weights,
 * so without this the whole corpus would have sat permanently stale behind the UI.
 *
 * CONVERGENCE (the property Stage 24A's narrow condition existed to protect) is preserved: reason 2
 * stops matching as soon as the row is rewritten under the current identity, and reason 3 stops
 * matching because the fresh row's created_at is newer than the job's updated_at. A job whose JD
 * genuinely never clears MIN_REQUIREMENT_UNITS is evaluated once and then left alone — it is NOT
 * re-selected every tick.
 *
 * STAGE 25A — WHY `is_archived = 0` IS PART OF THE PREDICATE. It used to filter on is_active alone,
 * which counted ARCHIVED jobs as outstanding work. Measured after a full, clean pass on the real
 * corpus: rematch-candidate reported 17,996 pairs processed and 0 failures, a second run reused all
 * 17,996 and created nothing — yet countJobsNeedingEvaluation still reported a backlog of 1,669, of
 * which 1,600 were archived rows. Every archived job is excluded from the jobs list, the For You
 * feed and listCandidateRematchJobPage, so no view could ever show their scores; the operator-facing
 * backlog metric was therefore permanently non-zero with no command able to drain it, and the
 * bounded evaluation tick spent part of its per-run budget re-scoring rows nothing can display.
 * Un-archiving a job puts it straight back into this predicate, so nothing is permanently skipped.
 */
function listJobIdsNeedingEvaluation(candidateId: number, identity: CandidateMatchIdentity, limit: number): number[] {
  const rows = getDb()
    .prepare(
      `SELECT j.id FROM jobs j
       LEFT JOIN (
         SELECT dedupe_key, created_at, match_engine_version, match_knowledge_hash,
                candidate_profile_hash, candidate_settings_hash,
                ROW_NUMBER() OVER (PARTITION BY dedupe_key ORDER BY id DESC) AS rn
         FROM job_match_results
         WHERE candidate_id = @candidateId
       ) latest ON latest.dedupe_key = j.dedupe_key AND latest.rn = 1
       WHERE j.is_active = 1
         AND j.is_archived = 0
         AND (
           latest.dedupe_key IS NULL
           OR latest.match_engine_version <> @matchEngineVersion
           OR latest.match_knowledge_hash <> @matchKnowledgeHash
           OR latest.candidate_profile_hash <> @candidateProfileHash
           OR latest.candidate_settings_hash <> @candidateSettingsHash
           OR j.updated_at > latest.created_at
         )
       ORDER BY j.posted_at DESC, j.id DESC
       LIMIT @limit`
    )
    .all({
      candidateId,
      matchEngineVersion: identity.matchEngineVersion,
      matchKnowledgeHash: identity.matchKnowledgeHash,
      candidateProfileHash: identity.candidateProfileHash,
      candidateSettingsHash: identity.candidateSettingsHash,
      limit,
    }) as { id: number }[];
  return rows.map((r) => r.id);
}

/** Read-only: how many active jobs this candidate currently has outstanding, using the exact same
 *  predicate as the selector above. Used by the operator-facing backlog reporting so "backlog before
 *  / after" is measured against the real selection rule, not an approximation of it. */
export function countJobsNeedingEvaluation(candidateId: number): number {
  const identity = resolveCandidateMatchIdentity(candidateId, getMatchAffectingSettings(candidateId));
  if (identity.status === "unavailable") return 0;
  return listJobIdsNeedingEvaluation(candidateId, identity.identity, Number.MAX_SAFE_INTEGER).length;
}

/**
 * Stage 24A — bounded, idempotent, failure-isolated automatic match evaluation for one candidate.
 * Reuses the EXACT SAME deterministic engine (evaluateJobMatch/buildEvaluateJobMatchInput) and
 * persistence (getJobMatchResult/insertJobMatchResult) as the existing manual single-job and batch
 * evaluation API routes — this is not a second match engine, just a different, backlog-aware
 * selection of which jobs to run it against. One job's failure is caught and recorded, never
 * aborting the batch (same principle as scan.ts's per-company isolation).
 */
export function runAutomaticJobEvaluation(
  candidateId: number,
  limit: number,
  /** Optional explicit targets (e.g. a UI's "re-evaluate this job now" action) — bypasses the
   *  backlog-priority selection entirely and evaluates exactly these jobs, same pattern as
   *  POST /api/jobs/match/batch's own jobIds override. */
  explicitJobIds?: number[]
): AutomaticEvaluationResult {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
  const result: AutomaticEvaluationResult = {
    candidateId,
    candidatesFound: 0,
    processed: 0,
    evaluated: 0,
    cached: 0,
    unavailable: 0,
    errored: 0,
    blocked: 0,
    needsReview: 0,
    ready: 0,
    errors: [],
  };

  if (!requireActiveCandidate(candidateId)) return result;

  const candidateSettings = getMatchAffectingSettings(candidateId);
  // Resolved ONCE per batch, exactly as incrementalMatch.ts/rematchCandidate.ts already do — it is
  // identical for every job in the pass and computing it per job would re-serialize the whole skill
  // taxonomy 200 times. An unusable (missing/stale) candidate profile means no job in this batch can
  // produce a result, which is the same "unavailable" outcome the engine itself would report per job.
  const identity = resolveCandidateMatchIdentity(candidateId, candidateSettings);

  const jobIds = explicitJobIds && explicitJobIds.length > 0
    ? explicitJobIds.slice(0, boundedLimit)
    : identity.status === "ok"
      ? listJobIdsNeedingEvaluation(candidateId, identity.identity, boundedLimit)
      : [];
  result.candidatesFound = jobIds.length;
  if (jobIds.length === 0) return result;

  if (identity.status === "unavailable") {
    result.processed = jobIds.length;
    result.unavailable = jobIds.length;
    return result;
  }

  for (const jobId of jobIds) {
    result.processed++;
    const job = getJob(jobId);
    if (!job) continue;
    try {
      // Stage 24B: goes through the shared resolve-or-evaluate step (Phase 4 Stage 5's
      // resolveJobMatch.ts) instead of always paying the engine's full CPU cost and only then
      // checking the cache. Identical scoring/persistence — on a miss it makes the exact same
      // buildEvaluateJobMatchInput + evaluateJobMatch + insertJobMatchResult calls — but an
      // already-current pair now costs one indexed lookup instead of a full ~20 ms evaluation.
      const resolution = resolveJobMatchResult({ job, candidateId, candidateSettings, identity: identity.identity });
      if (resolution.status === "unavailable") {
        result.unavailable++;
        continue;
      }
      if (resolution.status === "reused") result.cached++;
      else result.evaluated++;
      if (resolution.decision === "BLOCKED") result.blocked++;
      else if (resolution.decision === "NEEDS_REVIEW") result.needsReview++;
      else result.ready++;
    } catch (err) {
      result.errored++;
      result.errors.push({ jobId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
