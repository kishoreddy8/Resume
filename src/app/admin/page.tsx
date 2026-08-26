"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminLoadingState,
  AdminPageHeader,
  AdminStatus,
  HealthTile,
  InterventionList,
  OperationalTable,
  TechnicalDetails,
  TimeWindowControl,
} from "@/components/admin";
import { useAdminCandidate } from "@/lib/admin/AdminContext";
import { ADMIN_STATUS_PRESENTATION, normalizeAdminStatus } from "@/lib/admin/status";

type WindowKey = "24h" | "7d" | "30d";

type Overview = {
  generatedAt: string;
  health: {
    system: string;
    scanner: string;
    writer: string;
    applications: string;
    runtimeCompatibility: { state: string; detail: string };
    runtimeFreshness: {
      state: "CURRENT" | "STALE_PROCESS" | "UNKNOWN";
      loadedRevision: string;
      observedRevision: string;
      observedAt: string;
      detail: string;
    };
  };
  runtime: {
    web: { sourceRevision: string; contractVersion: string };
    worker: {
      pid: number | null;
      sourceRevision: string | null;
      contractVersion: string | null;
      currentActivity: string | null;
    };
    freshness: {
      state: "CURRENT" | "STALE_PROCESS" | "UNKNOWN";
      loadedRevision: string;
      observedRevision: string;
      observedAt: string;
      detail: string;
    };
  };
  writer: { state: string; pendingWorkflowCount: number };
  scanning: { summary: { runs: number; jobsAdded: number } };
  companies: { total: number; active: number };
  jobsDiscovered: number;
  applications: Record<string, number>;
  recentFailures: Array<{
    source: string;
    id: number;
    status: string;
    detail: string | null;
    occurredAt: string;
  }>;
};

function displayStatus(value: string): string {
  const map: Record<string, string> = {
    MATCH: "healthy",
    MISMATCH: "version_mismatch",
    VERSION_MISMATCH: "version_mismatch",
    HEALTHY: "healthy",
    DEGRADED: "degraded",
    DISABLED: "disabled",
    /* ADMIN-OPS-1 — the shared operational vocabulary (src/lib/operations/healthRules.ts) now backs
     * system/scanner/applications. Without these three entries those verdicts fell through to
     * "unknown", which would have drawn a genuine ERROR as a neutral gray card — a real failure
     * rendered as "nothing observed". NO_DATA legitimately maps to unknown: that IS the claim. */
    WARNING: "degraded",
    ERROR: "failed",
    NO_DATA: "unknown",
    PROCESSING: "running",
    IDLE: "idle",
    WAITING_FOR_NEXT_ATTEMPT: "queued",
    UNAVAILABLE_NOT_RUNNING: "offline",
    TECHNICAL_FAILURE: "failed",
    AUTH_REQUIRED: "needs_intervention",
    BLOCKED_MAX_ATTEMPTS: "needs_intervention",
    CURRENT: "healthy",
    STALE_PROCESS: "version_mismatch",
  };
  return map[value] ?? "unknown";
}

export default function AdminOverviewPage() {
  const { candidateId } = useAdminCandidate();
  const [timeWindow, setTimeWindow] = useState<WindowKey>("24h");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRefreshing(true);
      const response = await fetch(
        `/api/admin/overview?candidateId=${candidateId}&window=${timeWindow}`
      );
      if (!response.ok) {
        throw new Error((await response.json()).error ?? "Overview is unavailable");
      }
      setData(await response.json());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Overview is unavailable");
    } finally {
      setRefreshing(false);
    }
  }, [candidateId, timeWindow]);

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [load]);

  if (error && !data) {
    return (
      <AdminErrorState
        title="Overview unavailable"
        detail={error}
        retry={() => void load()}
      />
    );
  }

  if (!data) {
    return <AdminLoadingState label="Loading system overview and operational health" />;
  }

  const queueCount = data.writer.pendingWorkflowCount + (data.applications.QUEUED ?? 0);
  const runningCount =
    (data.applications.RUNNING ?? 0) + (data.health.writer === "PROCESSING" ? 1 : 0);

  const interventionItems = [
    ...(data.health.runtimeCompatibility.state === "MISMATCH"
      ? [
          {
            id: "runtime",
            title: "Version mismatch detected",
            detail: data.health.runtimeCompatibility.detail,
            status: "version_mismatch" as const,
            href: "/admin/operations",
          },
        ]
      : []),
    ...(data.health.runtimeFreshness.state === "STALE_PROCESS"
      ? [
          {
            id: "runtime-freshness",
            title: "Stale process — restart server before running writer",
            detail: data.health.runtimeFreshness.detail,
            status: "version_mismatch" as const,
            href: "/admin/operations",
          },
        ]
      : []),
    ...data.recentFailures.slice(0, 5).map((failure) => ({
      id: `${failure.source}-${failure.id}`,
      title: `${failure.source} #${failure.id}`,
      detail: failure.detail ?? failure.status,
      status: "failed" as const,
      meta: new Date(failure.occurredAt).toLocaleString(),
      href:
        failure.source.toLowerCase().includes("scan")
          ? "/admin/scanner?tab=history"
          : failure.source.toLowerCase().includes("writer")
          ? "/admin/writer"
          : "/admin/applications",
    })),
  ];

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="Operations Dashboard"
        title="System Overview"
        description="Real-time operational health, background worker activity, queue throughput, and operator interventions across CareerOps subsystems."
        statusSummary={
          <AdminStatus
            status={displayStatus(data.health.system)}
            /* ADMIN-OPS-1 — a raw enum ("NO_DATA") is not a sentence. The shared presentation map
             * already owns the candidate-facing wording for every status this can now be. */
            label={ADMIN_STATUS_PRESENTATION[normalizeAdminStatus(displayStatus(data.health.system))].label}
          />
        }
        actions={
          <div className="flex items-center gap-3">
            <TimeWindowControl
              value={timeWindow}
              options={[
                { value: "24h", label: "24 hours" },
                { value: "7d", label: "7 days" },
                { value: "30d", label: "30 days" },
              ]}
              onChange={setTimeWindow}
            />
            <button
              type="button"
              className="admin-button admin-button-secondary"
              disabled={refreshing}
              onClick={() => void load()}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        }
      />

      {data.health.runtimeCompatibility.state === "MISMATCH" && (
        <div className="admin-critical-banner" role="alert">
          <strong className="font-bold">Version mismatch:</strong>
          <span>{data.health.runtimeCompatibility.detail}</span>
        </div>
      )}

      {data.health.runtimeFreshness.state === "STALE_PROCESS" && (
        <div className="admin-critical-banner" role="alert">
          <strong className="font-bold">Stale process:</strong>
          <span>
            {data.health.runtimeFreshness.detail} Loaded revision:{" "}
            {data.health.runtimeFreshness.loadedRevision.slice(0, 12)} · Checked out revision:{" "}
            {data.health.runtimeFreshness.observedRevision.slice(0, 12)}.
          </span>
        </div>
      )}

      {/* Critical Health Grid */}
      <section aria-labelledby="health-heading">
        <h2 id="health-heading" className="admin-section-title">
          Subsystem Health
        </h2>
        <div className="admin-health-grid">
          <HealthTile
            label="Overall System"
            status={displayStatus(data.health.system)}
            value={queueCount + runningCount}
            detail={`${queueCount} queued · ${runningCount} active`}
            href="/admin/operations"
          />
          <HealthTile
            label="Job Discovery & Scanner"
            status={displayStatus(data.health.scanner)}
            value={data.scanning.summary.runs}
            detail={`${data.scanning.summary.jobsAdded.toLocaleString()} jobs added in window`}
            href="/admin/scanner"
          />
          <HealthTile
            label="Resume Studio Writer"
            status={displayStatus(data.writer.state)}
            value={data.writer.pendingWorkflowCount}
            detail="Tailoring workflows queued"
            href="/admin/writer"
          />
          <HealthTile
            label="Application Pipeline"
            status={displayStatus(data.health.applications)}
            value={data.applications.FAILED ?? 0}
            detail={`${data.applications.RUNNING ?? 0} running · ${data.applications.FAILED ?? 0} failed`}
            href="/admin/applications"
          />
          <HealthTile
            label="Runtime Compatibility"
            status={displayStatus(data.health.runtimeCompatibility.state)}
            detail={data.health.runtimeCompatibility.detail}
            href="/admin/operations"
          />
          <HealthTile
            label="Process Freshness"
            status={displayStatus(data.health.runtimeFreshness.state)}
            detail={
              data.health.runtimeFreshness.state === "UNKNOWN"
                ? "Status unknown"
                : data.health.runtimeFreshness.state === "CURRENT"
                ? "Codebase up to date"
                : "Restart recommended"
            }
            href="/admin/operations"
          />
        </div>
      </section>

      {/* Operations Quick Links */}
      <section aria-labelledby="consoles-heading">
        <h2 id="consoles-heading" className="admin-section-title">
          Subsystem Consoles
        </h2>
        <div className="admin-link-grid">
          <Link href="/admin/scanner" className="admin-card">
            <h2>Job Discovery & Scanner</h2>
            <p>Inspect ATS connectors, review source proposals, view run history, or trigger on-demand discovery scans.</p>
          </Link>
          <Link href="/admin/writer" className="admin-card">
            <h2>Resume Writer Operations</h2>
            <p>Monitor tailoring throughput, review provider/model execution, and diagnose tailoring queue blockers.</p>
          </Link>
          <Link href="/admin/applications" className="admin-card">
            <h2>Application Pipeline</h2>
            <p>Track multi-candidate application runs, inspect ATS stages, and unblock accounts needing intervention.</p>
          </Link>
        </div>
      </section>

      {/* Two Column: Interventions & Throughput */}
      <div className="admin-two-column">
        <section aria-labelledby="intervention-heading">
          <h2 id="intervention-heading" className="admin-section-title">
            Work Requiring Intervention
          </h2>
          {interventionItems.length > 0 ? (
            <InterventionList items={interventionItems} />
          ) : (
            <AdminEmptyState
              title="No intervention required"
              detail="All subsystems are running normally with no pending errors or version mismatches."
            />
          )}
        </section>

        <section aria-labelledby="throughput-heading">
          <h2 id="throughput-heading" className="admin-section-title">
            Queue and Throughput
          </h2>
          <div className="admin-operational-card">
            <dl className="admin-metric-list">
              <div>
                <dt>Queued Tasks</dt>
                <dd>{queueCount}</dd>
              </div>
              <div>
                <dt>Running Tasks</dt>
                <dd>{runningCount}</dd>
              </div>
              <div>
                <dt>Jobs Discovered</dt>
                <dd>{data.jobsDiscovered.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Active Companies</dt>
                <dd>
                  {data.companies.active} <span className="text-sm font-normal text-tertiary">/ {data.companies.total}</span>
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </div>

      {/* Recent Failures */}
      <section aria-labelledby="failures-heading">
        <h2 id="failures-heading" className="admin-section-title">
          Recent Failures
        </h2>
        {data.recentFailures.length > 0 ? (
          <OperationalTable label="Recent cross-service failures">
            <thead>
              <tr>
                <th>Service</th>
                <th>Item / Identifier</th>
                <th>Status</th>
                <th>Occurred At</th>
              </tr>
            </thead>
            <tbody>
              {data.recentFailures.map((failure) => (
                <tr key={`${failure.source}-${failure.id}`}>
                  <td className="font-semibold text-primary">{failure.source}</td>
                  <td>
                    <span className="font-mono font-medium">#{failure.id}</span>{" "}
                    <span className="text-secondary">{failure.detail ?? ""}</span>
                  </td>
                  <td>
                    <AdminStatus status="failed" label={failure.status} />
                  </td>
                  <td className="text-secondary">{new Date(failure.occurredAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </OperationalTable>
        ) : (
          <AdminEmptyState
            title="No recent failures"
            detail="No persisted scanner, writer, or application run errors recorded in this time window."
          />
        )}
      </section>

      {/* Technical Details */}
      <TechnicalDetails summary="Runtime & Process Details">
        <dl className="admin-technical-grid">
          <div>
            <dt>Web Process Revision</dt>
            <dd>{data.runtime.web.sourceRevision}</dd>
          </div>
          <div>
            <dt>Web Contract Version</dt>
            <dd>{data.runtime.web.contractVersion}</dd>
          </div>
          <div>
            <dt>Worker Process Revision</dt>
            <dd>{data.runtime.worker.sourceRevision ?? "Not reported / Offline"}</dd>
          </div>
          <div>
            <dt>Worker Contract Version</dt>
            <dd>{data.runtime.worker.contractVersion ?? "Not reported / Offline"}</dd>
          </div>
          <div>
            <dt>Worker Process ID (PID)</dt>
            <dd>{data.runtime.worker.pid ?? "Offline"}</dd>
          </div>
          <div>
            <dt>Worker Live Activity</dt>
            <dd>{data.runtime.worker.currentActivity ?? "Idle / No task"}</dd>
          </div>
          <div>
            <dt>Observed Disk Revision</dt>
            <dd>
              {data.runtime.freshness.state === "UNKNOWN"
                ? "Unknown"
                : data.runtime.freshness.observedRevision}
            </dd>
          </div>
          <div>
            <dt>Freshness Checked At</dt>
            <dd>
              {data.runtime.freshness.state === "UNKNOWN"
                ? "Unknown"
                : new Date(data.runtime.freshness.observedAt).toLocaleString()}
            </dd>
          </div>
        </dl>
      </TechnicalDetails>

      <p className="admin-updated-at">
        Snapshot generated at {new Date(data.generatedAt).toLocaleTimeString()} ·{" "}
        <Link href="/admin/activity">View persistent activity log →</Link>
      </p>
    </div>
  );
}
