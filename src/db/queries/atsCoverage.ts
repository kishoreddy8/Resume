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
}

/**
 * Deterministic, read-time-derived reason a company has its current connector_health — built only
 * from columns the scan pipeline already writes (src/db/queries/companies.ts's recordScanSuccess/
 * recordScanPartial/recordScanFailure). No new table, no invented category: TRANSIENT_FAILURE and
 * REPEATED_FAILURES both come from a genuinely thrown scan error (last_error_category is non-null
 * only on that path); PARTIAL_DATA_QUALITY comes from a real per-job description/location problem
 * found during a scan that otherwise completed (see src/lib/scan.ts's determineScanStatus call —
 * sample/verification-scan mode no longer contributes to this on its own, see that file's comment).
 */
export type HealthReasonCode =
  | "HEALTHY"
  | "NEVER_SCANNED"
  | "REPEATED_FAILURES"
  | "TRANSIENT_FAILURE"
  | "PARTIAL_DATA_QUALITY"
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
    return { code: "PARTIAL_DATA_QUALITY", label: row.last_error_message };
  }
  return { code: "UNCLASSIFIED", label: "Marked degraded, but no failure detail is on record" };
}

export interface SupportedAtsGroup {
  sourceType: Exclude<SourceType, "career_link">;
  companyCount: number;
  jobCount: number;
  healthyCount: number;
  degradedCount: number;
  downCount: number;
  reasonBreakdown: Partial<Record<HealthReasonCode, number>>;
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
    COALESCE(j.job_count, 0) AS job_count
  FROM companies c
  LEFT JOIN (
    SELECT company_id, COUNT(*) AS job_count
    FROM jobs
    WHERE is_active = 1
    GROUP BY company_id
  ) j ON j.company_id = c.id
  WHERE c.is_active = 1
`;

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
}

function toCoverageCompany(row: RawRow): AtsCoverageCompany {
  const reason = deriveHealthReason(row);
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
  };
}

/** Answers: which ATS platforms have we actually encountered, which are supported vs blocked vs
 *  unresolved, and what/who is affected — built entirely from data already persisted by the
 *  discovery/scan pipeline. See src/app/ats-coverage/page.tsx for the one page that renders this. */
export function getAtsCoverageSummary(): AtsCoverageSummary {
  const rows = getDb().prepare(COMPANY_WITH_JOB_COUNT_SQL).all() as RawRow[];

  const supportedSourceTypes: Exclude<SourceType, "career_link">[] = [
    "greenhouse", "ashby", "lever", "workday", "smartrecruiters", "adp_wfn", "adp_rm", "eightfold", "cornerstone", "avature", "paylocity", "icims", "ukg_pro", "bamboohr", "oracle_recruiting_cloud", "workable", "rippling", "paycom", "jazzhr", "jobvite", "breezy", "teamtailor", "applicantpro", "pinpoint", "clearcompany", "personio", "applicantstack", "comeet", "cats", "gohire", "newton", "silkroad", "jobdiva", "taleo",
  ];
  const supported: SupportedAtsGroup[] = supportedSourceTypes
    .map((sourceType) => {
      const group = rows.filter((r) => r.source_type === sourceType);
      const companies = group.map(toCoverageCompany);
      const reasonBreakdown: Partial<Record<HealthReasonCode, number>> = {};
      for (const company of companies) {
        reasonBreakdown[company.healthReasonCode] = (reasonBreakdown[company.healthReasonCode] ?? 0) + 1;
      }
      return {
        sourceType,
        companyCount: group.length,
        jobCount: group.reduce((sum, r) => sum + r.job_count, 0),
        healthyCount: group.filter((r) => r.connector_health === "healthy").length,
        degradedCount: group.filter((r) => r.connector_health === "degraded").length,
        downCount: group.filter((r) => r.connector_health === "down").length,
        reasonBreakdown,
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
