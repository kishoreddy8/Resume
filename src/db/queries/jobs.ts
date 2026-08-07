import { getDb } from "@/db";
import type {
  H1bCombinedSignal,
  Job,
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
  updates: { pipelineStatus?: PipelineStatus; markedForTailoring?: boolean }
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

  db.prepare(
    `UPDATE jobs SET
      pipeline_status = @pipelineStatus,
      pipeline_updated_at = CASE WHEN @pipelineStatus != @oldStatus THEN datetime('now') ELSE pipeline_updated_at END,
      marked_for_tailoring = @markedForTailoring,
      tailoring_marked_at = CASE WHEN @markedForTailoring = 1 AND @oldMarked = 0 THEN datetime('now') ELSE tailoring_marked_at END,
      updated_at = datetime('now')
     WHERE id = @id`
  ).run({
    id,
    pipelineStatus,
    oldStatus: existing.pipeline_status,
    markedForTailoring,
    oldMarked: existing.marked_for_tailoring,
  });

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
 * Upserts a normalized job by dedupe_key. Preserves pipeline_status/marked_for_tailoring
 * on update (a rescan must never reset a job the user has already triaged).
 */
export function upsertJob(params: {
  companyId: number;
  sourceType: SourceType;
  dedupeKey: string;
  job: NormalizedJob;
  sponsorshipMentioned: boolean;
  sponsorshipPolarity: SponsorshipPolarity;
  h1bCombinedSignal: H1bCombinedSignal;
}): "inserted" | "updated" {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM jobs WHERE dedupe_key = ?")
    .get(params.dedupeKey) as { id: number } | undefined;

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
    postedAt: params.job.postedAt,
    dedupeKey: params.dedupeKey,
    sponsorshipMentioned: params.sponsorshipMentioned ? 1 : 0,
    sponsorshipPolarity: params.sponsorshipPolarity,
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
        posted_at = @postedAt,
        last_seen_at = datetime('now'),
        is_active = 1,
        sponsorship_mentioned = @sponsorshipMentioned,
        sponsorship_polarity = @sponsorshipPolarity,
        h1b_combined_signal = @h1bCombinedSignal,
        raw_json = @rawJson,
        updated_at = datetime('now')
       WHERE id = @id`
    ).run({ ...row, id: existing.id });
    return "updated";
  }

  db.prepare(
    `INSERT INTO jobs (
      company_id, source_type, external_id, title, location, department, url,
      description_html, description_text, posted_at, dedupe_key,
      sponsorship_mentioned, sponsorship_polarity, h1b_combined_signal, raw_json
    ) VALUES (
      @companyId, @sourceType, @externalId, @title, @location, @department, @url,
      @descriptionHtml, @descriptionText, @postedAt, @dedupeKey,
      @sponsorshipMentioned, @sponsorshipPolarity, @h1bCombinedSignal, @rawJson
    )`
  ).run(row);
  return "inserted";
}

/** Marks ATS-sourced jobs for a company not present in the latest scan as closed. */
export function closeStaleJobs(companyId: number, seenDedupeKeys: string[]): number {
  const db = getDb();
  if (seenDedupeKeys.length === 0) {
    const result = db
      .prepare("UPDATE jobs SET is_active = 0, updated_at = datetime('now') WHERE company_id = ? AND is_active = 1")
      .run(companyId);
    return result.changes;
  }
  const placeholders = seenDedupeKeys.map((_, i) => `@k${i}`).join(", ");
  const params: Record<string, unknown> = { companyId };
  seenDedupeKeys.forEach((k, i) => (params[`k${i}`] = k));
  const result = db
    .prepare(
      `UPDATE jobs SET is_active = 0, updated_at = datetime('now')
       WHERE company_id = @companyId AND is_active = 1 AND dedupe_key NOT IN (${placeholders})`
    )
    .run(params);
  return result.changes;
}
