"use client";

import { useCallback, useEffect, useState } from "react";
import type { MorningReadinessSummary } from "@/lib/production/types";

function formatTimestamp(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

const STATUS_STYLES: Record<string, string> = {
  RUNNING: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-400 border-blue-300 dark:border-blue-800",
  READY: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800",
  DEGRADED: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400 border-amber-300 dark:border-amber-800",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400 border-red-300 dark:border-red-800",
  UNINITIALIZED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700",
};

export function MorningReadinessSection() {
  const [data, setData] = useState<{ readiness: MorningReadinessSummary; lock: { held: boolean; acquiredAt: string | null } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/production-readiness");
      if (!res.ok) {
        throw new Error(`Failed to load readiness (${res.status})`);
      }
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Intentional: fetch-on-mount with a loading flag, not a render loop — same pattern (and same
    // justified exception) as the parent OperationsPage's own load() effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleRunCycle = async () => {
    try {
      setRunning(true);
      setError(null);
      const res = await fetch("/api/production-cycle", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `Cycle failed (${res.status})`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const readiness = data?.readiness;
  const lock = data?.lock;
  const status = readiness?.productionCycle.isRunning ? "RUNNING" : readiness?.productionCycle.status || "UNINITIALIZED";

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-100 pb-4 dark:border-zinc-800">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">CareerOps Morning Readiness</h2>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${
                STATUS_STYLES[status] || STATUS_STYLES.UNINITIALIZED
              }`}
            >
              {status}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {readiness?.productionCycle.isRunning
              ? `Running since ${formatTimestamp(readiness.productionCycle.runningSinceAt)}`
              : readiness?.productionCycle.lastRunAt
                ? `Last production cycle: ${formatTimestamp(readiness.productionCycle.lastRunAt)} (duration: ${formatDuration(
                    readiness.productionCycle.durationMs
                  )})`
                : "No production cycle executed yet."}
            {readiness && readiness.productionCycle.scanReadyCompaniesNeverScanned > 0
              ? ` · ${readiness.productionCycle.scanReadyCompaniesNeverScanned} scan-ready compan${readiness.productionCycle.scanReadyCompaniesNeverScanned === 1 ? "y" : "ies"} never scanned`
              : ""}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleRunCycle}
            disabled={running || loading || Boolean(lock?.held)}
            className="inline-flex items-center gap-1.5 rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {running ? "Running Production Cycle…" : lock?.held ? "Cycle Locked / Running" : "Run Production Cycle"}
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="rounded border border-zinc-300 px-2.5 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}

      {readiness && (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Card 1: Approved ATS */}
          <div className="rounded border border-zinc-100 bg-zinc-50/50 p-3 dark:border-zinc-800/80 dark:bg-zinc-950/40">
            <div className="text-xs font-medium text-zinc-500">Approved ATS Scans</div>
            <div className="mt-2 text-lg font-bold text-zinc-900 dark:text-zinc-100">
              {readiness.ats.successful} / {readiness.ats.attempted}
              <span className="ml-1 text-xs font-normal text-zinc-500">
                ({readiness.ats.successPercentage !== null ? `${readiness.ats.successPercentage}%` : "—"})
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
              <span>Scan-ready: {readiness.ats.scanReadyCompanies}</span>
              <span>Partial: {readiness.ats.partial}</span>
              <span className={readiness.ats.failed > 0 ? "text-red-600 font-medium" : ""}>
                Failed: {readiness.ats.failed}
              </span>
            </div>
          </div>

          {/* Card 2: Reliability */}
          <div className="rounded border border-zinc-100 bg-zinc-50/50 p-3 dark:border-zinc-800/80 dark:bg-zinc-950/40">
            <div className="text-xs font-medium text-zinc-500">Connector Reliability</div>
            <div className="mt-2 text-lg font-bold text-zinc-900 dark:text-zinc-100">
              {readiness.reliability.healthy}
              <span className="ml-1 text-xs font-normal text-zinc-500">healthy</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
              <span>Recovering: {readiness.reliability.recovering}</span>
              <span>Review: {readiness.reliability.needsReview}</span>
              <span className={readiness.reliability.down > 0 ? "text-red-600 font-medium" : ""}>
                Down: {readiness.reliability.down}
              </span>
              <span>Circuits Open: {readiness.reliability.openCircuits.length}</span>
            </div>
          </div>

          {/* Card 3: Jobs */}
          <div className="rounded border border-zinc-100 bg-zinc-50/50 p-3 dark:border-zinc-800/80 dark:bg-zinc-950/40">
            <div className="text-xs font-medium text-zinc-500">Jobs & Freshness</div>
            <div className="mt-2 text-lg font-bold text-zinc-900 dark:text-zinc-100">
              {readiness.jobs.freshActiveUsJobs}
              <span className="ml-1 text-xs font-normal text-zinc-500">fresh active US (&le;20d)</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
              <span>New this cycle: {readiness.jobs.totalNewJobsThisCycle}</span>
              <span>(ATS: {readiness.jobs.newAtsJobsThisCycle}, Built In: {readiness.jobs.newBuiltInJobsThisCycle})</span>
            </div>
          </div>

          {/* Card 4: Built In & Discovery */}
          <div className="rounded border border-zinc-100 bg-zinc-50/50 p-3 dark:border-zinc-800/80 dark:bg-zinc-950/40">
            <div className="text-xs font-medium text-zinc-500">Built In & Discovery</div>
            <div className="mt-2 text-lg font-bold text-zinc-900 dark:text-zinc-100">
              {readiness.builtIn.resolved} / {readiness.builtIn.listingsDiscovered}
              <span className="ml-1 text-xs font-normal text-zinc-500">resolved</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
              <span>New employers: {readiness.builtIn.employersOnboarded}</span>
              <span>Dups prevented: {readiness.builtIn.crossSourceDuplicatesPrevented}</span>
              <span>Proposals: {readiness.discovery.pendingProposals}</span>
            </div>
          </div>
        </div>
      )}

      {/* Operator Attention Details */}
      {readiness && readiness.needsAttention.details.length > 0 && (
        <div className="mt-4 rounded border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900/60 dark:bg-amber-950/20">
          <div className="text-xs font-semibold text-amber-900 dark:text-amber-300">
            Operator Attention Required ({readiness.needsAttention.details.length})
          </div>
          <ul className="mt-2 divide-y divide-amber-200/50 text-xs text-amber-800 dark:divide-amber-900/40 dark:text-amber-400">
            {readiness.needsAttention.details.map((item, i) => (
              <li key={i} className="py-1.5 flex items-start justify-between gap-2">
                <span>{item.message}</span>
                <span className="rounded bg-amber-200/60 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-900 dark:bg-amber-900/60 dark:text-amber-300">
                  {item.type}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
