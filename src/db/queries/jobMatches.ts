import { getDb } from "@/db";
import type { JobMatchResult } from "@/lib/match/types";

/**
 * Persistence layer for job_match_results — mirrors src/db/queries/aiEnrichments.ts's
 * identity-safety and immutability conventions exactly: dedupe_key (not job_id) is authoritative
 * for every lookup, and a row for an exact key is never updated once written.
 */

export interface JobMatchResultRow {
  id: number;
  dedupe_key: string;
  job_id: number;
  match_engine_version: number;
  match_knowledge_hash: string;
  candidate_profile_hash: string;
  candidate_settings_hash: string;
  jd_content_hash: string;
  eligibility_status: string;
  eligibility_reasons: string;
  requirement_coverage: number;
  overall_score: number;
  employer_evidenced_share: number;
  insufficient_jd_signal: 0 | 1;
  dimension_scores: string;
  requirement_breakdown: string;
  recommended_track: string;
  decision: string;
  blocking_reasons: string;
  status: "active" | "superseded";
  created_at: string;
}

export interface JobMatchResultKey {
  dedupeKey: string;
  matchEngineVersion: number;
  matchKnowledgeHash: string;
  candidateProfileHash: string;
  candidateSettingsHash: string;
  jdContentHash: string;
}

/** Exact-key lookup — this IS the cache lookup. Ignores `status` on purpose, same reasoning as
 *  getAiEnrichment: an 'active' vs. 'superseded' row for the exact same key is still the exact same
 *  immutable result. */
export function getJobMatchResult(key: JobMatchResultKey): JobMatchResultRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM job_match_results
       WHERE dedupe_key = @dedupeKey AND match_engine_version = @matchEngineVersion
         AND match_knowledge_hash = @matchKnowledgeHash AND candidate_profile_hash = @candidateProfileHash
         AND candidate_settings_hash = @candidateSettingsHash AND jd_content_hash = @jdContentHash`
    )
    .get(key) as JobMatchResultRow | undefined;
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

function serializeResult(data: JobMatchResult) {
  return {
    dedupeKey: data.dedupeKey,
    jobId: data.jobId,
    matchEngineVersion: data.matchEngineVersion,
    matchKnowledgeHash: data.matchKnowledgeHash,
    candidateProfileHash: data.candidateProfileHash,
    candidateSettingsHash: data.candidateSettingsHash,
    jdContentHash: data.jdContentHash,
    eligibilityStatus: data.eligibility.status,
    eligibilityReasons: JSON.stringify(data.eligibility.reasons),
    requirementCoverage: data.requirementCoverage,
    overallScore: data.overallScore,
    employerEvidencedShare: data.employerEvidencedShare,
    insufficientJdSignal: data.insufficientJdSignal ? 1 : 0,
    dimensionScores: JSON.stringify(data.dimensionScores),
    requirementBreakdown: JSON.stringify({
      employerEvidencedMatches: data.employerEvidencedMatches,
      inventoryOnlyMatches: data.inventoryOnlyMatches,
      transferableMatches: data.transferableMatches,
      missingRequirements: data.missingRequirements,
      unresolvedRequirements: data.unresolvedRequirements,
      unrecognizedCandidateSkills: data.unrecognizedCandidateSkills,
    }),
    recommendedTrack: data.recommendedTrack,
    decision: data.decision,
    blockingReasons: JSON.stringify(data.blockingReasons),
  };
}

/**
 * Immutable insert (mirrors insertAiEnrichment exactly, including race safety): a call for a key
 * that already exists simply returns the existing row unchanged. A losing concurrent INSERT fails
 * with SQLITE_CONSTRAINT_UNIQUE, caught and treated as "someone else just wrote it."
 */
export function insertJobMatchResult(data: JobMatchResult): JobMatchResultRow {
  const params = serializeResult(data);
  const existing = getJobMatchResult({
    dedupeKey: data.dedupeKey,
    matchEngineVersion: data.matchEngineVersion,
    matchKnowledgeHash: data.matchKnowledgeHash,
    candidateProfileHash: data.candidateProfileHash,
    candidateSettingsHash: data.candidateSettingsHash,
    jdContentHash: data.jdContentHash,
  });
  if (existing) return existing;

  const db = getDb();
  try {
    db.prepare(
      `INSERT INTO job_match_results
        (dedupe_key, job_id, match_engine_version, match_knowledge_hash, candidate_profile_hash,
         candidate_settings_hash, jd_content_hash, eligibility_status, eligibility_reasons,
         requirement_coverage, overall_score, employer_evidenced_share, insufficient_jd_signal,
         dimension_scores, requirement_breakdown, recommended_track, decision, blocking_reasons)
       VALUES
        (@dedupeKey, @jobId, @matchEngineVersion, @matchKnowledgeHash, @candidateProfileHash,
         @candidateSettingsHash, @jdContentHash, @eligibilityStatus, @eligibilityReasons,
         @requirementCoverage, @overallScore, @employerEvidencedShare, @insufficientJdSignal,
         @dimensionScores, @requirementBreakdown, @recommendedTrack, @decision, @blockingReasons)`
    ).run(params);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const raceWinner = getJobMatchResult({
        dedupeKey: data.dedupeKey,
        matchEngineVersion: data.matchEngineVersion,
        matchKnowledgeHash: data.matchKnowledgeHash,
        candidateProfileHash: data.candidateProfileHash,
        candidateSettingsHash: data.candidateSettingsHash,
        jdContentHash: data.jdContentHash,
      });
      if (raceWinner) return raceWinner;
    }
    throw err;
  }

  db.prepare(
    `UPDATE job_match_results SET status = 'superseded'
     WHERE dedupe_key = @dedupeKey AND id != (SELECT id FROM job_match_results WHERE dedupe_key = @dedupeKey ORDER BY id DESC LIMIT 1)
       AND status = 'active'`
  ).run({ dedupeKey: data.dedupeKey });

  return getJobMatchResult({
    dedupeKey: data.dedupeKey,
    matchEngineVersion: data.matchEngineVersion,
    matchKnowledgeHash: data.matchKnowledgeHash,
    candidateProfileHash: data.candidateProfileHash,
    candidateSettingsHash: data.candidateSettingsHash,
    jdContentHash: data.jdContentHash,
  })!;
}

/** Latest result for a job, by dedupe_key — never by job_id, so this still resolves correctly for
 *  a job whose numeric id was reused after deletion (see the table's IDENTITY SAFETY comment). */
export function getLatestJobMatchResult(dedupeKey: string): JobMatchResultRow | undefined {
  return getDb()
    .prepare("SELECT * FROM job_match_results WHERE dedupe_key = ? ORDER BY id DESC LIMIT 1")
    .get(dedupeKey) as JobMatchResultRow | undefined;
}

/** Full history for a job, by dedupe_key — survives the underlying job row being deleted entirely. */
export function listJobMatchHistory(dedupeKey: string): JobMatchResultRow[] {
  return getDb()
    .prepare("SELECT * FROM job_match_results WHERE dedupe_key = ? ORDER BY id DESC")
    .all(dedupeKey) as JobMatchResultRow[];
}

export interface LatestDecisionSummary {
  decision: string;
  overallScore: number;
}

/** Batch lookup of each dedupe_key's latest decision — used by the job-list badge/filter (a single
 *  query for the whole visible page of jobs, never one query per row). Keyed by dedupe_key, never
 *  job_id, same identity discipline as every other lookup in this file. Jobs never evaluated are
 *  simply absent from the returned map. */
export function listLatestDecisionsForDedupeKeys(dedupeKeys: string[]): Record<string, LatestDecisionSummary> {
  if (dedupeKeys.length === 0) return {};
  const db = getDb();
  const placeholders = dedupeKeys.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT t.dedupe_key, t.decision, t.overall_score
       FROM job_match_results t
       INNER JOIN (
         SELECT dedupe_key, MAX(id) AS max_id FROM job_match_results WHERE dedupe_key IN (${placeholders}) GROUP BY dedupe_key
       ) latest ON latest.max_id = t.id`
    )
    .all(...dedupeKeys) as { dedupe_key: string; decision: string; overall_score: number }[];

  const result: Record<string, LatestDecisionSummary> = {};
  for (const row of rows) {
    result[row.dedupe_key] = { decision: row.decision, overallScore: row.overall_score };
  }
  return result;
}
