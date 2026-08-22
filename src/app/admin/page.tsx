"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminEmptyState, AdminErrorState, AdminLoadingState, AdminPageHeader, AdminStatus, HealthTile, InterventionList, OperationalTable, TechnicalDetails, TimeWindowControl } from "@/components/admin";
import { useAdminCandidate } from "@/lib/admin/AdminContext";

type WindowKey = "24h" | "7d" | "30d";
type Overview = {
  generatedAt: string;
  health: { system: string; scanner: string; writer: string; applications: string; runtimeCompatibility: { state: string; detail: string }; runtimeFreshness: { state: "CURRENT" | "STALE_PROCESS" | "UNKNOWN"; loadedRevision: string; observedRevision: string; observedAt: string; detail: string } };
  runtime: { web: { sourceRevision: string; contractVersion: string }; worker: { pid: number | null; sourceRevision: string | null; contractVersion: string | null; currentActivity: string | null }; freshness: { state: "CURRENT" | "STALE_PROCESS" | "UNKNOWN"; loadedRevision: string; observedRevision: string; observedAt: string; detail: string } };
  writer: { state: string; pendingWorkflowCount: number };
  scanning: { summary: { runs: number; jobsAdded: number } };
  companies: { total: number; active: number };
  jobsDiscovered: number;
  applications: Record<string, number>;
  recentFailures: Array<{ source: string; id: number; status: string; detail: string | null; occurredAt: string }>;
};

function displayStatus(value: string): string {
  const map: Record<string, string> = { MATCH: "healthy", MISMATCH: "version_mismatch", VERSION_MISMATCH: "version_mismatch", HEALTHY: "healthy", DEGRADED: "degraded", DISABLED: "disabled", PROCESSING: "running", IDLE: "idle", WAITING_FOR_NEXT_ATTEMPT: "queued", UNAVAILABLE_NOT_RUNNING: "offline", TECHNICAL_FAILURE: "failed", AUTH_REQUIRED: "needs_intervention", BLOCKED_MAX_ATTEMPTS: "needs_intervention", CURRENT: "healthy", STALE_PROCESS: "version_mismatch" };
  return map[value] ?? "unknown";
}

export default function AdminOverviewPage() {
  const { candidateId } = useAdminCandidate();
  const [timeWindow, setTimeWindow] = useState<WindowKey>("24h");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/overview?candidateId=${candidateId}&window=${timeWindow}`);
      if (!response.ok) throw new Error((await response.json()).error ?? "Overview is unavailable");
      setData(await response.json()); setError(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Overview is unavailable"); }
  }, [candidateId, timeWindow]);

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [load]);

  if (error && !data) return <AdminErrorState title="Overview unavailable" detail={error} retry={() => void load()} />;
  if (!data) return <AdminLoadingState label="Loading operational health" />;
  const queueCount = data.writer.pendingWorkflowCount + (data.applications.QUEUED ?? 0);
  const runningCount = (data.applications.RUNNING ?? 0) + (data.health.writer === "PROCESSING" ? 1 : 0);
  const interventionItems = [
    ...(data.health.runtimeCompatibility.state === "MISMATCH" ? [{ id: "runtime", title: "Version mismatch", detail: data.health.runtimeCompatibility.detail, status: "version_mismatch" as const }] : []),
    ...(data.health.runtimeFreshness.state === "STALE_PROCESS" ? [{ id: "runtime-freshness", title: "Stale process — restart before running the writer", detail: data.health.runtimeFreshness.detail, status: "version_mismatch" as const }] : []),
    ...data.recentFailures.slice(0, 5).map((failure) => ({ id: `${failure.source}-${failure.id}`, title: `${failure.source} #${failure.id}`, detail: failure.detail ?? failure.status, status: "failed" as const })),
  ];

  return <div className="admin-page-stack">
    <AdminPageHeader eyebrow="Operations" title="System overview" description="A truthful, current view of system health, active work, failures, and operator intervention." actions={<TimeWindowControl value={timeWindow} options={[{ value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }]} onChange={setTimeWindow} />} />
    {data.health.runtimeCompatibility.state === "MISMATCH" && <div className="admin-critical-banner" role="alert"><strong>Version mismatch</strong><span>{data.health.runtimeCompatibility.detail}</span></div>}
    {data.health.runtimeFreshness.state === "STALE_PROCESS" && <div className="admin-critical-banner" role="alert"><strong>Stale process — restart before running the writer</strong><span>{data.health.runtimeFreshness.detail} Loaded: {data.health.runtimeFreshness.loadedRevision.slice(0, 12)} · Currently checked out: {data.health.runtimeFreshness.observedRevision.slice(0, 12)}. This is advisory — the per-workflow runtime contract remains the real, fail-closed safety check.</span></div>}
    <section aria-labelledby="health-heading"><h2 id="health-heading" className="admin-section-title">Critical health</h2><div className="admin-health-grid">
      <HealthTile label="System" status={displayStatus(data.health.system)} value={queueCount + runningCount} detail={`${queueCount} queued · ${runningCount} running`} href="/admin/operations" />
      <HealthTile label="Scanner" status={displayStatus(data.health.scanner)} value={data.scanning.summary.runs} detail={`${data.scanning.summary.jobsAdded} jobs added`} href="/admin/scanner" />
      <HealthTile label="Resume Writer" status={displayStatus(data.writer.state)} value={data.writer.pendingWorkflowCount} detail="Workflows queued" href="/admin/writer" />
      <HealthTile label="Applications" status={displayStatus(data.health.applications)} value={data.applications.FAILED ?? 0} detail="Failed runs" href="/admin/applications" />
      <HealthTile label="Runtime compatibility" status={displayStatus(data.health.runtimeCompatibility.state)} detail={data.health.runtimeCompatibility.detail} href="/admin/operations" />
      <HealthTile label="Runtime freshness" status={displayStatus(data.health.runtimeFreshness.state)} detail={data.health.runtimeFreshness.state === "UNKNOWN" ? "Unknown" : data.health.runtimeFreshness.state === "CURRENT" ? "Current" : "Stale process"} href="/admin/operations" />
    </div></section>
    <div className="admin-two-column"><section aria-labelledby="intervention-heading"><h2 id="intervention-heading" className="admin-section-title">Work requiring intervention</h2>{interventionItems.length ? <InterventionList items={interventionItems} /> : <AdminEmptyState title="No intervention required" detail="No recent operational failure or runtime mismatch needs attention." />}</section>
    <section aria-labelledby="throughput-heading"><h2 id="throughput-heading" className="admin-section-title">Queue and throughput</h2><div className="admin-operational-card"><dl className="admin-metric-list"><div><dt>Queued work</dt><dd>{queueCount}</dd></div><div><dt>Running now</dt><dd>{runningCount}</dd></div><div><dt>Jobs discovered</dt><dd>{data.jobsDiscovered}</dd></div><div><dt>Active companies</dt><dd>{data.companies.active} / {data.companies.total}</dd></div></dl></div></section></div>
    <section aria-labelledby="failures-heading"><h2 id="failures-heading" className="admin-section-title">Recent failures</h2>{data.recentFailures.length ? <OperationalTable label="Recent cross-service failures"><caption className="sr-only">Recent cross-service failures</caption><thead><tr><th>Service</th><th>Item</th><th>Status</th><th>When</th></tr></thead><tbody>{data.recentFailures.map((failure) => <tr key={`${failure.source}-${failure.id}`}><td>{failure.source}</td><td>#{failure.id} {failure.detail ?? ""}</td><td><AdminStatus status="failed" label={failure.status} /></td><td>{new Date(failure.occurredAt).toLocaleString()}</td></tr>)}</tbody></OperationalTable> : <AdminEmptyState title="No recent failures" detail="No persisted scanner, writer, or application failures were found." />}</section>
    <TechnicalDetails summary="Runtime details"><dl className="admin-technical-grid"><div><dt>Web revision</dt><dd>{data.runtime.web.sourceRevision}</dd></div><div><dt>Web contract</dt><dd>{data.runtime.web.contractVersion}</dd></div><div><dt>Worker revision</dt><dd>{data.runtime.worker.sourceRevision ?? "Not reported"}</dd></div><div><dt>Worker contract</dt><dd>{data.runtime.worker.contractVersion ?? "Not reported"}</dd></div><div><dt>Worker PID</dt><dd>{data.runtime.worker.pid ?? "Offline"}</dd></div><div><dt>Worker activity</dt><dd>{data.runtime.worker.currentActivity ?? "Unknown"}</dd></div><div><dt>Currently checked-out revision</dt><dd>{data.runtime.freshness.state === "UNKNOWN" ? "Unknown" : data.runtime.freshness.observedRevision}</dd></div><div><dt>Freshness observed at</dt><dd>{data.runtime.freshness.state === "UNKNOWN" ? "Unknown" : new Date(data.runtime.freshness.observedAt).toLocaleTimeString()}</dd></div></dl></TechnicalDetails>
    <p className="admin-updated-at">Updated {new Date(data.generatedAt).toLocaleTimeString()} · <Link href="/admin/activity">View activity</Link></p>
  </div>;
}
