import { getDb } from "@/db";
import type { EligibilityResult, JobMatchResult, RequirementMatch } from "@/lib/match/types";

/**
 * Persistence layer for job_match_results — mirrors src/db/queries/aiEnrichments.ts's
 * identity-safety and immutability conventions exactly: dedupe_key (not job_id) is authoritative
 * for every lookup, and a row for an exact key is never updated once written.
 */

export interface JobMatchResultRow {
  id: number;
  candidate_id: number;
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
  candidateId: number;
  dedupeKey: string;
  matchEngineVersion: number;
  matchKnowledgeHash: string;
  candidateProfileHash: string;
  candidateSettingsHash: string;
  jdContentHash: string;
}

/** Exact-key lookup — this IS the cache lookup. Ignores `status` on purpose, same reasoning as
 *  getAiEnrichment: an 'active' vs. 'superseded' row for the exact same key is still the exact same
 *  immutable result. candidateId is part of the key so Candidate A's cache lookup can never return
 *  Candidate B's row even in the (currently unreachable, since profile/settings hashes already
 *  differ per candidate in practice) case of a hash coincidence. */
export function getJobMatchResult(key: JobMatchResultKey): JobMatchResultRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM job_match_results
       WHERE candidate_id = @candidateId AND dedupe_key = @dedupeKey AND match_engine_version = @matchEngineVersion
         AND match_knowledge_hash = @matchKnowledgeHash AND candidate_profile_hash = @candidateProfileHash
         AND candidate_settings_hash = @candidateSettingsHash AND jd_content_hash = @jdContentHash`
    )
    .get(key) as JobMatchResultRow | undefined;
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

/**
 * Everything that doesn't have its own column lives in `requirement_breakdown` as one JSON bucket.
 * `criticalGaps` and `eligibilitySponsorship` are included explicitly here (Phase 2.5 persistence-
 * contract fix — see deserializeJobMatchResult below for the legacy-row fallback for rows written
 * before this fix). Storing them directly (not deriving at read time) preserves job_match_results'
 * immutable-snapshot guarantee: a row's meaning must never depend on the CURRENT scoring code.
 */
function serializeResult(data: JobMatchResult) {
  return {
    candidateId: data.candidateId,
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
      criticalGaps: data.criticalGaps,
      unrecognizedCandidateSkills: data.unrecognizedCandidateSkills,
      eligibilitySponsorship: data.eligibility.sponsorship,
    }),
    recommendedTrack: data.recommendedTrack,
    decision: data.decision,
    blockingReasons: JSON.stringify(data.blockingReasons),
  };
}

interface RequirementBreakdown {
  employerEvidencedMatches: RequirementMatch[];
  inventoryOnlyMatches: RequirementMatch[];
  transferableMatches: RequirementMatch[];
  missingRequirements: RequirementMatch[];
  unresolvedRequirements: RequirementMatch[];
  criticalGaps?: RequirementMatch[]; // absent on rows written before the Phase 2.5 persistence fix
  unrecognizedCandidateSkills: string[];
  eligibilitySponsorship?: EligibilityResult["sponsorship"]; // absent on pre-fix rows
}

const LEGACY_ROW_SPONSORSHIP: EligibilityResult["sponsorship"] = {
  signal: "unknown",
  note: "Not recorded on this cached result (evaluated before sponsorship signal persistence was added) — re-evaluate to refresh.",
};

/**
 * The exact inverse of serializeResult: row -> full JobMatchResult. This is the ONE place that
 * reconstructs the API/UI-facing shape from a DB row, so every consumer (GET route, batch listing,
 * future features) gets a structurally-complete object and a partial/legacy row can never reach the
 * UI missing a field the type promises. Legacy rows (written before criticalGaps/eligibilitySponsorship
 * were persisted) get an honest, clearly-labeled fallback — never a fabricated value.
 */
export function deserializeJobMatchResult(row: JobMatchResultRow): JobMatchResult {
  const breakdown = JSON.parse(row.requirement_breakdown) as RequirementBreakdown;
  const missingRequirements = breakdown.missingRequirements ?? [];
  const unresolvedRequirements = breakdown.unresolvedRequirements ?? [];
  const criticalGaps =
    breakdown.criticalGaps ??
    [...missingRequirements, ...unresolvedRequirements].filter((m) => m.requirement.criticality === "CRITICAL");

  return {
    candidateId: row.candidate_id,
    jobId: row.job_id,
    dedupeKey: row.dedupe_key,
    matchEngineVersion: row.match_engine_version,
    matchKnowledgeHash: row.match_knowledge_hash,
    candidateProfileHash: row.candidate_profile_hash,
    candidateSettingsHash: row.candidate_settings_hash,
    jdContentHash: row.jd_content_hash,
    computedAt: row.created_at,
    eligibility: {
      status: row.eligibility_status as EligibilityResult["status"],
      reasons: JSON.parse(row.eligibility_reasons),
      sponsorship: breakdown.eligibilitySponsorship ?? LEGACY_ROW_SPONSORSHIP,
    },
    dimensionScores: JSON.parse(row.dimension_scores),
    overallScore: row.overall_score,
    requirementCoverage: row.requirement_coverage,
    employerEvidencedShare: row.employer_evidenced_share,
    insufficientJdSignal: Boolean(row.insufficient_jd_signal),
    employerEvidencedMatches: breakdown.employerEvidencedMatches ?? [],
    inventoryOnlyMatches: breakdown.inventoryOnlyMatches ?? [],
    transferableMatches: breakdown.transferableMatches ?? [],
    missingRequirements,
    unresolvedRequirements,
    criticalGaps,
    unrecognizedCandidateSkills: breakdown.unrecognizedCandidateSkills ?? [],
    recommendedTrack: row.recommended_track as JobMatchResult["recommendedTrack"],
    decision: row.decision as JobMatchResult["decision"],
    blockingReasons: JSON.parse(row.blocking_reasons),
  };
}

/**
 * Immutable insert (mirrors insertAiEnrichment exactly, including race safety): a call for a key
 * that already exists simply returns the existing row unchanged. A losing concurrent INSERT fails
 * with SQLITE_CONSTRAINT_UNIQUE, caught and treated as "someone else just wrote it."
 */
export function insertJobMatchResult(data: JobMatchResult): JobMatchResultRow {
  const params = serializeResult(data);
  const key: JobMatchResultKey = {
    candidateId: data.candidateId,
    dedupeKey: data.dedupeKey,
    matchEngineVersion: data.matchEngineVersion,
    matchKnowledgeHash: data.matchKnowledgeHash,
    candidateProfileHash: data.candidateProfileHash,
    candidateSettingsHash: data.candidateSettingsHash,
    jdContentHash: data.jdContentHash,
  };
  const existing = getJobMatchResult(key);
  if (existing) return existing;

  const db = getDb();
  try {
    db.prepare(
      `INSERT INTO job_match_results
        (candidate_id, dedupe_key, job_id, match_engine_version, match_knowledge_hash, candidate_profile_hash,
         candidate_settings_hash, jd_content_hash, eligibility_status, eligibility_reasons,
         requirement_coverage, overall_score, employer_evidenced_share, insufficient_jd_signal,
         dimension_scores, requirement_breakdown, recommended_track, decision, blocking_reasons)
       VALUES
        (@candidateId, @dedupeKey, @jobId, @matchEngineVersion, @matchKnowledgeHash, @candidateProfileHash,
         @candidateSettingsHash, @jdContentHash, @eligibilityStatus, @eligibilityReasons,
         @requirementCoverage, @overallScore, @employerEvidencedShare, @insufficientJdSignal,
         @dimensionScores, @requirementBreakdown, @recommendedTrack, @decision, @blockingReasons)`
    ).run(params);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const raceWinner = getJobMatchResult(key);
      if (raceWinner) return raceWinner;
    }
    throw err;
  }

  // Superseding is scoped per candidate — Candidate A's newer result must never mark Candidate B's
  // row for the same dedupe_key as superseded.
  db.prepare(
    `UPDATE job_match_results SET status = 'superseded'
     WHERE candidate_id = @candidateId AND dedupe_key = @dedupeKey
       AND id != (SELECT id FROM job_match_results WHERE candidate_id = @candidateId AND dedupe_key = @dedupeKey ORDER BY id DESC LIMIT 1)
       AND status = 'active'`
  ).run({ candidateId: data.candidateId, dedupeKey: data.dedupeKey });

  return getJobMatchResult(key)!;
}

/** Latest result for one candidate's relationship to one job, by (candidate_id, dedupe_key) — never
 *  by job_id, so this still resolves correctly for a job whose numeric id was reused after deletion
 *  (see the table's IDENTITY SAFETY comment). candidate_id is required, not optional: there is no
 *  "give me anyone's latest result" query anywhere in this codebase, by design. */
export function getLatestJobMatchResult(candidateId: number, dedupeKey: string): JobMatchResultRow | undefined {
  return getDb()
    .prepare("SELECT * FROM job_match_results WHERE candidate_id = ? AND dedupe_key = ? ORDER BY id DESC LIMIT 1")
    .get(candidateId, dedupeKey) as JobMatchResultRow | undefined;
}

/** Full history of one candidate's results for one job, by (candidate_id, dedupe_key) — survives the
 *  underlying job row being deleted entirely. */
export function listJobMatchHistory(candidateId: number, dedupeKey: string): JobMatchResultRow[] {
  return getDb()
    .prepare("SELECT * FROM job_match_results WHERE candidate_id = ? AND dedupe_key = ? ORDER BY id DESC")
    .all(candidateId, dedupeKey) as JobMatchResultRow[];
}

export interface LatestDecisionSummary {
  decision: string;
  overallScore: number;
  /** Added for the For You ranking layer (src/lib/rank/forYou.ts's ForYouMatch) — additive fields,
   *  ignored by pre-existing consumers (MatchDecisionBadge/job-list badge) that only read
   *  decision/overallScore. */
  employerEvidencedShare: number;
  requirementCoverage: number;
  status?: "active" | "superseded";
  matchEngineVersion?: number;
  matchKnowledgeHash?: string;
  candidateProfileHash?: string;
  candidateSettingsHash?: string;
  jdContentHash?: string;
}

/** Batch lookup of one candidate's latest decision per dedupe_key — used by the job-list badge/filter
 *  AND the For You ranking API (a single query for the whole visible page/candidate's job set, never
 *  one query per row). Keyed by (candidate_id, dedupe_key), never job_id, same identity discipline as
 *  every other lookup in this file. Jobs never evaluated for this candidate are simply absent from
 *  the returned map — the caller (For You ranking, MatchDecisionBadge) is responsible for treating
 *  "absent" as NOT_EVALUATED, never as a fabricated score. */
export function listLatestDecisionsForDedupeKeys(candidateId: number, dedupeKeys: string[]): Record<string, LatestDecisionSummary> {
  if (dedupeKeys.length === 0) return {};
  const db = getDb();
  const placeholders = dedupeKeys.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT t.dedupe_key, t.decision, t.overall_score, t.employer_evidenced_share, t.requirement_coverage,
              t.status, t.match_engine_version, t.match_knowledge_hash, t.candidate_profile_hash,
              t.candidate_settings_hash, t.jd_content_hash
       FROM job_match_results t
       INNER JOIN (
         SELECT dedupe_key, MAX(id) AS max_id FROM job_match_results
         WHERE candidate_id = ? AND dedupe_key IN (${placeholders}) GROUP BY dedupe_key
       ) latest ON latest.max_id = t.id`
    )
    .all(candidateId, ...dedupeKeys) as {
    dedupe_key: string;
    decision: string;
    overall_score: number;
    employer_evidenced_share: number;
    requirement_coverage: number;
    status: "active" | "superseded";
    match_engine_version: number;
    match_knowledge_hash: string;
    candidate_profile_hash: string;
    candidate_settings_hash: string;
    jd_content_hash: string;
  }[];

  const result: Record<string, LatestDecisionSummary> = {};
  for (const row of rows) {
    result[row.dedupe_key] = {
      decision: row.decision,
      overallScore: row.overall_score,
      employerEvidencedShare: row.employer_evidenced_share,
      requirementCoverage: row.requirement_coverage,
      status: row.status,
      matchEngineVersion: row.match_engine_version,
      matchKnowledgeHash: row.match_knowledge_hash,
      candidateProfileHash: row.candidate_profile_hash,
      candidateSettingsHash: row.candidate_settings_hash,
      jdContentHash: row.jd_content_hash,
    };
  }
  return result;
}
