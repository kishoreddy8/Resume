import { getDb } from "@/db";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getMatchAffectingSettings } from "@/db/queries/candidateSettings";
import { getJob } from "@/db/queries/jobs";
import { getJobMatchResult, insertJobMatchResult } from "@/db/queries/jobMatches";
import { buildEvaluateJobMatchInput } from "./buildMatchInput";
import { evaluateJobMatch } from "./evaluateJobMatch";

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
 * Stage 24A — selects jobs genuinely needing (re-)evaluation for one candidate: active jobs with no
 * job_match_results row at all for this candidate, OR whose latest row was computed with
 * insufficient_jd_signal=1 (a near-zero-signal evaluation from before this job had real structured
 * intelligence — see backfillJobIntelligence.ts) AND the job itself has been updated since that
 * evaluation ran. That second condition is load-bearing, not cosmetic: without it, a job whose JD
 * genuinely never clears the 3-requirement-unit floor (MIN_REQUIREMENT_UNITS in scoring.ts) would be
 * re-selected on every single automatic-evaluation run forever, since re-evaluating unchanged
 * content always reproduces the same insufficient result — burning cycles without ever converging,
 * exactly what Phase 16 warns against. Never re-selects a job whose latest evaluation was genuinely
 * meaningful (insufficient_jd_signal=0); evaluateJobMatch/insertJobMatchResult's own content-hash
 * cache handles the rest of that idempotency for whatever this DOES select.
 */
function listJobIdsNeedingEvaluation(candidateId: number, limit: number): number[] {
  const rows = getDb()
    .prepare(
      `SELECT j.id FROM jobs j
       LEFT JOIN (
         SELECT dedupe_key, insufficient_jd_signal, created_at,
                ROW_NUMBER() OVER (PARTITION BY dedupe_key ORDER BY id DESC) AS rn
         FROM job_match_results
         WHERE candidate_id = ?
       ) latest ON latest.dedupe_key = j.dedupe_key AND latest.rn = 1
       WHERE j.is_active = 1
         AND (
           latest.dedupe_key IS NULL
           OR (latest.insufficient_jd_signal = 1 AND j.updated_at > latest.created_at)
         )
       ORDER BY j.posted_at DESC, j.id DESC
       LIMIT ?`
    )
    .all(candidateId, limit) as { id: number }[];
  return rows.map((r) => r.id);
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

  const jobIds = explicitJobIds && explicitJobIds.length > 0
    ? explicitJobIds.slice(0, boundedLimit)
    : listJobIdsNeedingEvaluation(candidateId, boundedLimit);
  result.candidatesFound = jobIds.length;
  if (jobIds.length === 0) return result;

  const candidateSettings = getMatchAffectingSettings(candidateId);

  for (const jobId of jobIds) {
    result.processed++;
    const job = getJob(jobId);
    if (!job) continue;
    try {
      const evalResult = evaluateJobMatch(buildEvaluateJobMatchInput(job), candidateSettings, candidateId);
      if (evalResult.status === "unavailable") {
        result.unavailable++;
        continue;
      }
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
      if (existing) result.cached++;
      else result.evaluated++;
      if (evalResult.data.decision === "BLOCKED") result.blocked++;
      else if (evalResult.data.decision === "NEEDS_REVIEW") result.needsReview++;
      else result.ready++;
    } catch (err) {
      result.errored++;
      result.errors.push({ jobId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
