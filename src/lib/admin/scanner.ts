import { getDb } from "@/db";
import { getConnectorReliabilitySummary, getProviderHealthSummary } from "@/db/queries/reliability";
import { listPendingProposals } from "@/db/queries/atsSourceProposals";
import { getAppSettings } from "@/db/queries/settings";
import { getScanLockStatus } from "@/lib/scheduler/lock";
import { PROVIDER_LABELS } from "@/lib/ats/providerLabels";
import type { SourceType } from "@/types";

const NON_CONNECTOR_SOURCES = new Set<SourceType>(["career_link", "google_jobs", "indeed", "built_in"]);

export function getAdminScannerProjection(limit = 25) {
  const providerStats = new Map((getDb().prepare(
    `SELECT c.source_type AS provider,
            MAX(CASE WHEN sr.status = 'success' THEN sr.finished_at END) AS lastSuccess,
            MAX(CASE WHEN sr.status = 'failed' THEN sr.finished_at END) AS lastFailure,
            COALESCE(j.activeJobs, 0) AS activeJobs
     FROM companies c LEFT JOIN scan_runs sr ON sr.company_id = c.id
     LEFT JOIN (SELECT c2.source_type, COUNT(*) AS activeJobs FROM jobs j2 JOIN companies c2 ON c2.id = j2.company_id WHERE j2.is_active = 1 GROUP BY c2.source_type) j ON j.source_type = c.source_type
     WHERE c.source_type != 'career_link' GROUP BY c.source_type, j.activeJobs`
  ).all() as Array<{ provider: string; lastSuccess: string | null; lastFailure: string | null; activeJobs: number }>).map((row) => [row.provider, row]));
  const healthByProvider = new Map(getProviderHealthSummary().map((provider) => [provider.provider, provider]));
  const providers = (Object.keys(PROVIDER_LABELS) as SourceType[])
    .filter((provider) => !NON_CONNECTOR_SOURCES.has(provider))
    .map((provider) => {
      const health = healthByProvider.get(provider) ?? {
        provider,
        eligibleCompanies: 0,
        recentSuccessfulScans: 0,
        recentFailedScans: 0,
        successRate: null,
        recoveringCount: 0,
        needsReviewCount: 0,
        downCount: 0,
        healthyCount: 0,
      };
      const extra = providerStats.get(provider) ?? { lastSuccess: null, lastFailure: null, activeJobs: 0 };
      return {
        ...health,
        ...extra,
        label: PROVIDER_LABELS[provider],
        interventionState: health.downCount > 0
          ? "Needs intervention"
          : health.needsReviewCount > 0
            ? "Needs review"
            : health.recoveringCount > 0
              ? "Recovering"
              : health.eligibleCompanies > 0
                ? "Healthy"
                : "Not configured",
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const runs = getDb().prepare(
    `SELECT sr.id, c.name AS company, sr.provider, sr.started_at AS startedAt, sr.finished_at AS finishedAt,
            sr.duration_ms AS durationMs, sr.status, sr.jobs_discovered AS discovered, sr.jobs_added AS added,
            sr.jobs_updated AS updated, sr.jobs_closed AS closed, sr.error_category AS errorCategory,
            sr.error_message AS errorMessage
     FROM scan_runs sr JOIN companies c ON c.id = sr.company_id ORDER BY sr.id DESC LIMIT ?`
  ).all(Math.min(100, Math.max(1, limit)));
  const unresolvedCompanies = getDb().prepare(
    `SELECT id, name, career_page_url AS careerPageUrl, resolution_status AS resolutionStatus, suspected_ats AS suspectedAts
     FROM companies WHERE is_active = 1 AND resolution_status IN ('UNRESOLVED','NEEDS_ADAPTER','FAILED_TEMPORARY')
     ORDER BY name COLLATE NOCASE LIMIT 100`
  ).all();
  return { generatedAt: new Date().toISOString(), settings: getAppSettings().scheduler, lock: getScanLockStatus(), reliability: getConnectorReliabilitySummary(), providers, runs, proposals: listPendingProposals(50), unresolvedCompanies };
}
