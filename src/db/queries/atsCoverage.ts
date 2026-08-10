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
}

export interface SupportedAtsGroup {
  sourceType: Exclude<SourceType, "career_link">;
  companyCount: number;
  jobCount: number;
  healthyCount: number;
  degradedCount: number;
  downCount: number;
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
    (SELECT COUNT(*) FROM jobs j WHERE j.company_id = c.id AND j.is_active = 1) AS job_count
  FROM companies c
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
  job_count: number;
}

function toCoverageCompany(row: RawRow): AtsCoverageCompany {
  return {
    id: row.id,
    name: row.name,
    resolution_status: row.resolution_status,
    suspected_ats: row.suspected_ats,
    discovery_reason: row.discovery_reason,
    discovery_attempted_at: row.discovery_attempted_at,
    connector_health: row.connector_health,
    job_count: row.job_count,
  };
}

/** Answers: which ATS platforms have we actually encountered, which are supported vs blocked vs
 *  unresolved, and what/who is affected — built entirely from data already persisted by the
 *  discovery/scan pipeline. See src/app/ats-coverage/page.tsx for the one page that renders this. */
export function getAtsCoverageSummary(): AtsCoverageSummary {
  const rows = getDb().prepare(COMPANY_WITH_JOB_COUNT_SQL).all() as RawRow[];

  const supportedSourceTypes: Exclude<SourceType, "career_link">[] = ["greenhouse", "ashby", "lever", "workday"];
  const supported: SupportedAtsGroup[] = supportedSourceTypes
    .map((sourceType) => {
      const group = rows.filter((r) => r.source_type === sourceType);
      return {
        sourceType,
        companyCount: group.length,
        jobCount: group.reduce((sum, r) => sum + r.job_count, 0),
        healthyCount: group.filter((r) => r.connector_health === "healthy").length,
        degradedCount: group.filter((r) => r.connector_health === "degraded").length,
        downCount: group.filter((r) => r.connector_health === "down").length,
        companies: group.map(toCoverageCompany),
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
