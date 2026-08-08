import type Database from "better-sqlite3";
import { getDb } from "@/db";
import { ARCHIVE_AFTER_MISSED_SCANS, canArchive } from "@/lib/jobLifecycle";
import type {
  H1bCombinedSignal,
  Job,
  JobHistoryChangeType,
  JobStatusHistoryEntry,
  JobWithCompany,
  NormalizedJob,
  PipelineStatus,
  SourceType,
  SponsorshipPolarity,
} from "@/types";

export interface JobFilters {
  status?: PipelineStatus;
  h1bSignal?: H1bCombinedSignal[];
  companyId?: number;
  sourceType?: SourceType;
  search?: string;
  activeOnly?: boolean;
  markedForTailoring?: boolean;
  /** true = only archived jobs. Omitted/false = the default jobs view, which excludes archived
   *  jobs entirely so "Show Archived Jobs separately" holds without every existing caller having
   *  to opt in. */
  archived?: boolean;
}

/** Appends one row to job_status_history. Internal — all lifecycle/pipeline mutations in this file
 *  route through here so the audit trail can't drift from what actually changed. */
function recordHistory(
  db: Database.Database,
  jobId: number,
  changeType: JobHistoryChangeType,
  oldValue: string | null,
  newValue: string | null,
  reason?: string | null
): void {
  db.prepare(
    `INSERT INTO job_status_history (job_id, change_type, old_value, new_value, reason)
     VALUES (@jobId, @changeType, @oldValue, @newValue, @reason)`
  ).run({ jobId, changeType, oldValue, newValue, reason: reason ?? null });
}

export function listJobs(filters: JobFilters = {}): JobWithCompany[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.status) {
    clauses.push("j.pipeline_status = @status");
    params.status = filters.status;
  }
  if (filters.companyId) {
    clauses.push("j.company_id = @companyId");
    params.companyId = filters.companyId;
  }
  if (filters.sourceType) {
    clauses.push("j.source_type = @sourceType");
    params.sourceType = filters.sourceType;
  }
  if (filters.activeOnly) {
    clauses.push("j.is_active = 1");
  }
  if (filters.markedForTailoring) {
    clauses.push("j.marked_for_tailoring = 1");
  }
  if (filters.search) {
    clauses.push("(j.title LIKE @search OR j.description_text LIKE @search OR c.name LIKE @search)");
    params.search = `%${filters.search}%`;
  }
  if (filters.h1bSignal && filters.h1bSignal.length > 0) {
    const placeholders = filters.h1bSignal.map((_, i) => `@h1b${i}`).join(", ");
    clauses.push(`j.h1b_combined_signal IN (${placeholders})`);
    filters.h1bSignal.forEach((sig, i) => {
      params[`h1b${i}`] = sig;
    });
  }
  // Archived jobs are excluded from every normal listing by default — the Archived Jobs page is
  // the only caller that passes archived: true to see them.
  clauses.push(filters.archived ? "j.is_archived = 1" : "j.is_archived = 0");

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `
    SELECT j.*, c.name AS company_name
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
    ${where}
    ORDER BY j.posted_at DESC, j.first_seen_at DESC
  `;
  return getDb().prepare(sql).all(params) as JobWithCompany[];
}

export function getJob(id: number): JobWithCompany | undefined {
  return getDb()
    .prepare(
      `SELECT j.*, c.name AS company_name FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?`
    )
    .get(id) as JobWithCompany | undefined;
}

export function updateJobPipeline(
  id: number,
  updates: {
    pipelineStatus?: PipelineStatus;
    markedForTailoring?: boolean;
    notes?: string | null;
    /** Plain string array; stored JSON-encoded. Omit the field entirely to leave tags untouched. */
    tags?: string[];
  }
): Job | undefined {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
  if (!existing) return undefined;

  const pipelineStatus = updates.pipelineStatus ?? existing.pipeline_status;
  const markedForTailoring =
    updates.markedForTailoring === undefined
      ? existing.marked_for_tailoring
      : updates.markedForTailoring
      ? 1
      : 0;
  const notes = updates.notes === undefined ? existing.notes : updates.notes;
  const tags = updates.tags === undefined ? existing.tags : JSON.stringify(updates.tags);

  db.prepare(
    `UPDATE jobs SET
      pipeline_status = @pipelineStatus,
      pipeline_updated_at = CASE WHEN @pipelineStatus != @oldStatus THEN datetime('now') ELSE pipeline_updated_at END,
      marked_for_tailoring = @markedForTailoring,
      tailoring_marked_at = CASE WHEN @markedForTailoring = 1 AND @oldMarked = 0 THEN datetime('now') ELSE tailoring_marked_at END,
      notes = @notes,
      tags = @tags,
      updated_at = datetime('now')
     WHERE id = @id`
  ).run({
    id,
    pipelineStatus,
    oldStatus: existing.pipeline_status,
    markedForTailoring,
    oldMarked: existing.marked_for_tailoring,
    notes,
    tags,
  });

  if (pipelineStatus !== existing.pipeline_status) {
    recordHistory(db, id, "pipeline_status", existing.pipeline_status, pipelineStatus);
  }

  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job;
}

export function countJobsByStatus(): Record<PipelineStatus, number> {
  const rows = getDb()
    .prepare("SELECT pipeline_status, COUNT(*) as count FROM jobs WHERE is_active = 1 GROUP BY pipeline_status")
    .all() as { pipeline_status: PipelineStatus; count: number }[];
  const base: Record<PipelineStatus, number> = {
    New: 0,
    Interested: 0,
    Applied: 0,
    Interview: 0,
    Rejected: 0,
    Offer: 0,
  };
  for (const row of rows) base[row.pipeline_status] = row.count;
  return base;
}

/**
 * Upserts a normalized job by dedupe_key. Preserves pipeline_status/marked_for_tailoring/notes/tags
 * on update (a rescan must never reset a job the user has already triaged) — this is also how
 * "refresh existing jobs instead of creating duplicates" holds: the dedupe_key unique index means
 * a job that reappears in a scan always resolves to the same row, never a new one.
 *
 * A job found in a scan is, by definition, live right now — so this always clears any prior
 * closed/archived state (and logs why in job_status_history) rather than requiring the caller to
 * reason about it. closeStaleJobs (called separately, after all of a company's upsertJob calls)
 * is the only place that *sets* closed/archived state, for jobs that were NOT seen this scan.
 */
export function upsertJob(params: {
  companyId: number;
  sourceType: SourceType;
  dedupeKey: string;
  job: NormalizedJob;
  descriptionSections: string | null;
  sponsorshipMentioned: boolean;
  sponsorshipPolarity: SponsorshipPolarity;
  sponsorshipSnippet: string | null;
  h1bCombinedSignal: H1bCombinedSignal;
}): "inserted" | "updated" {
  const db = getDb();
  const existing = db
    .prepare("SELECT id, is_active, is_archived FROM jobs WHERE dedupe_key = ?")
    .get(params.dedupeKey) as { id: number; is_active: 0 | 1; is_archived: 0 | 1 } | undefined;

  const row = {
    companyId: params.companyId,
    sourceType: params.sourceType,
    externalId: params.job.externalId,
    title: params.job.title,
    location: params.job.location,
    department: params.job.department,
    url: params.job.url,
    descriptionHtml: params.job.descriptionHtml,
    descriptionText: params.job.descriptionText,
    descriptionSections: params.descriptionSections,
    employmentType: params.job.employmentType,
    workplaceType: params.job.workplaceType,
    salaryText: params.job.salaryText,
    postedAt: params.job.postedAt,
    dedupeKey: params.dedupeKey,
    sponsorshipMentioned: params.sponsorshipMentioned ? 1 : 0,
    sponsorshipPolarity: params.sponsorshipPolarity,
    sponsorshipSnippet: params.sponsorshipSnippet,
    h1bCombinedSignal: params.h1bCombinedSignal,
    rawJson: JSON.stringify(params.job.raw ?? null),
  };

  if (existing) {
    db.prepare(
      `UPDATE jobs SET
        title = @title,
        location = @location,
        department = @department,
        url = @url,
        description_html = @descriptionHtml,
        description_text = @descriptionText,
        description_sections = @descriptionSections,
        employment_type = @employmentType,
        workplace_type = @workplaceType,
        salary_text = @salaryText,
        posted_at = @postedAt,
        last_seen_at = datetime('now'),
        is_active = 1,
        closed_at = NULL,
        missed_scan_count = 0,
        is_archived = 0,
        archived_at = NULL,
        archived_reason = NULL,
        sponsorship_mentioned = @sponsorshipMentioned,
        sponsorship_polarity = @sponsorshipPolarity,
        sponsorship_snippet = @sponsorshipSnippet,
        h1b_combined_signal = @h1bCombinedSignal,
        raw_json = @rawJson,
        updated_at = datetime('now')
       WHERE id = @id`
    ).run({ ...row, id: existing.id });

    if (existing.is_archived === 1) {
      recordHistory(db, existing.id, "lifecycle", "Archived", "Active", "Auto-restored: reappeared in scan");
    } else if (existing.is_active === 0) {
      recordHistory(db, existing.id, "lifecycle", "Closed", "Active", "Reappeared in scan");
    }
    return "updated";
  }

  db.prepare(
    `INSERT INTO jobs (
      company_id, source_type, external_id, title, location, department, url,
      description_html, description_text, description_sections,
      employment_type, workplace_type, salary_text, posted_at, dedupe_key,
      sponsorship_mentioned, sponsorship_polarity, sponsorship_snippet, h1b_combined_signal, raw_json
    ) VALUES (
      @companyId, @sourceType, @externalId, @title, @location, @department, @url,
      @descriptionHtml, @descriptionText, @descriptionSections,
      @employmentType, @workplaceType, @salaryText, @postedAt, @dedupeKey,
      @sponsorshipMentioned, @sponsorshipPolarity, @sponsorshipSnippet, @h1bCombinedSignal, @rawJson
    )`
  ).run(row);
  return "inserted";
}

export interface CloseStaleJobsResult {
  jobsClosed: number;
  jobsArchived: number;
}

/**
 * Job Lifecycle Management: for a company's jobs not present in the latest scan (seenDedupeKeys),
 * closes them (is_active=0) the first time they go missing, and archives them once they've been
 * missing for ARCHIVE_AFTER_MISSED_SCANS consecutive scans in a row — unless canArchive() blocks it
 * because the job is marked Applied or Interview, in which case it stays closed-but-not-archived
 * indefinitely (missed_scan_count keeps incrementing, so if the pipeline status later moves off
 * Applied/Interview, the very next scan miss archives it immediately using the count already
 * accumulated, rather than waiting through another full X-scan window).
 *
 * Already-archived jobs are excluded from consideration here — they're a terminal state until
 * restoreJob() (or reappearing in a scan, handled by upsertJob) brings them back.
 */
export function closeStaleJobs(companyId: number, seenDedupeKeys: string[]): CloseStaleJobsResult {
  const db = getDb();
  const seen = new Set(seenDedupeKeys);

  const candidates = db
    .prepare(
      `SELECT id, dedupe_key, is_active, missed_scan_count, pipeline_status
       FROM jobs WHERE company_id = ? AND is_archived = 0`
    )
    .all(companyId) as {
    id: number;
    dedupe_key: string;
    is_active: 0 | 1;
    missed_scan_count: number;
    pipeline_status: PipelineStatus;
  }[];

  const missing = candidates.filter((job) => !seen.has(job.dedupe_key));
  if (missing.length === 0) return { jobsClosed: 0, jobsArchived: 0 };

  const closeStmt = db.prepare(
    `UPDATE jobs SET is_active = 0, closed_at = datetime('now'), missed_scan_count = @missedCount, updated_at = datetime('now')
     WHERE id = @id`
  );
  const bumpMissedStmt = db.prepare(
    `UPDATE jobs SET missed_scan_count = @missedCount, updated_at = datetime('now') WHERE id = @id`
  );
  const archiveStmt = db.prepare(
    `UPDATE jobs SET is_archived = 1, archived_at = datetime('now'), archived_reason = @reason, updated_at = datetime('now')
     WHERE id = @id`
  );

  let jobsClosed = 0;
  let jobsArchived = 0;

  const process = db.transaction(() => {
    for (const job of missing) {
      const missedCount = job.missed_scan_count + 1;

      if (job.is_active === 1) {
        closeStmt.run({ id: job.id, missedCount });
        recordHistory(db, job.id, "lifecycle", "Active", "Closed", "Not found in latest scan");
        jobsClosed++;
      } else {
        bumpMissedStmt.run({ id: job.id, missedCount });
      }

      if (missedCount >= ARCHIVE_AFTER_MISSED_SCANS && canArchive(job.pipeline_status)) {
        const reason = `Not seen for ${missedCount} consecutive scans`;
        archiveStmt.run({ id: job.id, reason });
        recordHistory(db, job.id, "lifecycle", "Closed", "Archived", reason);
        jobsArchived++;
      }
    }
  });
  process();

  return { jobsClosed, jobsArchived };
}

/**
 * Manually archives a job. Refuses (canArchive() = false) while pipeline_status is Applied or
 * Interview — this is the same guardrail closeStaleJobs enforces for automatic archiving, so the
 * "never archive Applied/Interview" rule holds for both paths. A no-op (not an error) if the job
 * is already archived.
 */
export function archiveJob(
  id: number,
  reason?: string
): { ok: true; job: Job } | { ok: false; blockedReason: string } {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
  if (!existing) return { ok: false, blockedReason: "Job not found" };
  if (existing.is_archived === 1) return { ok: true, job: existing };
  if (!canArchive(existing.pipeline_status)) {
    return {
      ok: false,
      blockedReason: `Cannot archive a job marked "${existing.pipeline_status}" — change its pipeline status first.`,
    };
  }

  const finalReason = reason?.trim() || "Manually archived";
  db.prepare(
    `UPDATE jobs SET is_archived = 1, archived_at = datetime('now'), archived_reason = @reason, updated_at = datetime('now')
     WHERE id = @id`
  ).run({ id, reason: finalReason });
  recordHistory(db, id, "lifecycle", existing.is_active === 1 ? "Active" : "Closed", "Archived", finalReason);

  return { ok: true, job: db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job };
}

/**
 * Restores an archived job to the active jobs view. Also clears is_active/closed_at back to "live"
 * and resets missed_scan_count to 0 — a restored job gets a fresh grace period before the next scan
 * could re-close/re-archive it, rather than being one miss away from immediately re-archiving.
 */
export function restoreJob(id: number): Job | undefined {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
  if (!existing) return undefined;

  db.prepare(
    `UPDATE jobs SET
      is_archived = 0, archived_at = NULL, archived_reason = NULL,
      is_active = 1, closed_at = NULL, missed_scan_count = 0,
      updated_at = datetime('now')
     WHERE id = @id`
  ).run({ id });
  recordHistory(db, id, "lifecycle", "Archived", "Active", "Manually restored");

  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job;
}

export function getJobHistory(jobId: number): JobStatusHistoryEntry[] {
  return getDb()
    .prepare("SELECT * FROM job_status_history WHERE job_id = ? ORDER BY changed_at DESC")
    .all(jobId) as JobStatusHistoryEntry[];
}
