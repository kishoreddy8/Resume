import { getDb } from "@/db";

/** Batch-evaluation observability — mirrors src/db/queries/scanRuns.ts's shape/reasoning exactly:
 *  written once, after the batch finishes one way or another (no intermediate "running" row). */

export interface MatchRun {
  id: number;
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
        (started_at, finished_at, jobs_evaluated, jobs_blocked, jobs_needs_review, jobs_ready, jobs_errored, error_summary)
       VALUES (@startedAt, @finishedAt, @jobsEvaluated, @jobsBlocked, @jobsNeedsReview, @jobsReady, @jobsErrored, @errorSummary)`
    )
    .run({ ...input, errorSummary: input.errorSummary ?? null });
  return db.prepare("SELECT * FROM match_runs WHERE id = ?").get(result.lastInsertRowid) as MatchRun;
}

export function listMatchRuns(limit = 50): MatchRun[] {
  return getDb().prepare("SELECT * FROM match_runs ORDER BY started_at DESC LIMIT ?").all(limit) as MatchRun[];
}
