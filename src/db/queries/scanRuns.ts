import { getDb } from "@/db";
import type { ErrorCategory, ScanRun, ScanRunStatus, ScanRunWithCompany, SourceType } from "@/types";

export interface RecordScanRunInput {
  companyId: number;
  provider: SourceType;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: ScanRunStatus;
  jobsDiscovered: number;
  jobsAdded: number;
  jobsUpdated: number;
  jobsUnchanged: number;
  duplicatesSkipped: number;
  jobsClosed: number;
  jobsArchived: number;
  /** Always 0 today — see the jobs_deleted column comment in schema.sql. */
  jobsDeleted?: number;
  descriptionFailures: number;
  retryCount: number;
  errorCategory?: ErrorCategory | null;
  errorMessage?: string | null;
}

/**
 * Writes one scan_runs row. Called exactly once per scanCompany() attempt, after it's already
 * finished one way or another (success, partial, or the catch-block failure path) — both
 * timestamps are known at call time, so there's no intermediate "running" row to update later.
 */
export function recordScanRun(input: RecordScanRunInput): number {
  const result = getDb()
    .prepare(
      `INSERT INTO scan_runs (
        company_id, provider, started_at, finished_at, duration_ms, status,
        jobs_discovered, jobs_added, jobs_updated, jobs_unchanged, duplicates_skipped,
        jobs_closed, jobs_archived, jobs_deleted, description_failures, retry_count,
        error_category, error_message
      ) VALUES (
        @companyId, @provider, @startedAt, @finishedAt, @durationMs, @status,
        @jobsDiscovered, @jobsAdded, @jobsUpdated, @jobsUnchanged, @duplicatesSkipped,
        @jobsClosed, @jobsArchived, @jobsDeleted, @descriptionFailures, @retryCount,
        @errorCategory, @errorMessage
      )`
    )
    .run({
      ...input,
      jobsDeleted: input.jobsDeleted ?? 0,
      errorCategory: input.errorCategory ?? null,
      errorMessage: input.errorMessage ?? null,
    });
  return Number(result.lastInsertRowid);
}

const SCAN_RUN_WITH_COMPANY_SELECT = `sr.*, c.name AS company_name`;

export function listScanRunsForCompany(companyId: number, limit = 20): ScanRunWithCompany[] {
  return getDb()
    .prepare(
      `SELECT ${SCAN_RUN_WITH_COMPANY_SELECT}
       FROM scan_runs sr JOIN companies c ON c.id = sr.company_id
       WHERE sr.company_id = ?
       ORDER BY sr.started_at DESC
       LIMIT ?`
    )
    .all(companyId, limit) as ScanRunWithCompany[];
}

export function listRecentScanRuns(limit = 50): ScanRunWithCompany[] {
  return getDb()
    .prepare(
      `SELECT ${SCAN_RUN_WITH_COMPANY_SELECT}
       FROM scan_runs sr JOIN companies c ON c.id = sr.company_id
       ORDER BY sr.started_at DESC
       LIMIT ?`
    )
    .all(limit) as ScanRunWithCompany[];
}

/** Most recent scan_run per company — one row per company that has ever been scanned, newest
 *  attempt only. Used by the Scanner dashboard's per-company summary table. */
export function getLatestScanRunPerCompany(): ScanRunWithCompany[] {
  return getDb()
    .prepare(
      `SELECT ${SCAN_RUN_WITH_COMPANY_SELECT}
       FROM scan_runs sr
       JOIN companies c ON c.id = sr.company_id
       WHERE sr.id IN (SELECT MAX(id) FROM scan_runs GROUP BY company_id)
       ORDER BY c.name COLLATE NOCASE`
    )
    .all() as ScanRunWithCompany[];
}

export function getScanRun(id: number): ScanRun | undefined {
  return getDb().prepare("SELECT * FROM scan_runs WHERE id = ?").get(id) as ScanRun | undefined;
}
