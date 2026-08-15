import type Database from "better-sqlite3";
import { getDb } from "@/db";
import { isProtectedForAnyCandidate } from "@/db/queries/candidateJobState";
import { getAppSettings } from "@/db/queries/settings";
import { getJobAgeBand, getJobAgeDays, PROTECTED_PIPELINE_STATUSES } from "@/lib/jobLifecycle";
import { isSuppressionActive } from "@/lib/settings";
import type {
  AgeSweepResult,
  DeletedJobRef,
  EmploymentTypeNormalized,
  H1bJobConfidence,
  Job,
  JobHistoryChangeType,
  JobStatusHistoryEntry,
  JobWithCompany,
  NormalizedJob,
  PipelineStatus,
  Seniority,
  SourceType,
  SponsorshipPolarity,
  WorkplaceTypeNormalized,
} from "@/types";

export interface JobFilters {
  status?: PipelineStatus;
  h1bConfidence?: H1bJobConfidence[];
  companyId?: number;
  sourceType?: SourceType;
  search?: string;
  activeOnly?: boolean;
  markedForTailoring?: boolean;
  /** true = only archived jobs. Omitted/false = the default jobs view, which excludes archived
   *  jobs entirely so "Show Archived Jobs separately" holds without every existing caller having
   *  to opt in. */
  archived?: boolean;
  // --- Structured Job Intelligence filters (additive; see src/lib/jobIntel/) -------------------
  workplaceType?: WorkplaceTypeNormalized;
  employmentType?: EmploymentTypeNormalized;
  seniority?: Seniority;
  /** true = only jobs with a parsed salary_min/salary_max. */
  salaryAvailable?: boolean;
  /** true = only jobs where clearance_required = 'Required'. */
  clearanceRequired?: boolean;
  /**
   * Phase 2.5: when provided, `status`/`markedForTailoring` filter against — and
   * pipeline_status/pinned/notes/tags/marked_for_tailoring on each returned row reflect — THIS
   * candidate's candidate_job_state via a LEFT JOIN, instead of the frozen legacy jobs.* columns.
   * Omitted = byte-identical legacy behavior (every existing caller that doesn't pass this gets the
   * exact same query/results as before Phase 2.5 — this parameter changes nothing unless supplied).
   * A job with no candidate_job_state row overlays the same defaults candidateJobState.ts uses
   * (pipeline_status='New', pinned=0, marked_for_tailoring=0, notes/tags=null).
   */
  candidateId?: number;
}

/** Shared by listJobs/getJob: builds the LEFT JOIN + per-field COALESCE expressions that overlay
 *  candidate_job_state onto a job row, only when candidateId is provided. Returns empty/legacy
 *  expressions (no JOIN, read straight from j.*) when it's not — see JobFilters.candidateId's doc
 *  comment for why that keeps every pre-Phase-2.5 caller byte-identical. */
function candidateOverlay(candidateId: number | undefined) {
  if (!candidateId) {
    return { join: "", selectOverride: "", params: {} as Record<string, unknown> };
  }
  return {
    join: "LEFT JOIN candidate_job_state cjs ON cjs.candidate_id = @overlayCandidateId AND cjs.dedupe_key = j.dedupe_key",
    // Appended after j.* in the SELECT list — SQLite/better-sqlite3 builds each result object by
    // assigning columns in order, so a later column with the same name overwrites the earlier one,
    // which is exactly how this overrides j.pipeline_status/j.pinned/etc. without excluding them.
    // not_interested has no legacy jobs.* counterpart (Phase 2.5-only) — genuinely absent from the
    // row when candidateId isn't supplied, see JobWithCompany.not_interested's optional type.
    selectOverride: `,
      COALESCE(cjs.pipeline_status, 'New') AS pipeline_status,
      COALESCE(cjs.pinned, 0) AS pinned,
      COALESCE(cjs.marked_for_tailoring, 0) AS marked_for_tailoring,
      cjs.tailoring_marked_at AS tailoring_marked_at,
      cjs.notes AS notes,
      cjs.tags AS tags,
      COALESCE(cjs.not_interested, 0) AS not_interested`,
    params: { overlayCandidateId: candidateId },
  };
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

// Shared by listJobs/getJob — brings each job's own h1b_combined_confidence together with its
// company's historical H1B confidence ("Historical Sponsor" on the job detail page), so callers
// never need a second round-trip to show both.
const JOB_WITH_COMPANY_SELECT = `
  j.*, c.name AS company_name,
  c.h1b_confidence AS company_h1b_confidence,
  c.h1b_confidence_evidence AS company_h1b_confidence_evidence,
  c.h1b_match_employer_name AS company_h1b_match_employer_name,
  c.h1b_match_tier AS company_h1b_match_tier,
  c.h1b_lca_count AS company_h1b_lca_count,
  c.h1b_latest_fiscal_year AS company_h1b_latest_fiscal_year
`;

export function listJobs(filters: JobFilters = {}): JobWithCompany[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  const overlay = candidateOverlay(filters.candidateId);
  Object.assign(params, overlay.params);
  const pipelineStatusExpr = filters.candidateId ? "COALESCE(cjs.pipeline_status, 'New')" : "j.pipeline_status";
  const markedForTailoringExpr = filters.candidateId ? "COALESCE(cjs.marked_for_tailoring, 0)" : "j.marked_for_tailoring";

  if (filters.status) {
    clauses.push(`${pipelineStatusExpr} = @status`);
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
    clauses.push(`${markedForTailoringExpr} = 1`);
  }
  if (filters.search) {
    clauses.push("(j.title LIKE @search OR j.description_text LIKE @search OR c.name LIKE @search)");
    params.search = `%${filters.search}%`;
  }
  if (filters.h1bConfidence && filters.h1bConfidence.length > 0) {
    const placeholders = filters.h1bConfidence.map((_, i) => `@h1b${i}`).join(", ");
    clauses.push(`j.h1b_combined_confidence IN (${placeholders})`);
    filters.h1bConfidence.forEach((sig, i) => {
      params[`h1b${i}`] = sig;
    });
  }
  if (filters.workplaceType) {
    clauses.push("j.workplace_type_normalized = @workplaceType");
    params.workplaceType = filters.workplaceType;
  }
  if (filters.employmentType) {
    clauses.push("j.employment_type_normalized = @employmentType");
    params.employmentType = filters.employmentType;
  }
  if (filters.seniority) {
    clauses.push("j.seniority = @seniority");
    params.seniority = filters.seniority;
  }
  if (filters.salaryAvailable) {
    clauses.push("(j.salary_min IS NOT NULL OR j.salary_max IS NOT NULL)");
  }
  if (filters.clearanceRequired) {
    clauses.push("j.clearance_required = 'Required'");
  }
  // Archived jobs are excluded from every normal listing by default — the Archived Jobs page is
  // the only caller that passes archived: true to see them.
  clauses.push(filters.archived ? "j.is_archived = 1" : "j.is_archived = 0");

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `
    SELECT ${JOB_WITH_COMPANY_SELECT}${overlay.selectOverride}
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
    ${overlay.join}
    ${where}
    ORDER BY j.posted_at DESC, j.first_seen_at DESC
  `;
  return getDb().prepare(sql).all(params) as JobWithCompany[];
}

export interface CandidateRematchJobPageOptions {
  candidateId: number;
  /** Keyset cursor: only jobs with a STRICTLY greater id are returned. 0/omitted starts at the
   *  beginning. Deliberately NOT an OFFSET — a rematch page runs while normal ingestion/lifecycle
   *  activity continues, and OFFSET pagination silently skips or repeats rows when the underlying
   *  set shifts underneath it, whereas a jobs.id cursor is stable regardless. */
  afterJobId?: number;
  limit: number;
  /** Actionability window in days, applied to the SAME age source src/lib/jobLifecycle.ts's
   *  getJobAgeSource uses (reliable posted_at, else first_seen_at). Passed in by the caller rather
   *  than hardcoded here — see src/lib/match/rematchCandidate.ts, which supplies the existing For
   *  You feed window. */
  maxAgeDays: number;
  now?: Date;
}

/**
 * Phase 4 Stage 5 — ONE bounded, indexed page of the jobs a candidate rematch should reconsider.
 *
 * The eligibility rule is not new: it is exactly what the For You feed already treats as this
 * candidate's actionable set (src/app/api/candidates/[candidateId]/for-you/route.ts) —
 *   - is_active = 1 and is_archived = 0 (listJobs' own activeOnly + default non-archived clauses)
 *   - not marked not-interested by THIS candidate (the feed's eligibleItems gate)
 *   - within the freshness window, UNLESS lifecycle-protected for this candidate, which is
 *     isLifecycleProtected()'s exact definition — PROTECTED_PIPELINE_STATUSES or pinned — reusing
 *     the constant itself rather than restating the status list.
 *
 * The filtering happens in SQL, not in JS: the whole point of Stage 5's paging is that a rematch
 * never materializes the ~19.6k-row active job set to slice it down to 100. LIMIT applies to the
 * already-filtered, id-ordered set, so `limit` rows out means `limit` rows read.
 */
export function listCandidateRematchJobPage(options: CandidateRematchJobPageOptions): JobWithCompany[] {
  const overlay = candidateOverlay(options.candidateId);
  const protectedStatusPlaceholders = PROTECTED_PIPELINE_STATUSES.map((_, i) => `@protectedStatus${i}`).join(", ");
  const params: Record<string, unknown> = {
    ...overlay.params,
    afterJobId: options.afterJobId ?? 0,
    limit: options.limit,
    // floor(ageDays) <= maxAgeDays is the JS form (getJobAgeDays floors); the exclusive raw-day
    // bound below is its exact equivalent, so SQL and the feed agree on every boundary day.
    maxAgeDaysExclusive: options.maxAgeDays + 1,
    now: (options.now ?? new Date()).toISOString(),
  };
  PROTECTED_PIPELINE_STATUSES.forEach((status, i) => {
    params[`protectedStatus${i}`] = status;
  });

  // NULLIF(j.posted_at, '') mirrors getJobAgeSource's falsy check on posted_at; the julianday
  // comparison mirrors its "not in the future" test; an unparseable posted_at makes julianday NULL,
  // so the CASE falls through to first_seen_at exactly as the JS NaN branch does.
  const ageSource = `COALESCE(CASE WHEN julianday(NULLIF(j.posted_at, '')) <= julianday(@now) THEN j.posted_at END, j.first_seen_at)`;

  const sql = `
    SELECT ${JOB_WITH_COMPANY_SELECT}${overlay.selectOverride}
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
    ${overlay.join}
    WHERE j.id > @afterJobId
      AND j.is_active = 1
      AND j.is_archived = 0
      AND COALESCE(cjs.not_interested, 0) = 0
      AND (
        julianday(@now) - julianday(${ageSource}) < @maxAgeDaysExclusive
        OR COALESCE(cjs.pinned, 0) = 1
        OR COALESCE(cjs.pipeline_status, 'New') IN (${protectedStatusPlaceholders})
      )
    ORDER BY j.id ASC
    LIMIT @limit
  `;
  return getDb().prepare(sql).all(params) as JobWithCompany[];
}

/** candidateId is optional — see JobFilters.candidateId's doc comment on listJobs above; omitted
 *  keeps this byte-identical to pre-Phase-2.5 behavior for every existing caller. */
export function getJob(id: number, candidateId?: number): JobWithCompany | undefined {
  const overlay = candidateOverlay(candidateId);
  return getDb()
    .prepare(
      `SELECT ${JOB_WITH_COMPANY_SELECT}${overlay.selectOverride} FROM jobs j JOIN companies c ON c.id = j.company_id ${overlay.join} WHERE j.id = @id`
    )
    .get({ id, ...overlay.params }) as JobWithCompany | undefined;
}

/** Looks up a job's id by its dedupe_key — upsertJob() only returns the outcome ("inserted" etc.),
 *  not the row id, so callers that need to act on the row right after upserting it (e.g. Structured
 *  Job Intelligence writing extraction results in src/lib/scan.ts) use this rather than re-deriving
 *  the id another way. Read-only, does not participate in upsertJob's own logic. */
export function getJobIdByDedupeKey(dedupeKey: string): number | undefined {
  const row = getDb().prepare("SELECT id FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as { id: number } | undefined;
  return row?.id;
}

/** Full row lookup by dedupe_key — read-only, does not participate in upsertJob's own logic. Used
 *  by src/lib/scan.ts to snapshot a job's content fields immediately before calling upsertJob, so
 *  it can diff before/after and report "unchanged" vs. "updated" for scan_runs metrics without
 *  upsertJob itself needing to expose that distinction (see the Scanner Reliability & Observability
 *  design note: upsertJob's "inserted"|"updated"|"suppressed" return contract is asserted verbatim
 *  by existing dedupe/lifecycle tests and is intentionally left untouched). */
export function getJobByDedupeKey(dedupeKey: string): Job | undefined {
  return getDb().prepare("SELECT * FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as Job | undefined;
}

/** Provider identities already stored for a company. U.S.-scoped connectors use these to carry
 * excluded postings as lifecycle-only sightings, so introducing/changing a location filter cannot
 * masquerade as a provider-side closure. */
export function getExistingJobExternalIds(companyId: number): Set<string> {
  const rows = getDb()
    .prepare("SELECT external_id FROM jobs WHERE company_id = ? AND external_id IS NOT NULL")
    .all(companyId) as { external_id: string }[];
  return new Set(rows.map((row) => row.external_id));
}

export function getExistingJobRawListings(companyId: number): { externalId: string; listing: unknown }[] {
  const rows = getDb()
    .prepare("SELECT external_id, raw_json FROM jobs WHERE company_id = ? AND external_id IS NOT NULL")
    .all(companyId) as { external_id: string; raw_json: string | null }[];
  const result: { externalId: string; listing: unknown }[] = [];
  for (const row of rows) {
    if (!row.raw_json) continue;
    try {
      const raw = JSON.parse(row.raw_json) as { listing?: unknown } | null;
      if (raw?.listing) result.push({ externalId: row.external_id, listing: raw.listing });
    } catch {
      // Old/corrupt raw provider payloads simply force a detail refresh on the next scan.
    }
  }
  return result;
}

/** Refreshes lifecycle state for a posting the provider still exposes without overwriting its
 * stored content. Used for unchanged/out-of-scope sightings. */
export function touchJobSighting(dedupeKey: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE jobs SET
         last_seen_at = datetime('now'), is_active = 1, closed_at = NULL,
         missed_scan_count = 0, updated_at = datetime('now')
       WHERE dedupe_key = ?`
    )
    .run(dedupeKey);
  return result.changes > 0;
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
    Interviewing: 0,
    Offer: 0,
    "Employer Rejected": 0,
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
  h1bCombinedConfidence: H1bJobConfidence;
}): "inserted" | "updated" | "suppressed" {
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
    h1bCombinedConfidence: params.h1bCombinedConfidence,
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
        h1b_combined_confidence = @h1bCombinedConfidence,
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

  // Deduplication: a job whose exact identity (dedupe_key — ATS provider + external job ID for
  // ATS-sourced postings, a title+URL hash for career-link scrapes; see src/lib/dedupe.ts) was
  // previously deleted must not silently reappear as "new" on a later scan. Two different policies,
  // both enforced by isSuppressionActive (src/lib/settings.ts): an explicit "Not Interested"
  // rejection is suppressed PERMANENTLY, with no expiry; a system-generated aged-out fingerprint
  // expires after the configured Settings > Suppression retention window. A genuinely different
  // requisition — a different external ID, hence a different dedupe_key — is unaffected and is
  // inserted normally.
  const suppressedRow = db
    .prepare("SELECT reason, suppressed_at FROM suppressed_jobs WHERE dedupe_key = ?")
    .get(params.dedupeKey) as { reason: string; suppressed_at: string } | undefined;
  if (suppressedRow && isSuppressionActive(suppressedRow, getAppSettings().suppression)) return "suppressed";

  db.prepare(
    `INSERT INTO jobs (
      company_id, source_type, external_id, title, location, department, url,
      description_html, description_text, description_sections,
      employment_type, workplace_type, salary_text, posted_at, dedupe_key,
      sponsorship_mentioned, sponsorship_polarity, sponsorship_snippet, h1b_combined_confidence, raw_json
    ) VALUES (
      @companyId, @sourceType, @externalId, @title, @location, @department, @url,
      @descriptionHtml, @descriptionText, @descriptionSections,
      @employmentType, @workplaceType, @salaryText, @postedAt, @dedupeKey,
      @sponsorshipMentioned, @sponsorshipPolarity, @sponsorshipSnippet, @h1bCombinedConfidence, @rawJson
    )`
  ).run(row);
  return "inserted";
}

export interface CloseStaleJobsResult {
  jobsClosed: number;
  jobsArchived: number;
}

/**
 * CLOSED JOBS policy: for a company's jobs not present in the latest scan of an authoritative ATS
 * board (seenDedupeKeys) — career_link scrapes are never passed here; see scan.ts — closes them
 * (is_active=0) the moment they first go missing, and in that same moment archives them too, but
 * ONLY if it's unprotected (unapplied and unpinned for EVERY candidate — see
 * isProtectedForAnyCandidate, Phase 2.5). A protected job (Applied, Interviewing,
 * Offer, Employer Rejected, or pinned) just stays closed-but-not-archived indefinitely: "keep
 * record and mark posting closed." This only fires on the Active->Closed transition itself, not on
 * every subsequent scan a job is still missing — a protected job that later becomes unprotected is
 * still covered, just via runAgeBasedSweep instead (age keeps accumulating from posted_at/
 * first_seen_at regardless of is_active).
 *
 * Already-archived jobs are excluded from consideration — they're end-state until restoreJob()
 * (or reappearing in a scan, handled by upsertJob) brings them back.
 */
export function closeStaleJobs(companyId: number, seenDedupeKeys: string[]): CloseStaleJobsResult {
  const db = getDb();
  const seen = new Set(seenDedupeKeys);

  const candidates = db
    .prepare(
      `SELECT id, dedupe_key, is_active, missed_scan_count, pipeline_status, pinned
       FROM jobs WHERE company_id = ? AND is_archived = 0`
    )
    .all(companyId) as {
    id: number;
    dedupe_key: string;
    is_active: 0 | 1;
    missed_scan_count: number;
    pipeline_status: PipelineStatus;
    pinned: 0 | 1;
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
      const wasActive = job.is_active === 1;

      if (wasActive) {
        closeStmt.run({ id: job.id, missedCount });
        recordHistory(db, job.id, "lifecycle", "Active", "Closed", "Not found in latest scan (posting closed)");
        jobsClosed++;

        // Phase 2.5: protection is now a cross-candidate OR over candidate_job_state, not the frozen
        // jobs.pipeline_status/jobs.pinned columns — see isProtectedForAnyCandidate's doc comment.
        // The underlying protection RULE (Applied/Interviewing/Offer/Employer Rejected/pinned never
        // auto-archived) is unchanged; only its data source moved.
        if (!isProtectedForAnyCandidate(job.dedupe_key)) {
          const reason = "Posting closed upstream (unapplied)";
          archiveStmt.run({ id: job.id, reason });
          recordHistory(db, job.id, "lifecycle", "Closed", "Archived", reason);
          jobsArchived++;
        }
      } else {
        bumpMissedStmt.run({ id: job.id, missedCount });
      }
    }
  });
  process();

  return { jobsClosed, jobsArchived };
}

/**
 * Manually archives a job. Refuses while the job is protected for ANY candidate — Applied,
 * Interviewing, Offer, Employer Rejected, or pinned (see isProtectedForAnyCandidate, Phase 2.5) —
 * the same guardrail every automatic archive path (closeStaleJobs, runAgeBasedSweep) enforces, so
 * "never archive a protected job" holds regardless of trigger. A no-op (not an error) if the job is
 * already archived.
 */
export function archiveJob(
  id: number,
  reason?: string
): { ok: true; job: Job } | { ok: false; blockedReason: string } {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
  if (!existing) return { ok: false, blockedReason: "Job not found" };
  if (existing.is_archived === 1) return { ok: true, job: existing };
  // Phase 2.5: cross-candidate protection check — see isProtectedForAnyCandidate's doc comment.
  // The reason text is deliberately generic (not "it is marked X") since jobs.pipeline_status/pinned
  // are frozen legacy columns now — the actual protecting candidate's state lives in
  // candidate_job_state and may belong to a different candidate than whoever clicked Archive.
  if (isProtectedForAnyCandidate(existing.dedupe_key)) {
    return {
      ok: false,
      blockedReason:
        "Cannot archive this job — at least one candidate has it pinned or in a protected pipeline stage (Applied/Interviewing/Offer/Employer Rejected). Unpin it or change that candidate's pipeline status first.",
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

/** Pins/unpins a job — a manual override that protects it from every auto-archive/auto-delete path
 *  regardless of age or pipeline_status, same protection tier as Applied/Interviewing/Offer/
 *  Employer Rejected. Does not itself archive/restore/delete anything. */
export function setJobPinned(id: number, pinned: boolean): Job | undefined {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
  if (!existing) return undefined;

  const next = pinned ? 1 : 0;
  db.prepare("UPDATE jobs SET pinned = @pinned, updated_at = datetime('now') WHERE id = @id").run({ id, pinned: next });
  if (existing.pinned !== next) {
    recordHistory(
      db,
      id,
      "lifecycle",
      existing.pinned === 1 ? "Pinned" : "Unpinned",
      next === 1 ? "Pinned" : "Unpinned",
      next === 1 ? "Manually pinned" : "Manually unpinned"
    );
  }

  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job;
}

/**
 * Writes a suppression fingerprint (see suppressed_jobs in schema.sql) and deletes the job row in
 * one transaction-scoped step. Internal — used by both markNotInterested (immediate, any age) and
 * runAgeBasedSweep (age > 10 days, unapplied/unpinned). job_status_history rows for this job
 * cascade-delete with it (ON DELETE CASCADE) — the reason is preserved on the suppression row
 * instead, since history dies with the job by design.
 */
function suppressAndDeleteJob(
  db: Database.Database,
  job: { id: number; company_id: number; dedupe_key: string; title: string },
  reason: string
): void {
  db.prepare(
    `INSERT INTO suppressed_jobs (dedupe_key, company_id, title, reason)
     VALUES (@dedupeKey, @companyId, @title, @reason)
     ON CONFLICT(dedupe_key) DO UPDATE SET reason = excluded.reason, suppressed_at = datetime('now')`
  ).run({ dedupeKey: job.dedupe_key, companyId: job.company_id, title: job.title, reason });
  db.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
}

/**
 * "Not Interested" is an action, not a persisted pipeline_status (see the PipelineStatus doc
 * comment in src/types/index.ts) — this immediately deletes the job record and writes a
 * suppression fingerprint so the exact same requisition never silently reappears, regardless of
 * age, pipeline_status, or pinned. The caller (API route) is responsible for deleting the job's
 * generated-files directory via src/lib/generatedFiles.ts — this function only touches the DB.
 */
export function markNotInterested(jobId: number): DeletedJobRef | undefined {
  const db = getDb();
  const job = db
    .prepare(
      `SELECT j.id, j.company_id, j.dedupe_key, j.title, c.name AS company_name
       FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?`
    )
    .get(jobId) as
    | { id: number; company_id: number; dedupe_key: string; title: string; company_name: string }
    | undefined;
  if (!job) return undefined;

  db.transaction(() => {
    suppressAndDeleteJob(db, job, "Not Interested");
  })();

  return { jobId: job.id, companyName: job.company_name, dedupeKey: job.dedupe_key };
}

/**
 * Age-based sweep, independent of any single company's scan: evaluates every job's current age
 * (getJobAgeDays — posted_at when reliable, else first_seen_at, never last_seen_at) against the
 * Fresh/Active/Archived/Delete policy, for jobs of ANY source_type (unlike closeStaleJobs, this
 * isn't about a posting closing upstream — it's purely "how long has this sat unactioned," which
 * applies to career-link jobs too). Protected jobs (isProtectedForAnyCandidate: Applied, Interviewing,
 * Offer, Employer Rejected, or pinned for ANY candidate) are skipped entirely, at any age.
 *
 *   8-10 days old, unapplied/unpinned, not yet archived -> archived.
 *   >10 days old, unapplied/unpinned (regardless of current archived state) -> permanently
 *     deleted, with a suppression fingerprint written so it can't silently reappear.
 *
 * Called once per runScan() in src/lib/scan.ts — not tied to which companies were scanned this run.
 */
export function runAgeBasedSweep(now: Date = new Date()): AgeSweepResult {
  const db = getDb();
  const { lifecycle } = getAppSettings();
  const thresholds = {
    freshMaxDays: lifecycle.freshDays,
    activeMaxDays: lifecycle.archiveAfterDays,
    archiveMaxDays: lifecycle.deleteAfterDays,
  };
  const rows = db
    .prepare(
      `SELECT j.id, j.company_id, j.dedupe_key, j.title, j.posted_at, j.first_seen_at,
              j.is_active, j.is_archived, j.pipeline_status, j.pinned, c.name AS company_name
       FROM jobs j JOIN companies c ON c.id = j.company_id`
    )
    .all() as {
    id: number;
    company_id: number;
    dedupe_key: string;
    title: string;
    posted_at: string | null;
    first_seen_at: string;
    is_active: 0 | 1;
    is_archived: 0 | 1;
    pipeline_status: PipelineStatus;
    pinned: 0 | 1;
    company_name: string;
  }[];

  const archiveStmt = db.prepare(
    `UPDATE jobs SET is_archived = 1, archived_at = datetime('now'), archived_reason = @reason, updated_at = datetime('now')
     WHERE id = @id`
  );

  let archived = 0;
  const deleted: DeletedJobRef[] = [];

  db.transaction(() => {
    for (const job of rows) {
      // Phase 2.5: cross-candidate protection check — see isProtectedForAnyCandidate's doc comment.
      if (isProtectedForAnyCandidate(job.dedupe_key)) continue;

      const ageDays = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at }, now);
      const band = getJobAgeBand(ageDays, thresholds);

      if (band === "stale") {
        suppressAndDeleteJob(db, job, `Aged out: ${ageDays} days unapplied`);
        deleted.push({ jobId: job.id, companyName: job.company_name, dedupeKey: job.dedupe_key });
      } else if (band === "aging" && job.is_archived === 0) {
        const reason = `Aged out: ${ageDays} days unapplied`;
        archiveStmt.run({ id: job.id, reason });
        recordHistory(db, job.id, "lifecycle", job.is_active === 1 ? "Active" : "Closed", "Archived", reason);
        archived++;
      }
    }
  })();

  return { archived, deleted };
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
