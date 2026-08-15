import { getDb } from "@/db";
import { classifyCandidateJobBucket } from "@/lib/rank/candidateJobBucket";
import type { MatchRun } from "@/db/queries/matchRuns";
import type { WorkflowStatus } from "@/lib/resumeQuality/types";
import type { ConnectorHealth, PipelineStatus } from "@/types";

/**
 * Phase 4 Stage 6 — read-only SQL aggregation for the Operations dashboard. Every query here is a
 * single COUNT/SUM/GROUP BY over an EXISTING table; nothing loads full row sets into JS to count in
 * memory (jobs, companies, scan_runs, job_match_results are all large/growing tables — see the perf
 * requirement in the Stage 6 spec §16), and nothing here writes anything. No new tables.
 *
 * Time-window semantics: `windowDays` scopes ACTIVITY metrics only (scans/matching runs/notifications
 * created inside the window) — CURRENT-STATE counts (unread notifications, current pipeline_status
 * counts, current job_match_results decisions, current connector_health distribution, current
 * resume_quality_workflows status distribution) deliberately ignore it, per the Stage 6 spec's
 * explicit "current state" vs "activity during window" distinction (§14).
 *
 * julianday() is used for all window filtering rather than JS Date math: SQLite's date/time
 * functions treat every stored timestamp as UTC regardless of whether it was written by
 * `datetime('now')` (space-separated, no 'Z') or by app code's `Date#toISOString()`
 * (T-separated, trailing 'Z') — both forms parse to the identical UTC instant under julianday(),
 * verified directly against production data before relying on it here. This is a SQL-side parsing
 * fact, unrelated to (and not a workaround for) src/lib/settings.ts's parseSqliteUtc, which exists
 * for a completely different problem: JS's `new Date(string)` treats a 'Z'-less string as LOCAL
 * time, which julianday() never does.
 */

export type WindowKey = "24h" | "7d" | "30d";

export const WINDOW_DAYS: Record<WindowKey, number> = { "24h": 1, "7d": 7, "30d": 30 };

// --- Scanning -----------------------------------------------------------------------------------

export interface ScanningWindowSummary {
  runs: number;
  successCount: number;
  partialCount: number;
  failedCount: number;
  companiesScanned: number;
  jobsAdded: number;
  jobsUpdated: number;
  jobsUnchanged: number;
  duplicatesSkipped: number;
  jobsClosed: number;
  jobsArchived: number;
  descriptionFailures: number;
  retryCount: number;
}

export interface LatestScanActivity {
  startedAt: string;
  finishedAt: string;
  status: string;
}

/** One aggregate row over scan_runs within the window — bounded by the query itself (SUM/COUNT),
 *  never by fetching individual rows. */
export function getScanningWindowSummary(windowDays: number): ScanningWindowSummary {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS runs,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
         SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partialCount,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
         COUNT(DISTINCT company_id) AS companiesScanned,
         COALESCE(SUM(jobs_added), 0) AS jobsAdded,
         COALESCE(SUM(jobs_updated), 0) AS jobsUpdated,
         COALESCE(SUM(jobs_unchanged), 0) AS jobsUnchanged,
         COALESCE(SUM(duplicates_skipped), 0) AS duplicatesSkipped,
         COALESCE(SUM(jobs_closed), 0) AS jobsClosed,
         COALESCE(SUM(jobs_archived), 0) AS jobsArchived,
         COALESCE(SUM(description_failures), 0) AS descriptionFailures,
         COALESCE(SUM(retry_count), 0) AS retryCount
       FROM scan_runs
       WHERE julianday('now') - julianday(started_at) <= @windowDays`
    )
    .get({ windowDays }) as ScanningWindowSummary;
  return row;
}

/** The single most recent scan_run system-wide, by started_at — NOT window-scoped (current state,
 *  not activity), so "last scan ran 6 weeks ago" remains visible even under a 24h window. */
export function getLatestScanActivity(): LatestScanActivity | null {
  const row = getDb()
    .prepare(`SELECT started_at AS startedAt, finished_at AS finishedAt, status FROM scan_runs ORDER BY started_at DESC LIMIT 1`)
    .get() as LatestScanActivity | undefined;
  return row ?? null;
}

// --- Connectors -----------------------------------------------------------------------------------

export interface ConnectorHealthSummary {
  healthy: number;
  degraded: number;
  down: number;
  unknown: number;
}

export interface FailingConnector {
  id: number;
  name: string;
  sourceType: string;
  consecutiveFailures: number;
  connectorHealth: ConnectorHealth;
  lastErrorCategory: string | null;
  lastErrorMessage: string | null;
}

/** Current connector_health distribution across companies — always current-state, no window
 *  parameter (connector_health is itself a live, continuously-recomputed field, not a log). */
export function getConnectorHealthSummary(): ConnectorHealthSummary {
  const rows = getDb().prepare(`SELECT connector_health, COUNT(*) AS n FROM companies GROUP BY connector_health`).all() as {
    connector_health: string;
    n: number;
  }[];
  const summary: ConnectorHealthSummary = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
  for (const row of rows) {
    if (row.connector_health === "healthy") summary.healthy = row.n;
    else if (row.connector_health === "degraded") summary.degraded = row.n;
    else if (row.connector_health === "down") summary.down = row.n;
    else summary.unknown += row.n; // any legacy/unrecognized value folds into unknown, never dropped
  }
  return summary;
}

/** Companies with an active failure streak, worst first — bounded LIMIT, never a full table scan
 *  result set returned to the client. */
export function listTopFailingConnectors(limit = 10): FailingConnector[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, source_type AS sourceType, consecutive_failures AS consecutiveFailures,
              connector_health AS connectorHealth, last_error_category AS lastErrorCategory,
              last_error_message AS lastErrorMessage
       FROM companies
       WHERE consecutive_failures > 0
       ORDER BY consecutive_failures DESC
       LIMIT @limit`
    )
    .all({ limit }) as FailingConnector[];
  return rows;
}

// --- Matching (global) ------------------------------------------------------------------------

export interface MatchingWindowSummary {
  runs: number;
  jobsEvaluated: number;
  jobsBlocked: number;
  jobsNeedsReview: number;
  jobsReady: number;
  jobsErrored: number;
}

/** Global (all candidates) match_runs activity within the window — deliberately not candidate-
 *  scoped, this answers "is the matching pipeline running at all", the operational question, not
 *  "how is candidate N's matching going" (that's getCandidateMatchDecisionCounts below). Includes
 *  BOTH scan-triggered incremental matching (Stage 2) and candidate-profile-triggered rematching
 *  (Stage 5) — match_runs has no column distinguishing the two triggers (see the module doc comment
 *  on getRecentCandidateMatchRuns for the full provenance-limitation explanation). */
export function getMatchingWindowSummary(windowDays: number): MatchingWindowSummary {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS runs,
         COALESCE(SUM(jobs_evaluated), 0) AS jobsEvaluated,
         COALESCE(SUM(jobs_blocked), 0) AS jobsBlocked,
         COALESCE(SUM(jobs_needs_review), 0) AS jobsNeedsReview,
         COALESCE(SUM(jobs_ready), 0) AS jobsReady,
         COALESCE(SUM(jobs_errored), 0) AS jobsErrored
       FROM match_runs
       WHERE julianday('now') - julianday(started_at) <= @windowDays`
    )
    .get({ windowDays }) as MatchingWindowSummary;
  return row;
}

export interface CandidateMatchDecisionCounts {
  readyForTailoring: number;
  needsReview: number;
  blocked: number;
}

/** Current (status='active', i.e. non-superseded) job_match_results decision counts for ONE
 *  candidate — always candidate-scoped, always current-state (never window-filtered: "how many of
 *  my current matches are READY right now" has no meaningful time window). */
export function getCandidateMatchDecisionCounts(candidateId: number): CandidateMatchDecisionCounts {
  const rows = getDb()
    .prepare(`SELECT decision, COUNT(*) AS n FROM job_match_results WHERE candidate_id = @candidateId AND status = 'active' GROUP BY decision`)
    .all({ candidateId }) as { decision: string; n: number }[];
  const counts: CandidateMatchDecisionCounts = { readyForTailoring: 0, needsReview: 0, blocked: 0 };
  for (const row of rows) {
    if (row.decision === "READY_FOR_TAILORING") counts.readyForTailoring = row.n;
    else if (row.decision === "NEEDS_REVIEW") counts.needsReview = row.n;
    else if (row.decision === "BLOCKED") counts.blocked = row.n;
  }
  return counts;
}

/**
 * Candidate-scoped recent match_runs (reuses src/db/queries/matchRuns.ts's listMatchRuns — no new
 * query, no new table). PROVENANCE LIMITATION: match_runs has no column recording whether a given
 * row came from Stage 2's scan-triggered incremental matching or Stage 5's candidate-profile/
 * settings-triggered rematching — both write through the identical insertMatchRun() call with the
 * identical shape (see src/lib/match/incrementalMatch.ts and src/lib/match/rematchCandidate.ts).
 * These rows are real and candidate-scoped, just not attributable to a specific trigger — the
 * caller (route/UI) must surface that limitation rather than mislabeling every row "a candidate
 * rematch". Per the Stage 6 spec: prefer truth over completeness — no new column/table is added
 * here to manufacture the missing distinction.
 */
export function getRecentCandidateMatchRuns(candidateId: number, limit: number): MatchRun[] {
  return getDb()
    .prepare(`SELECT * FROM match_runs WHERE candidate_id = ? ORDER BY started_at DESC LIMIT ?`)
    .all(candidateId, limit) as MatchRun[];
}

// --- Notifications ----------------------------------------------------------------------------

export interface NotificationSummary {
  total: number;
  unread: number;
  read: number;
  createdInWindow: number;
}

export interface RecentNotification {
  id: number;
  dedupeKey: string;
  type: string;
  title: string;
  createdAt: string;
  readAt: string | null;
}

/** total/unread/read are current-state; createdInWindow is the one activity-scoped field — always
 *  candidate-scoped, per notifications' own schema (candidate_id is part of every row). */
export function getNotificationSummary(candidateId: number, windowDays: number): NotificationSummary {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread,
         SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read,
         SUM(CASE WHEN julianday('now') - julianday(created_at) <= @windowDays THEN 1 ELSE 0 END) AS createdInWindow
       FROM notifications
       WHERE candidate_id = @candidateId`
    )
    .get({ candidateId, windowDays }) as { total: number; unread: number; read: number; createdInWindow: number };
  return row;
}

/** Total notifications ever created, across every candidate — used only for the global
 *  Notifications-subsystem health classification (§4/§10's Overview row), never candidate-scoped
 *  display data. */
export function getTotalNotificationsEverCreated(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM notifications`).get() as { n: number };
  return row.n;
}

/** Small, bounded recent-notifications list. `title` already embeds "{job title} at {company}"
 *  (see generateNotifications.ts's notificationTitle) — no join against jobs/companies needed. */
export function listRecentNotifications(candidateId: number, limit: number): RecentNotification[] {
  return getDb()
    .prepare(
      `SELECT id, dedupe_key AS dedupeKey, type, title, created_at AS createdAt, read_at AS readAt
       FROM notifications WHERE candidate_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(candidateId, limit) as RecentNotification[];
}

// --- Resume / quality pipeline -----------------------------------------------------------------

export interface ResumeQualitySummary {
  tailoringRunsTotal: number;
  workflowsByStatus: Partial<Record<WorkflowStatus, number>>;
  /** status='FAILED' AND current_iteration < max_iterations — failed before exhausting iterations
   *  (e.g. a writer/generator error), distinct from the max-iterations case below. Both are real,
   *  independently derivable subsets of the single FAILED status (see resume_quality_workflows'
   *  schema comment: there is no separate DB status for "max iterations reached" — it is FAILED
   *  with failure_reason set, distinguishable here via current_iteration vs max_iterations). */
  failedEarly: number;
  /** status='FAILED' AND current_iteration >= max_iterations — exhausted every iteration and still
   *  failed the quality gate, i.e. genuinely reached human review. */
  failedMaxIterations: number;
  /** Among READY workflows, final_approved_iteration === 1 — approved on the first pass. */
  readyOnFirstIteration: number;
  /** Among READY workflows, final_approved_iteration > 1 — needed at least one improvement cycle. */
  readyRequiredImprovement: number;
  /** AVG(latest_overall_score) over READY workflows only — "final" score is only meaningful once a
   *  workflow has actually reached a terminal, approved state; an in-progress workflow's
   *  latest_overall_score is a snapshot, not a final result. null when there are zero READY rows
   *  (never fabricated as 0). */
  averageFinalQualityScore: number | null;
  /** AVG(final_approved_iteration) over READY workflows with a non-null final_approved_iteration.
   *  null when there are zero such rows. */
  averageIterationsToReady: number | null;
}

/** Entirely candidate-scoped (§20: candidate A must never see candidate B's tailoring/resume-
 *  quality statistics) — there is no global variant of this query. */
export function getResumeQualitySummary(candidateId: number): ResumeQualitySummary {
  const db = getDb();

  const tailoringRunsTotal = (db.prepare(`SELECT COUNT(*) AS n FROM tailoring_runs WHERE candidate_id = ?`).get(candidateId) as { n: number }).n;

  const statusRows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM resume_quality_workflows WHERE candidate_id = ? GROUP BY status`)
    .all(candidateId) as { status: WorkflowStatus; n: number }[];
  const workflowsByStatus: Partial<Record<WorkflowStatus, number>> = {};
  for (const row of statusRows) workflowsByStatus[row.status] = row.n;

  const failedSplit = db
    .prepare(
      `SELECT
         SUM(CASE WHEN current_iteration < max_iterations THEN 1 ELSE 0 END) AS failedEarly,
         SUM(CASE WHEN current_iteration >= max_iterations THEN 1 ELSE 0 END) AS failedMaxIterations
       FROM resume_quality_workflows WHERE candidate_id = ? AND status = 'FAILED'`
    )
    .get(candidateId) as { failedEarly: number | null; failedMaxIterations: number | null };

  const readySplit = db
    .prepare(
      `SELECT
         SUM(CASE WHEN final_approved_iteration = 1 THEN 1 ELSE 0 END) AS readyOnFirstIteration,
         SUM(CASE WHEN final_approved_iteration > 1 THEN 1 ELSE 0 END) AS readyRequiredImprovement,
         AVG(latest_overall_score) AS averageFinalQualityScore,
         AVG(final_approved_iteration) AS averageIterationsToReady
       FROM resume_quality_workflows WHERE candidate_id = ? AND status = 'READY'`
    )
    .get(candidateId) as {
    readyOnFirstIteration: number | null;
    readyRequiredImprovement: number | null;
    averageFinalQualityScore: number | null;
    averageIterationsToReady: number | null;
  };

  return {
    tailoringRunsTotal,
    workflowsByStatus,
    failedEarly: failedSplit.failedEarly ?? 0,
    failedMaxIterations: failedSplit.failedMaxIterations ?? 0,
    readyOnFirstIteration: readySplit.readyOnFirstIteration ?? 0,
    readyRequiredImprovement: readySplit.readyRequiredImprovement ?? 0,
    averageFinalQualityScore: readySplit.averageFinalQualityScore,
    averageIterationsToReady: readySplit.averageIterationsToReady,
  };
}

/** Global (all candidates) resume_quality_workflows status distribution — used only for the
 *  Overview's Resume Pipeline subsystem health, never rendered as candidate-attributable data. */
export function getGlobalResumePipelineCounts(): { workflows: number; failed: number } {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS workflows, SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed FROM resume_quality_workflows`)
    .get() as { workflows: number; failed: number | null };
  return { workflows: row.workflows, failed: row.failed ?? 0 };
}

// --- Application lifecycle --------------------------------------------------------------------

export interface ApplicationLifecycleCounts {
  new: number;
  interested: number;
  applied: number;
  interviewing: number;
  offer: number;
  employerRejected: number;
  readyToApply: number;
}

const PIPELINE_STATUS_FIELD: Record<PipelineStatus, keyof Omit<ApplicationLifecycleCounts, "readyToApply">> = {
  New: "new",
  Interested: "interested",
  Applied: "applied",
  Interviewing: "interviewing",
  Offer: "offer",
  "Employer Rejected": "employerRejected",
};

/**
 * Candidate-scoped pipeline_status counts, plus the derived READY_TO_APPLY count computed by
 * reusing src/lib/rank/candidateJobBucket.ts's classifyCandidateJobBucket — the SAME classifier the
 * For You feed uses, not a re-implementation of its precedence rules (Stage 6 spec §13: "reuse
 * existing classifier/query semantics", never persist a derived bucket).
 *
 * The READY_TO_APPLY candidate set is bounded by resume_quality_workflows for this candidate (a
 * small, per-candidate table — one row per tailoring attempt, nowhere near jobs-table scale), not
 * by candidate_job_state or jobs — so this never scans the full jobs table (§16).
 */
export function getApplicationLifecycleCounts(candidateId: number): ApplicationLifecycleCounts {
  const db = getDb();

  const statusRows = db
    .prepare(`SELECT pipeline_status AS status, COUNT(*) AS n FROM candidate_job_state WHERE candidate_id = ? GROUP BY pipeline_status`)
    .all(candidateId) as { status: PipelineStatus; n: number }[];

  const counts: ApplicationLifecycleCounts = { new: 0, interested: 0, applied: 0, interviewing: 0, offer: 0, employerRejected: 0, readyToApply: 0 };
  for (const row of statusRows) {
    const field = PIPELINE_STATUS_FIELD[row.status];
    if (field) counts[field] = row.n;
  }

  // Latest resume_quality_workflow per dedupe_key for this candidate, READY only, joined against
  // this candidate's own candidate_job_state row for the same job (LEFT JOIN so a job with no
  // candidate_job_state row yet still defaults to pipeline_status='New', matching every other
  // candidate_job_state overlay convention in this codebase — see src/db/queries/jobs.ts's
  // candidateOverlay).
  const readyRows = db
    .prepare(
      `SELECT COALESCE(cjs.pipeline_status, 'New') AS pipelineStatus
       FROM resume_quality_workflows rqw
       JOIN (
         SELECT dedupe_key, MAX(id) AS max_id FROM resume_quality_workflows WHERE candidate_id = ? GROUP BY dedupe_key
       ) latest ON latest.max_id = rqw.id
       LEFT JOIN candidate_job_state cjs ON cjs.candidate_id = rqw.candidate_id AND cjs.dedupe_key = rqw.dedupe_key
       WHERE rqw.candidate_id = ? AND rqw.status = 'READY'`
    )
    .all(candidateId, candidateId) as { pipelineStatus: PipelineStatus }[];

  for (const row of readyRows) {
    const bucket = classifyCandidateJobBucket({
      pipelineStatus: row.pipelineStatus,
      // Unreachable for this pre-filtered (latestResumeQualityWorkflow.status === 'READY') input
      // set unless pipelineStatus is Interviewing/Applied/Offer/Employer Rejected, in which case
      // classifyCandidateJobBucket returns before ever reading postedAt/firstSeenAt — see that
      // function's own precedence order. Never used to fabricate a freshness signal here.
      postedAt: null,
      firstSeenAt: "1970-01-01T00:00:00.000Z",
      latestResumeQualityWorkflow: { status: "READY" },
    });
    if (bucket === "READY_TO_APPLY") counts.readyToApply++;
  }

  return counts;
}
