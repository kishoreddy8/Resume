import { getDb } from "@/db";

/** Batch-evaluation observability — mirrors src/db/queries/scanRuns.ts's shape/reasoning exactly:
 *  written once, after the batch finishes one way or another (no intermediate "running" row). */

export interface MatchRun {
  id: number;
  candidate_id: number;
  started_at: string;
  finished_at: string;
  jobs_evaluated: number;
  jobs_blocked: number;
  jobs_needs_review: number;
  jobs_ready: number;
  jobs_errored: number;
  error_summary: string | null;
}

export interface InsertMatchRunInput {
  candidateId: number;
  startedAt: string;
  finishedAt: string;
  jobsEvaluated: number;
  jobsBlocked: number;
  jobsNeedsReview: number;
  jobsReady: number;
  jobsErrored: number;
  errorSummary?: string | null;
}

export function insertMatchRun(input: InsertMatchRunInput): MatchRun {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO match_runs
        (candidate_id, started_at, finished_at, jobs_evaluated, jobs_blocked, jobs_needs_review, jobs_ready, jobs_errored, error_summary)
       VALUES (@candidateId, @startedAt, @finishedAt, @jobsEvaluated, @jobsBlocked, @jobsNeedsReview, @jobsReady, @jobsErrored, @errorSummary)`
    )
    .run({ ...input, errorSummary: input.errorSummary ?? null });
  return db.prepare("SELECT * FROM match_runs WHERE id = ?").get(result.lastInsertRowid) as MatchRun;
}

/** Defaults to Candidate #1 for backward compatibility with the pre-Phase-2.5 observability UI
 *  (src/app/pipeline or similar) — pass an explicit candidateId once a per-candidate runs view exists. */
export function listMatchRuns(candidateId?: number, limit = 50): MatchRun[] {
  const db = getDb();
  if (candidateId !== undefined) {
    return db.prepare("SELECT * FROM match_runs WHERE candidate_id = ? ORDER BY started_at DESC LIMIT ?").all(candidateId, limit) as MatchRun[];
  }
  return db.prepare("SELECT * FROM match_runs ORDER BY started_at DESC LIMIT ?").all(limit) as MatchRun[];
}
