import { getDb } from "@/db";
import { getScanningWindowSummary, getLatestScanActivity, type WindowKey, WINDOW_DAYS } from "@/db/queries/operations";
import { getApplicationsWindowSummary, type ApplicationsWindowSummary } from "@/db/queries/applicationRuns";
import { getAppSettings } from "@/db/queries/settings";
import { classifyScanningHealth, classifySystemHealth, type HealthStatus } from "@/lib/operations/healthRules";
import { getConfiguredSchedulerHost } from "@/lib/scheduler/host";
import { getSchedulerRuntimeState } from "@/lib/scheduler/state";
import {
  evaluateRuntimeFreshness,
  getLoadedResumeWriterRuntimeContract,
  type ResumeWriterRuntimeContract,
} from "@/lib/resumeQuality/runtimeContract";
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

/**
 * UI-0 DEFECT 7 — is the application engine healthy RIGHT NOW, within the selected window?
 *
 * Deliberately the same shape as `compareRuntimeVersions` above: a pure function of already-fetched
 * data, so it is testable without a database. Replaces `(applications.FAILED ?? 0) > 0` — an
 * unwindowed lifetime count that could never recover once a single run had ever failed. A failure
 * ages out of DEGRADED exactly when it ages out of `summary`'s window; a later successful run
 * within the same window does not, by itself, clear an UNRESOLVED failure that is also still
 * within the window — the window itself is what the operator controls (24h/7d/30d) to decide how
 * long a failure remains "recent" before it is spoken of only as history.
 */
export function applicationsHealth(summary: ApplicationsWindowSummary): HealthStatus {
  /* ADMIN-OPS-1.1 — THE CONTRACT, settled from the caller rather than from first principles.
   *
   * This value has exactly one consumer: a HealthTile labelled "Application Pipeline" inside
   * Admin's "Subsystem Health" grid (src/app/admin/page.tsx). It is therefore a claim about the
   * SUBSYSTEM — "is application automation working" — and NOT a claim about the candidate's queue
   * ("are there problems right now"). The distinction decides the empty-window case, and it is worth
   * being explicit about because the two readings give opposite answers:
   *
   *   subsystem reading  -> zero runs proves nothing about the engine        -> NO_DATA
   *   open-issues reading -> zero runs means zero problems                    -> HEALTHY
   *
   * The tile's own framing settles it: a green "Application Pipeline" card asserts the pipeline
   * works, and no run has been observed that could support that. ADMIN-OPS-1 reversed the original
   * HEALTHY behaviour on exactly this ground, and this is the same conclusion classifyScanningHealth
   * already reaches for an empty scan window. If a future Admin surface genuinely wants the
   * open-issues reading, it needs its own field — it must not be obtained by loosening this one. */
  if (summary.total === 0) return "NO_DATA";
  return summary.failedCount > 0 ? "WARNING" : "HEALTHY";
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
  // Phase K (advisory only — never a substitute for the per-workflow runtime_contract.json stamp/
  // assert cycle, which remains the sole real safety mechanism). compareRuntimeVersions above only
  // catches a MISMATCH between this web process and a separate standalone worker process; in the
  // common single-process "web" host mode there is no worker to compare against, so a web process
  // that has quietly gone stale relative to the currently checked-out repository was previously
  // invisible here until a real workflow's stamped contract revealed it after the fact.
  const runtimeFreshness = evaluateRuntimeFreshness(webRuntime);
  const workflows = groupedCounts("resume_quality_workflows");
  /* Lifetime breakdown by status — a separate, historical metric from the WINDOWED health verdict
   * below, and still returned as-is for the existing applications-by-status display. */
  const applications = groupedCounts("application_runs");
  const scanning = getScanningWindowSummary(windowDays);
  const applicationsWindow = getApplicationsWindowSummary(windowDays);
  const schedulerRuntime = getSchedulerRuntimeState();

  return {
    generatedAt: new Date().toISOString(), window,
    health: {
      /* ADMIN-OPS-1 — both verdicts below were derived from the wrong evidence and are now delegated
       * to the shared, unit-tested rules in src/lib/operations/healthRules.ts.
       *
       * `system` asked whether the standalone worker was running, but the default host runs ticks in
       * the web process where no worker exists — so a correct install reported DEGRADED forever.
       * It now asks whether the CONFIGURED host is alive.
       *
       * `scanner` consulted only `scanEnabled` and ignored `scheduler.enabled`, the master switch
       * that gates it — so a fully disabled scanner with no failures reported HEALTHY. It also had
       * no way to say "nothing ran in this window", which classifyScanningHealth already models. */
      system: classifySystemHealth({
        schedulerHost: getConfiguredSchedulerHost(),
        workerRunning: worker.running,
        workerEverReported: worker.pid !== null,
        lastEvaluatedAt: schedulerRuntime.lastEvaluatedAt,
        runtimeCompatibility: runtimeCompatibility.state,
      }),
      scanner: settings.scheduler.enabled && settings.scheduler.scanEnabled
        ? classifyScanningHealth({ window: scanning, schedulerEnabled: true })
        : "DISABLED",
      writer: writer.state,
      applications: applicationsHealth(applicationsWindow),
      runtimeCompatibility,
      runtimeFreshness,
    },
    runtime: { web: webRuntime, worker, freshness: runtimeFreshness }, writer,
    scanning: { summary: scanning, latest: getLatestScanActivity() },
    companies: countCompanies(), jobsDiscovered: countRecentJobs(windowDays), workflows, applications,
    recentFailures: recentFailures(),
  };
}
