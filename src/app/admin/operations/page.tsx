"use client";

import { useCallback, useEffect, useState } from "react";
import { LoadingRegion, PageHeader, SkeletonRows, Status, Surface, type StatusTone } from "@/components/ui";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import { MorningReadinessSection } from "./MorningReadinessSection";

/**
 * Phase 4 Stage 6 — read-only Operations & Automation Health Dashboard. Fetches one coherent
 * payload from GET /api/operations (see that route's own doc comment for the exact contract) and
 * renders it. This page never triggers a scan/match/rematch/notification/tailoring run — Refresh
 * re-fetches the SAME read-only endpoint, nothing more.
 */

type HealthStatus = "HEALTHY" | "WARNING" | "ERROR" | "DISABLED" | "NO_DATA";
type WindowKey = "24h" | "7d" | "30d";

interface OperationsResponse {
  generatedAt: string;
  window: WindowKey;
  candidateId: number;
  overview: {
    scheduler: HealthStatus;
    scanning: HealthStatus;
    connectors: HealthStatus;
    matching: HealthStatus;
    notifications: HealthStatus;
    resumePipeline: HealthStatus;
    lastActivity: string | null;
    lastSuccessfulScheduledScan: string | null;
  };
  scheduler: {
    settings: {
      enabled: boolean;
      scanEnabled: boolean;
      productionEnabled: boolean;
      evaluationEnabled: boolean;
      writerEnabled: boolean;
      intervalMinutes: number;
      windowStartHour: number;
      windowEndHour: number;
      timezone: string;
    };
    runtime: { lastStartedAt: string | null; lastCompletedAt: string | null; lastSuccessfulAt: string | null; lastFailedAt: string | null; lastError: string | null };
    lock: { held: boolean; acquiredAt: string | null; stale: boolean };
    nextEligibleRunAt: string | null;
    health: HealthStatus;
  };
  backgroundWorker: {
    running: boolean;
    schedulerHost: string;
    schedulerHostDescription: string;
    pid: number | null;
    startedAt: string | null;
    lastStatusAt: string | null;
    currentActivity: string | null;
    heavySlotHeldBy: string | null;
    ticks: Record<string, { running: boolean; startedAt: string | null; lastCompletedAt: string | null; lastDurationMs: number | null }> | null;
    detail: string;
  } | null;
  resumeWriter: {
    state: string;
    detail: string;
    schedulerEnabled: boolean;
    withinWindow: boolean;
    intervalMinutes: number;
    batchSize: number;
    pendingWorkflowCount: number;
    lastTickAt: string | null;
    lastPassCompletedAt: string | null;
    lastPassOutcome: string | null;
    lastPassError: string | null;
    nextAttemptAt: string | null;
  } | null;
  scanning: {
    window: {
      runs: number; successCount: number; partialCount: number; failedCount: number; companiesScanned: number;
      jobsAdded: number; jobsUpdated: number; jobsUnchanged: number; duplicatesSkipped: number; jobsClosed: number;
      jobsArchived: number; descriptionFailures: number; retryCount: number;
    };
    latest: { startedAt: string; finishedAt: string; status: string } | null;
    health: HealthStatus;
  };
  connectors: {
    summary: { healthy: number; degraded: number; down: number; unknown: number };
    topFailing: { id: number; name: string; sourceType: string; consecutiveFailures: number; connectorHealth: string; lastErrorCategory: string | null; lastErrorMessage: string | null }[];
    health: HealthStatus;
  };
  matching: {
    global: { window: { runs: number; jobsEvaluated: number; jobsBlocked: number; jobsNeedsReview: number; jobsReady: number; jobsErrored: number }; health: HealthStatus };
    candidate: { readyForTailoring: number; needsReview: number; blocked: number };
    cacheVisibility: { historicalCacheHitDataAvailable: boolean; note: string };
  };
  notifications: {
    candidate: { total: number; unread: number; read: number; createdInWindow: number };
    recent: { id: number; dedupeKey: string; type: string; title: string; createdAt: string; readAt: string | null }[];
    health: HealthStatus;
  };
  rematching: {
    recentMatchRuns: { id: number; started_at: string; finished_at: string; jobs_evaluated: number; jobs_blocked: number; jobs_needs_review: number; jobs_ready: number; jobs_errored: number }[];
    provenanceLimitation: string;
  };
  resumeQuality: {
    candidate: {
      tailoringRunsTotal: number;
      workflowsByStatus: Record<string, number>;
      failedEarly: number;
      failedMaxIterations: number;
      readyOnFirstIteration: number;
      readyRequiredImprovement: number;
      averageFinalQualityScore: number | null;
      averageIterationsToReady: number | null;
    };
    health: HealthStatus;
  };
  applications: {
    candidate: { new: number; interested: number; applied: number; interviewing: number; offer: number; employerRejected: number; readyToApply: number };
  };
}

/* NO_DATA maps to `unknown`, not to a neutral grey: across this application "we have not measured
 * this" is a distinct state from "measured and idle", and the hollow dashed glyph is what carries
 * that distinction. DISABLED is genuinely neutral — it is off on purpose. */
const HEALTH_TONE: Record<HealthStatus, StatusTone> = {
  HEALTHY: "ready",
  WARNING: "attention",
  ERROR: "blocked",
  DISABLED: "neutral",
  NO_DATA: "unknown",
};

function HealthBadge({ status }: { status: HealthStatus }) {
  return <Status tone={HEALTH_TONE[status]}>{status.replace("_", " ").toLowerCase()}</Status>;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatScore(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

function SectionCard({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Surface level="z3" as="section" className="rounded-[var(--radius-xl)] px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">{title}</h2>
        {right}
      </div>
      {children}
    </Surface>
  );
}

/* Local to this page: values arrive pre-formatted as strings ("never", "—", "12.4"), so this
 * renders them verbatim rather than going through the shared Metric's null-to-em-dash handling. */
function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">{label}</div>
      <div className="mt-1 truncate text-[17px] font-semibold leading-none tabular-nums tracking-[-0.02em] text-primary">
        {value}
      </div>
    </div>
  );
}

const WINDOW_OPTIONS: { key: WindowKey; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

export default function OperationsPage() {
  const candidateId = useActiveCandidateId();
  const [window_, setWindow] = useState<WindowKey>("24h");
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/operations?candidateId=${candidateId}&window=${window_}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Request failed (${res.status})`);
        setData(null);
        return;
      }
      setData(await res.json());
      setLastRefreshed(new Date());
    } finally {
      setLoading(false);
    }
  }, [candidateId, window_]);

  useEffect(() => {
    // Intentional: fetch-on-mount/dependency-change with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="System Operations"
        description={`JobHunt' own health — schedulers, workers, queues and engines. Last refreshed: ${
          lastRefreshed ? lastRefreshed.toLocaleTimeString() : "—"
        }`}
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex items-center gap-2">
          {/* Same segmented capsule the Jobs command bar uses, so a window switch reads the same
           *  way a view switch does. */}
          <div className="flex items-center rounded-[9px] bg-[var(--z0-bg)] p-[3px] shadow-[inset_0_1px_2px_var(--edge-lo)]">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setWindow(opt.key)}
                aria-pressed={window_ === opt.key}
                className={`rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors duration-150 ease-out ${
                  window_ === opt.key
                    ? "bg-[var(--z3-bg)] text-primary shadow-[var(--lift-1),inset_0_1px_0_var(--edge-hi)]"
                    : "text-tertiary hover:text-primary"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={load}
            className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-[12px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98]"
          >
            Refresh
          </button>
        </div>
      </div>

      <MorningReadinessSection />

      {error && (
        <div className="rounded-md border border-[var(--error)]/35 bg-[color-mix(in_oklab,var(--error)_8%,transparent)] px-3 py-2.5 text-[12.5px] text-[var(--error)]">
          {error}
        </div>
      )}

      {loading && !data ? (
        <>
          <LoadingRegion label="Loading operations" />
          <Surface level="z3" className="rounded-[var(--radius-xl)] p-5">
            <SkeletonRows rows={8} />
          </Surface>
        </>
      ) : data ? (
        <>
          <SectionCard title="System health overview">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
              {(
                [
                  ["Scheduler", data.overview.scheduler],
                  ["Scanning", data.overview.scanning],
                  ["Connectors", data.overview.connectors],
                  ["Matching", data.overview.matching],
                  ["Notifications", data.overview.notifications],
                  ["Resume Pipeline", data.overview.resumePipeline],
                ] as [string, HealthStatus][]
              ).map(([label, status]) => (
                <div key={label} className="flex flex-col items-start gap-1 rounded border border-zinc-200 p-2 dark:border-zinc-800">
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
                  <HealthBadge status={status} />
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-6 text-xs text-zinc-500">
              <span>Last activity: {formatTimestamp(data.overview.lastActivity)}</span>
              <span>Last successful scheduled scan: {formatTimestamp(data.overview.lastSuccessfulScheduledScan)}</span>
            </div>
          </SectionCard>

          <SectionCard title="Scheduler" right={<HealthBadge status={data.scheduler.health} />}>
            {/* Stage 27 — the master switch and the four per-tick switches together. A tick runs only
                when BOTH are on, so showing them separately is what makes "automation is on but the
                writer is deliberately off" legible instead of looking like a fault. */}
            <div className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Metric label="Automation (master)" value={data.scheduler.settings.enabled ? "On" : "Off"} />
              <Metric
                label="Scan"
                value={!data.scheduler.settings.enabled ? "Off (master)" : data.scheduler.settings.scanEnabled ? "On" : "Off"}
              />
              <Metric
                label="Ingestion"
                value={!data.scheduler.settings.enabled ? "Off (master)" : data.scheduler.settings.productionEnabled ? "On" : "Off"}
              />
              <Metric
                label="Evaluation"
                value={!data.scheduler.settings.enabled ? "Off (master)" : data.scheduler.settings.evaluationEnabled ? "On" : "Off"}
              />
              <Metric
                label="Resume writer"
                value={!data.scheduler.settings.enabled ? "Off (master)" : data.scheduler.settings.writerEnabled ? "On" : "Off"}
              />
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Metric label="Enabled" value={data.scheduler.settings.enabled ? "Yes" : "No"} />
              <Metric label="Interval" value={`${data.scheduler.settings.intervalMinutes} min`} />
              <Metric
                label="Window"
                value={`${data.scheduler.settings.windowStartHour}:00–${data.scheduler.settings.windowEndHour}:00`}
              />
              <Metric label="Timezone" value={data.scheduler.settings.timezone} />
              <Metric label="Last started" value={formatTimestamp(data.scheduler.runtime.lastStartedAt)} />
              <Metric label="Last completed" value={formatTimestamp(data.scheduler.runtime.lastCompletedAt)} />
              <Metric label="Last successful" value={formatTimestamp(data.scheduler.runtime.lastSuccessfulAt)} />
              <Metric label="Last failed" value={formatTimestamp(data.scheduler.runtime.lastFailedAt)} />
              <Metric label="Lock" value={data.scheduler.lock.held ? `Held since ${formatTimestamp(data.scheduler.lock.acquiredAt)}` : "Free"} />
              <Metric label="Next eligible run" value={formatTimestamp(data.scheduler.nextEligibleRunAt)} />
            </div>
            {data.scheduler.runtime.lastError && (
              <div className="mt-3 rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-400">
                Last error: {data.scheduler.runtime.lastError}
              </div>
            )}
          </SectionCard>

          {/* Stage 29 — what the background worker is doing right now. Every value comes from the
              worker's own status file; when it is not running this says so rather than guessing. */}
          {data.backgroundWorker && (
            <SectionCard title="Background worker">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Metric label="Worker" value={data.backgroundWorker.running ? "RUNNING" : "STOPPED"} />
                <Metric label="Scheduler host" value={data.backgroundWorker.schedulerHost} />
                <Metric
                  label="Current activity"
                  value={(data.backgroundWorker.currentActivity ?? "—").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()}
                />
                <Metric label="Heavy slot" value={data.backgroundWorker.heavySlotHeldBy ?? "free"} />
                <Metric label="PID" value={data.backgroundWorker.pid !== null ? String(data.backgroundWorker.pid) : "—"} />
                <Metric label="Started" value={formatTimestamp(data.backgroundWorker.startedAt)} />
                <Metric label="Last status" value={formatTimestamp(data.backgroundWorker.lastStatusAt)} />
                <Metric label="Writer queue" value={`${data.resumeWriter?.pendingWorkflowCount ?? 0} pending · concurrency 1`} />
              </div>
              {data.backgroundWorker.ticks && (
                <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {Object.entries(data.backgroundWorker.ticks).map(([name, tick]) => (
                    <Metric
                      key={name}
                      label={name.replace(/([a-z])([A-Z])/g, "$1 $2")}
                      value={
                        tick.running
                          ? `running since ${formatTimestamp(tick.startedAt)}`
                          : tick.lastCompletedAt
                          ? `idle · last ${formatTimestamp(tick.lastCompletedAt)}${tick.lastDurationMs !== null ? ` (${Math.round(tick.lastDurationMs / 1000)}s)` : ""}`
                          : "idle"
                      }
                    />
                  ))}
                </div>
              )}
              <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">{data.backgroundWorker.detail}</p>
              <p className="mt-1 text-[11px] text-zinc-500">{data.backgroundWorker.schedulerHostDescription}</p>
            </SectionCard>
          )}

          {/* Stage 27 — one place that answers "is approved tailoring actually moving, and if not,
              why?". Every value is read from the writer's own lease/tick/last-pass record, never
              inferred from a workflow status. */}
          {data.resumeWriter && (
            <SectionCard title="Resume writer">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Metric label="State" value={data.resumeWriter.state.replace(/_/g, " ")} />
                <Metric label="Approved & queued" value={String(data.resumeWriter.pendingWorkflowCount)} />
                <Metric label="Cadence" value={`every ${data.resumeWriter.intervalMinutes} min · ${data.resumeWriter.batchSize} per pass`} />
                <Metric label="Within window" value={data.resumeWriter.withinWindow ? "Yes" : "No"} />
                <Metric label="Last scheduler tick" value={formatTimestamp(data.resumeWriter.lastTickAt)} />
                <Metric label="Last pass completed" value={formatTimestamp(data.resumeWriter.lastPassCompletedAt)} />
                <Metric label="Last pass outcome" value={data.resumeWriter.lastPassOutcome ?? "—"} />
                <Metric label="Next attempt" value={formatTimestamp(data.resumeWriter.nextAttemptAt)} />
              </div>
              <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">{data.resumeWriter.detail}</p>
              {data.resumeWriter.lastPassError && (
                <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-400">
                  Last writer error: {data.resumeWriter.lastPassError}
                </div>
              )}
            </SectionCard>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <SectionCard title={`Scanning (${data.window})`} right={<HealthBadge status={data.scanning.health} />}>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Metric label="Sources scanned" value={data.scanning.window.companiesScanned} />
                <Metric label="Runs" value={data.scanning.window.runs} />
                <Metric label="Success / Partial / Failed" value={`${data.scanning.window.successCount} / ${data.scanning.window.partialCount} / ${data.scanning.window.failedCount}`} />
                <Metric label="Jobs added" value={data.scanning.window.jobsAdded} />
                <Metric label="Jobs updated" value={data.scanning.window.jobsUpdated} />
                <Metric label="Jobs unchanged" value={data.scanning.window.jobsUnchanged} />
                <Metric label="Duplicates skipped" value={data.scanning.window.duplicatesSkipped} />
                <Metric label="Closed / Archived" value={`${data.scanning.window.jobsClosed} / ${data.scanning.window.jobsArchived}`} />
                <Metric label="Description failures" value={data.scanning.window.descriptionFailures} />
                <Metric label="Retries" value={data.scanning.window.retryCount} />
              </div>
              <div className="mt-3 text-xs text-zinc-500">
                Most recent scan activity: {data.scanning.latest ? `${data.scanning.latest.status} — ${formatTimestamp(data.scanning.latest.startedAt)}` : "never"}
              </div>
            </SectionCard>

            <SectionCard title="Connector health" right={<HealthBadge status={data.connectors.health} />}>
              <div className="grid grid-cols-4 gap-3">
                <Metric label="Healthy" value={data.connectors.summary.healthy} />
                <Metric label="Degraded" value={data.connectors.summary.degraded} />
                <Metric label="Down" value={data.connectors.summary.down} />
                <Metric label="Unknown" value={data.connectors.summary.unknown} />
              </div>
              {data.connectors.topFailing.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-zinc-500">
                      <tr>
                        <th className="py-1 pr-2 font-medium">Company</th>
                        <th className="py-1 pr-2 font-medium">Source</th>
                        <th className="py-1 pr-2 font-medium">Failures</th>
                        <th className="py-1 font-medium">Last error</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {data.connectors.topFailing.map((c) => (
                        <tr key={c.id}>
                          <td className="py-1 pr-2">{c.name}</td>
                          <td className="py-1 pr-2 text-zinc-500">{c.sourceType}</td>
                          <td className="py-1 pr-2 font-medium text-red-600 dark:text-red-400">{c.consecutiveFailures}</td>
                          <td className="py-1 text-zinc-500">{c.lastErrorCategory ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <SectionCard title={`Matching (${data.window})`} right={<HealthBadge status={data.matching.global.health} />}>
              <div className="mb-3">
                <div className="mb-1 text-xs font-medium text-zinc-500">Pipeline-wide activity (all candidates)</div>
                <div className="grid grid-cols-3 gap-3">
                  <Metric label="Runs" value={data.matching.global.window.runs} />
                  <Metric label="Jobs evaluated" value={data.matching.global.window.jobsEvaluated} />
                  <Metric label="Errored" value={data.matching.global.window.jobsErrored} />
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-zinc-500">Current candidate — active matches</div>
                <div className="grid grid-cols-3 gap-3">
                  <Metric label="Ready for Tailoring" value={data.matching.candidate.readyForTailoring} />
                  <Metric label="Needs Review" value={data.matching.candidate.needsReview} />
                  <Metric label="Blocked" value={data.matching.candidate.blocked} />
                </div>
              </div>
              <div className="mt-3 rounded bg-zinc-50 p-2 text-[11px] text-zinc-500 dark:bg-zinc-800/60">
                {data.matching.cacheVisibility.note}
              </div>
            </SectionCard>

            <SectionCard title="Notifications" right={<HealthBadge status={data.notifications.health} />}>
              <div className="grid grid-cols-4 gap-3">
                <Metric label="Total" value={data.notifications.candidate.total} />
                <Metric label="Unread" value={data.notifications.candidate.unread} />
                <Metric label="Read" value={data.notifications.candidate.read} />
                <Metric label={`New in ${data.window}`} value={data.notifications.candidate.createdInWindow} />
              </div>
              {data.notifications.recent.length > 0 && (
                <ul className="mt-3 divide-y divide-zinc-100 text-xs dark:divide-zinc-800">
                  {data.notifications.recent.map((n) => (
                    <li key={n.id} className="flex items-center justify-between py-1.5">
                      <span className={n.readAt ? "text-zinc-500" : "font-medium"}>{n.title}</span>
                      <span className="text-zinc-400">{formatTimestamp(n.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>

          <SectionCard title="Candidate rematching (Stage 5)">
            <div className="mb-3 rounded bg-zinc-50 p-2 text-[11px] text-zinc-500 dark:bg-zinc-800/60">
              {data.rematching.provenanceLimitation}
            </div>
            {data.rematching.recentMatchRuns.length === 0 ? (
              <div className="text-xs text-zinc-500">No match_runs recorded yet for this candidate.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-zinc-500">
                    <tr>
                      <th className="py-1 pr-2 font-medium">Started</th>
                      <th className="py-1 pr-2 font-medium">Evaluated</th>
                      <th className="py-1 pr-2 font-medium">Ready</th>
                      <th className="py-1 pr-2 font-medium">Needs Review</th>
                      <th className="py-1 pr-2 font-medium">Blocked</th>
                      <th className="py-1 font-medium">Errored</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {data.rematching.recentMatchRuns.map((run) => (
                      <tr key={run.id}>
                        <td className="py-1 pr-2 text-zinc-500">{formatTimestamp(run.started_at)}</td>
                        <td className="py-1 pr-2">{run.jobs_evaluated}</td>
                        <td className="py-1 pr-2">{run.jobs_ready}</td>
                        <td className="py-1 pr-2">{run.jobs_needs_review}</td>
                        <td className="py-1 pr-2">{run.jobs_blocked}</td>
                        <td className="py-1">{run.jobs_errored}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <div className="grid gap-4 md:grid-cols-2">
            <SectionCard title="Resume Quality Pipeline" right={<HealthBadge status={data.resumeQuality.health} />}>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Metric label="Tailoring runs started" value={data.resumeQuality.candidate.tailoringRunsTotal} />
                <Metric label="READY" value={data.resumeQuality.candidate.workflowsByStatus.READY ?? 0} />
                <Metric label="Improvement running" value={data.resumeQuality.candidate.workflowsByStatus.IMPROVEMENT_RUNNING ?? 0} />
                <Metric label="Failed (early)" value={data.resumeQuality.candidate.failedEarly} />
                <Metric label="Failed (max iterations / human review)" value={data.resumeQuality.candidate.failedMaxIterations} />
                <Metric label="Avg final quality score" value={formatScore(data.resumeQuality.candidate.averageFinalQualityScore)} />
                <Metric label="Avg iterations to READY" value={formatScore(data.resumeQuality.candidate.averageIterationsToReady)} />
                <Metric label="READY on iteration 1" value={data.resumeQuality.candidate.readyOnFirstIteration} />
                <Metric label="READY, required improvement" value={data.resumeQuality.candidate.readyRequiredImprovement} />
              </div>
            </SectionCard>

            <SectionCard title="Application Lifecycle">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Metric label="New" value={data.applications.candidate.new} />
                <Metric label="Interested" value={data.applications.candidate.interested} />
                <Metric label="Ready to Apply" value={data.applications.candidate.readyToApply} />
                <Metric label="Applied" value={data.applications.candidate.applied} />
                <Metric label="Interviewing" value={data.applications.candidate.interviewing} />
                <Metric label="Offer" value={data.applications.candidate.offer} />
                <Metric label="Employer Rejected" value={data.applications.candidate.employerRejected} />
              </div>
            </SectionCard>
          </div>
        </>
      ) : null}
    </div>
  );
}
