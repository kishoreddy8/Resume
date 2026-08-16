import { getDb } from "@/db/index";
import type { CompanyResolutionStatus, SourceType } from "@/types";

/**
 * ATS coverage / source health — pure derived read queries over the EXISTING companies/jobs
 * columns (source_type, suspected_ats, resolution_status, discovery_reason, connector_health,
 * discovery_attempted_at). No new table, no new counters — per the approved pre-Phase-3 hardening
 * plan's explicit finding that no schema change is needed here: every number below is computed at
 * read time from data the discovery/scan pipeline already writes, so it can never drift out of sync
 * with the companies table the way a cached counter could.
 */

export interface AtsCoverageCompany {
  id: number;
  name: string;
  resolution_status: CompanyResolutionStatus;
  suspected_ats: string | null;
  discovery_reason: string | null;
  discovery_attempted_at: string | null;
  connector_health: string;
  job_count: number;
  healthReasonCode: HealthReasonCode;
  healthReasonLabel: string;
  /** ATS Health Semantics V2 — data-quality/verification notes about the latest scan, kept
   *  deliberately separate from healthReasonCode/connector_health: a company can be fully
   *  operationally HEALTHY and still carry warnings (e.g. a few jobs had unknown locations). See
   *  this file's deriveWarnings doc comment for exactly what does and doesn't produce one. */
  warnings: AtsCoverageWarning[];
}

/**
 * Deterministic, read-time-derived reason a company has its current connector_health — built only
 * from columns the scan pipeline already writes (src/db/queries/companies.ts's recordScanSuccess/
 * recordScanPartial/recordScanFailure). No new table, no invented category: TRANSIENT_FAILURE and
 * REPEATED_FAILURES both come from a genuinely thrown scan error (last_error_category is non-null
 * only on that path); DESCRIPTION_FETCH_FAILURE comes from a scan where every discovered job's
 * description fetch failed (see src/lib/scan.ts's ATS Health Semantics V2 comment on
 * hasCompleteDescriptionFailure) — a materially broken detail-fetch mechanism, not an isolated
 * per-job gap. Isolated per-job gaps and location-classification outcomes never reach this function
 * at all as degradation reasons; they're surfaced separately via deriveWarnings below.
 */
export type HealthReasonCode =
  | "HEALTHY"
  | "NEVER_SCANNED"
  | "REPEATED_FAILURES"
  | "TRANSIENT_FAILURE"
  | "DESCRIPTION_FETCH_FAILURE"
  | "UNCLASSIFIED";

interface HealthReason {
  code: HealthReasonCode;
  label: string;
}

function deriveHealthReason(row: RawRow): HealthReason {
  const lastErrorSummary = row.last_error_category ?? row.last_error_message ?? "unknown error";
  if (row.connector_health === "healthy") {
    return { code: "HEALTHY", label: "Last scan succeeded" };
  }
  if (row.connector_health === "unknown") {
    if (row.last_scanned_at === null) {
      return { code: "NEVER_SCANNED", label: "Not yet scanned" };
    }
    return { code: "UNCLASSIFIED", label: "Scanned, but health has not been evaluated" };
  }
  if (row.connector_health === "down") {
    return {
      code: "REPEATED_FAILURES",
      label: `${row.consecutive_failures} consecutive scan failures — last: ${lastErrorSummary}`,
    };
  }
  // connector_health === "degraded"
  if (row.consecutive_failures >= 1) {
    return {
      code: "TRANSIENT_FAILURE",
      label: `${row.consecutive_failures} consecutive scan failure(s) — last: ${lastErrorSummary}`,
    };
  }
  if (row.last_error_message) {
    return { code: "DESCRIPTION_FETCH_FAILURE", label: row.last_error_message };
  }
  return { code: "UNCLASSIFIED", label: "Marked degraded, but no failure detail is on record" };
}

/**
 * ATS Health Semantics V2 — data-quality/verification warnings, entirely separate from operational
 * health, derived from the LATEST scan_run row only (never from companies.connector_health/
 * last_error_message, which stay strictly about genuine operational problems). A company can show
 * zero warnings, one, or several, regardless of its connector_health value:
 * - LOCATION_UNKNOWN: the latest run excluded ≥1 job because its location couldn't be confidently
 *   classified as US (src/lib/jobLocationScope.ts) — the connector fetched its inventory fine; this
 *   is a content/classification outcome about the source, never a reason to close the gap by loosening
 *   US-only classification.
 * - DESCRIPTION_PARTIAL: the latest run had ≥1 job description fetch failure, but NOT every job
 *   failed (a full failure is DESCRIPTION_FETCH_FAILURE, an operational-health reason instead — see
 *   deriveHealthReason — so this warning only fires for the non-total case).
 * - SAMPLE_VERIFICATION: the latest run was a bounded verification sample, not a full scan —
 *   "verification passed, full scan pending" rather than a claim of full operational confidence.
 */
export type AtsCoverageWarningCode = "LOCATION_UNKNOWN" | "DESCRIPTION_PARTIAL" | "SAMPLE_VERIFICATION";

export interface AtsCoverageWarning {
  code: AtsCoverageWarningCode;
  label: string;
}

function deriveWarnings(run: LatestScanRunRow | undefined): AtsCoverageWarning[] {
  if (!run) return [];
  const warnings: AtsCoverageWarning[] = [];
  if (run.unknown_location_count > 0) {
    warnings.push({
      code: "LOCATION_UNKNOWN",
      label: `${run.unknown_location_count} job location(s) could not be confidently classified as US and were excluded`,
    });
  }
  const isCompleteDescriptionFailure = run.jobs_discovered > 0 && run.description_failures === run.jobs_discovered;
  if (run.description_failures > 0 && !isCompleteDescriptionFailure) {
    warnings.push({
      code: "DESCRIPTION_PARTIAL",
      label: `${run.description_failures} of ${run.jobs_discovered} job description(s) failed to fetch`,
    });
  }
  if (run.is_sample_scan) {
    warnings.push({
      code: "SAMPLE_VERIFICATION",
      label: "Verification sample only — full scan pending",
    });
  }
  return warnings;
}

export interface SupportedAtsGroup {
  sourceType: Exclude<SourceType, "career_link">;
  companyCount: number;
  jobCount: number;
  healthyCount: number;
  degradedCount: number;
  downCount: number;
  reasonBreakdown: Partial<Record<HealthReasonCode, number>>;
  /** ATS Health Semantics V2 — count of companies carrying at least one warning, regardless of
   *  their connector_health. Deliberately separate from healthyCount/degradedCount/downCount: a
   *  company counted in healthyCount can also be counted here. */
  warningBreakdown: Partial<Record<AtsCoverageWarningCode, number>>;
  companies: AtsCoverageCompany[];
}

export interface NeedsAdapterGroup {
  suspectedAts: string;
  companyCount: number;
  companies: AtsCoverageCompany[];
}

export interface AtsCoverageSummary {
  supported: SupportedAtsGroup[];
  needsAdapter: NeedsAdapterGroup[];
  generic: AtsCoverageCompany[];
  unresolved: AtsCoverageCompany[];
  totals: {
    companies: number;
    supported: number;
    needsAdapter: number;
    generic: number;
    unresolved: number;
  };
}

const COMPANY_WITH_JOB_COUNT_SQL = `
  SELECT
    c.id, c.name, c.source_type, c.resolution_status, c.suspected_ats, c.discovery_reason,
    c.discovery_attempted_at, c.connector_health,
    c.consecutive_failures, c.last_successful_scan_at, c.last_failed_scan_at, c.last_scanned_at,
    c.last_error_category, c.last_error_message,
    COALESCE(j.job_count, 0) AS job_count,
    sr.jobs_discovered AS run_jobs_discovered, sr.description_failures AS run_description_failures,
    sr.unknown_location_count AS run_unknown_location_count, sr.is_sample_scan AS run_is_sample_scan
  FROM companies c
  LEFT JOIN (
    SELECT company_id, COUNT(*) AS job_count
    FROM jobs
    WHERE is_active = 1
    GROUP BY company_id
  ) j ON j.company_id = c.id
  -- Latest scan_run per company only, via the same MAX(id) GROUP BY pattern already proven fast in
  -- src/db/queries/scanRuns.ts's getLatestScanRunPerCompany — the derived "latest" table below
  -- computes every company's latest run ID once, up front, as its own independent joined result set
  -- (identical shape to the job_count join above), never a correlated per-outer-row subquery, so
  -- this stays one query regardless of company count.
  LEFT JOIN (
    SELECT company_id, MAX(id) AS max_id FROM scan_runs GROUP BY company_id
  ) latest ON latest.company_id = c.id
  LEFT JOIN scan_runs sr ON sr.id = latest.max_id
  WHERE c.is_active = 1
`;

interface LatestScanRunRow {
  jobs_discovered: number;
  description_failures: number;
  unknown_location_count: number;
  is_sample_scan: number;
}

interface RawRow {
  id: number;
  name: string;
  source_type: SourceType;
  resolution_status: CompanyResolutionStatus;
  suspected_ats: string | null;
  discovery_reason: string | null;
  discovery_attempted_at: string | null;
  connector_health: string;
  consecutive_failures: number;
  last_successful_scan_at: string | null;
  last_failed_scan_at: string | null;
  last_scanned_at: string | null;
  last_error_category: string | null;
  last_error_message: string | null;
  job_count: number;
  run_jobs_discovered: number | null;
  run_description_failures: number | null;
  run_unknown_location_count: number | null;
  run_is_sample_scan: number | null;
}

function toCoverageCompany(row: RawRow): AtsCoverageCompany {
  const reason = deriveHealthReason(row);
  const latestRun: LatestScanRunRow | undefined =
    row.run_jobs_discovered === null
      ? undefined
      : {
          jobs_discovered: row.run_jobs_discovered,
          description_failures: row.run_description_failures ?? 0,
          unknown_location_count: row.run_unknown_location_count ?? 0,
          is_sample_scan: row.run_is_sample_scan ?? 0,
        };
  return {
    id: row.id,
    name: row.name,
    resolution_status: row.resolution_status,
    suspected_ats: row.suspected_ats,
    discovery_reason: row.discovery_reason,
    discovery_attempted_at: row.discovery_attempted_at,
    connector_health: row.connector_health,
    job_count: row.job_count,
    healthReasonCode: reason.code,
    healthReasonLabel: reason.label,
    warnings: deriveWarnings(latestRun),
  };
}

/** Answers: which ATS platforms have we actually encountered, which are supported vs blocked vs
 *  unresolved, and what/who is affected — built entirely from data already persisted by the
 *  discovery/scan pipeline. See src/app/ats-coverage/page.tsx for the one page that renders this. */
export function getAtsCoverageSummary(): AtsCoverageSummary {
  const rows = getDb().prepare(COMPANY_WITH_JOB_COUNT_SQL).all() as RawRow[];

  const supportedSourceTypes: Exclude<SourceType, "career_link">[] = [
    "greenhouse", "ashby", "lever", "workday", "smartrecruiters", "adp_wfn", "adp_rm", "eightfold", "cornerstone", "avature", "paylocity", "icims", "ukg_pro", "bamboohr", "oracle_recruiting_cloud", "workable", "rippling", "paycom", "jazzhr", "jobvite", "breezy", "teamtailor", "applicantpro", "pinpoint", "clearcompany", "personio", "applicantstack", "comeet", "cats", "gohire", "newton", "silkroad", "jobdiva", "taleo", "successfactors",
  ];
  const supported: SupportedAtsGroup[] = supportedSourceTypes
    .map((sourceType) => {
      const group = rows.filter((r) => r.source_type === sourceType);
      const companies = group.map(toCoverageCompany);
      const reasonBreakdown: Partial<Record<HealthReasonCode, number>> = {};
      const warningBreakdown: Partial<Record<AtsCoverageWarningCode, number>> = {};
      for (const company of companies) {
        reasonBreakdown[company.healthReasonCode] = (reasonBreakdown[company.healthReasonCode] ?? 0) + 1;
        for (const warning of company.warnings) {
          warningBreakdown[warning.code] = (warningBreakdown[warning.code] ?? 0) + 1;
        }
      }
      return {
        sourceType,
        companyCount: group.length,
        jobCount: group.reduce((sum, r) => sum + r.job_count, 0),
        healthyCount: group.filter((r) => r.connector_health === "healthy").length,
        degradedCount: group.filter((r) => r.connector_health === "degraded").length,
        downCount: group.filter((r) => r.connector_health === "down").length,
        reasonBreakdown,
        warningBreakdown,
        companies,
      };
    })
    .filter((g) => g.companyCount > 0);

  const needsAdapterRows = rows.filter((r) => r.resolution_status === "NEEDS_ADAPTER");
  const needsAdapterByPlatform = new Map<string, RawRow[]>();
  for (const row of needsAdapterRows) {
    const key = row.suspected_ats ?? "Unrecognized platform (no name captured)";
    const list = needsAdapterByPlatform.get(key) ?? [];
    list.push(row);
    needsAdapterByPlatform.set(key, list);
  }
  const needsAdapter: NeedsAdapterGroup[] = Array.from(needsAdapterByPlatform.entries())
    .map(([suspectedAts, group]) => ({
      suspectedAts,
      companyCount: group.length,
      companies: group.map(toCoverageCompany),
    }))
    .sort((a, b) => b.companyCount - a.companyCount);

  const generic = rows.filter((r) => r.resolution_status === "GENERIC_SUPPORTED").map(toCoverageCompany);
  const unresolved = rows
    .filter((r) => r.resolution_status === "UNRESOLVED" || r.resolution_status === "FAILED_TEMPORARY")
    .map(toCoverageCompany);

  return {
    supported,
    needsAdapter,
    generic,
    unresolved,
    totals: {
      companies: rows.length,
      supported: supported.reduce((sum, g) => sum + g.companyCount, 0),
      needsAdapter: needsAdapterRows.length,
      generic: generic.length,
      unresolved: unresolved.length,
    },
  };
}
