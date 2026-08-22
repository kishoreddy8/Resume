import { getDb } from "@/db";
import { getScanningWindowSummary, getLatestScanActivity, type WindowKey, WINDOW_DAYS } from "@/db/queries/operations";
import { getAppSettings } from "@/db/queries/settings";
import { getLoadedResumeWriterRuntimeContract, type ResumeWriterRuntimeContract } from "@/lib/resumeQuality/runtimeContract";
import { getResumeWriterHealth } from "@/lib/resumeQuality/writers/writerHealth";
import { readBackgroundWorkerStatus, type BackgroundWorkerStatus } from "@/lib/scheduler/workerStatus";

export interface RuntimeCompatibility {
  state: "MATCH" | "MISMATCH" | "UNKNOWN";
  detail: string;
}

export function compareRuntimeVersions(
  web: ResumeWriterRuntimeContract,
  worker: Pick<BackgroundWorkerStatus, "running" | "sourceRevision" | "contractVersion">
): RuntimeCompatibility {
  if (!worker.running) return { state: "UNKNOWN", detail: "The worker is offline; compatibility cannot be verified." };
  if (!worker.sourceRevision || !worker.contractVersion) {
    return { state: "UNKNOWN", detail: "The running worker has not reported a runtime fingerprint." };
  }
  if (worker.sourceRevision !== web.sourceRevision || worker.contractVersion !== web.contractVersion) {
    return { state: "MISMATCH", detail: "The workflow producer and writer runtime do not match. Writer processing is fail-closed." };
  }
  return { state: "MATCH", detail: "Web and worker source revisions and contracts match." };
}

function groupedCounts(table: "resume_quality_workflows" | "application_runs"): Record<string, number> {
  const rows = getDb().prepare(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`).all() as Array<{ status: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function countCompanies(): { total: number; active: number } {
  return getDb().prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active FROM companies").get() as { total: number; active: number };
}

function countRecentJobs(windowDays: number): number {
  return (getDb().prepare("SELECT COUNT(*) AS count FROM jobs WHERE julianday('now') - julianday(first_seen_at) <= ?").get(windowDays) as { count: number }).count;
}

function recentFailures(limit = 8): Array<{ source: string; id: number; status: string; detail: string | null; occurredAt: string }> {
  return getDb().prepare(
    `SELECT source, id, status, detail, occurredAt FROM (
       SELECT 'Scanner' AS source, id, status, error_message AS detail, COALESCE(finished_at, started_at) AS occurredAt
       FROM scan_runs WHERE status IN ('failed', 'partial')
       UNION ALL
       SELECT 'Resume Writer', id, status, failure_reason, updated_at
       FROM resume_quality_workflows WHERE status = 'FAILED'
       UNION ALL
       SELECT 'Applications', id, status, blocking_reason, updated_at
       FROM application_runs WHERE status IN ('FAILED', 'SUBMISSION_UNCONFIRMED')
     ) ORDER BY julianday(occurredAt) DESC LIMIT ?`
  ).all(limit) as Array<{ source: string; id: number; status: string; detail: string | null; occurredAt: string }>;
}

export function getAdminOverview(window: WindowKey) {
  const windowDays = WINDOW_DAYS[window];
  const settings = getAppSettings();
  const writer = getResumeWriterHealth();
  const worker = readBackgroundWorkerStatus();
  const webRuntime = getLoadedResumeWriterRuntimeContract();
  const runtimeCompatibility = compareRuntimeVersions(webRuntime, worker);
  const workflows = groupedCounts("resume_quality_workflows");
  const applications = groupedCounts("application_runs");
  const scanning = getScanningWindowSummary(windowDays);

  return {
    generatedAt: new Date().toISOString(), window,
    health: {
      system: runtimeCompatibility.state === "MISMATCH" ? "VERSION_MISMATCH" : worker.running ? "HEALTHY" : "DEGRADED",
      scanner: scanning.failedCount > 0 ? "DEGRADED" : settings.scheduler.scanEnabled ? "HEALTHY" : "DISABLED",
      writer: writer.state,
      applications: (applications.FAILED ?? 0) > 0 ? "DEGRADED" : "HEALTHY",
      runtimeCompatibility,
    },
    runtime: { web: webRuntime, worker }, writer,
    scanning: { summary: scanning, latest: getLatestScanActivity() },
    companies: countCompanies(), jobsDiscovered: countRecentJobs(windowDays), workflows, applications,
    recentFailures: recentFailures(),
  };
}
