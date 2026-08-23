"use client";

import { useCallback, useEffect, useState } from "react";
import type { MorningReadinessSummary } from "@/lib/production/types";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import { adminApiUrl } from "@/lib/admin/client";
import { AdminStatus } from "@/components/admin";

function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
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

export function MorningReadinessSection() {
  const candidateId = useActiveCandidateId();
  const [data, setData] = useState<{
    readiness: MorningReadinessSummary;
    lock: { held: boolean; acquiredAt: string | null };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(adminApiUrl("/api/production-readiness", candidateId));
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
  }, [candidateId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const handleRunCycle = async () => {
    try {
      setRunning(true);
      setError(null);
      const res = await fetch(adminApiUrl("/api/production-cycle", candidateId), { method: "POST" });
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
  const status = readiness?.productionCycle.isRunning
    ? "RUNNING"
    : readiness?.productionCycle.status || "UNINITIALIZED";

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--z2-bg)] p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--separator)] pb-5">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="text-[19px] font-bold text-primary">Daily Morning Readiness</h3>
            <AdminStatus
              status={
                status === "READY"
                  ? "healthy"
                  : status === "RUNNING"
                  ? "running"
                  : status === "DEGRADED"
                  ? "degraded"
                  : status === "FAILED"
                  ? "failed"
                  : "idle"
              }
              label={status}
            />
          </div>
          <p className="mt-2 text-[14px] text-secondary leading-relaxed">
            {readiness?.productionCycle.isRunning
              ? `Production cycle in progress since ${formatTimestamp(readiness.productionCycle.runningSinceAt)}`
              : readiness?.productionCycle.lastRunAt
              ? `Last production cycle: ${formatTimestamp(
                  readiness.productionCycle.lastRunAt
                )} (duration: ${formatDuration(readiness.productionCycle.durationMs)})`
              : "No production cycle executed yet."}
            {readiness && readiness.productionCycle.scanReadyCompaniesNeverScanned > 0
              ? ` · ${readiness.productionCycle.scanReadyCompaniesNeverScanned} scan-ready compan${
                  readiness.productionCycle.scanReadyCompaniesNeverScanned === 1 ? "y" : "ies"
                } never scanned`
              : ""}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRunCycle}
            disabled={running || loading || Boolean(lock?.held)}
            className="admin-button admin-button-primary"
          >
            {running
              ? "Running Cycle…"
              : lock?.held
              ? "Cycle Locked / Running"
              : "Run Production Cycle"}
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="admin-button admin-button-secondary"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-5 rounded-xl border border-red-300 bg-red-50 p-4 text-[14px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}

      {readiness && (
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Card 1: Approved ATS */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] p-4">
            <div className="text-[13.5px] font-semibold text-secondary">Approved ATS Scans</div>
            <div className="mt-2 text-[22px] font-bold text-primary tabular-nums">
              {readiness.ats.successful} / {readiness.ats.attempted}
              <span className="ml-2 text-sm font-normal text-tertiary">
                ({readiness.ats.successPercentage !== null ? `${readiness.ats.successPercentage}%` : "—"})
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-secondary">
              <span>Scan-ready: {readiness.ats.scanReadyCompanies}</span>
              <span>Partial: {readiness.ats.partial}</span>
              <span className={readiness.ats.failed > 0 ? "text-red-600 font-bold" : ""}>
                Failed: {readiness.ats.failed}
              </span>
            </div>
          </div>

          {/* Card 2: Reliability */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] p-4">
            <div className="text-[13.5px] font-semibold text-secondary">Connector Reliability</div>
            <div className="mt-2 text-[22px] font-bold text-primary tabular-nums">
              {readiness.reliability.healthy}
              <span className="ml-2 text-sm font-normal text-tertiary">healthy</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-secondary">
              <span>Recovering: {readiness.reliability.recovering}</span>
              <span>Review: {readiness.reliability.needsReview}</span>
              <span className={readiness.reliability.down > 0 ? "text-red-600 font-bold" : ""}>
                Down: {readiness.reliability.down}
              </span>
            </div>
          </div>

          {/* Card 3: Jobs */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] p-4">
            <div className="text-[13.5px] font-semibold text-secondary">Jobs & Freshness</div>
            <div className="mt-2 text-[22px] font-bold text-primary tabular-nums">
              {readiness.jobs.freshActiveUsJobs}
              <span className="ml-2 text-sm font-normal text-tertiary">fresh active US (&le;20d)</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-secondary">
              <span>New this cycle: {readiness.jobs.totalNewJobsThisCycle}</span>
              <span>(ATS: {readiness.jobs.newAtsJobsThisCycle})</span>
            </div>
          </div>

          {/* Card 4: Discovery */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] p-4">
            <div className="text-[13.5px] font-semibold text-secondary">Discovery & Pipeline</div>
            <div className="mt-2 text-[22px] font-bold text-primary tabular-nums">
              {readiness.builtIn.resolved} / {readiness.builtIn.listingsDiscovered}
              <span className="ml-2 text-sm font-normal text-tertiary">resolved</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-secondary">
              <span>New employers: {readiness.builtIn.employersOnboarded}</span>
              <span>Proposals: {readiness.discovery.pendingProposals}</span>
            </div>
          </div>
        </div>
      )}

      {/* Operator Attention Details */}
      {readiness && readiness.needsAttention.details.length > 0 && (
        <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/30">
          <div className="text-[14.5px] font-bold text-amber-900 dark:text-amber-300 flex items-center gap-2">
            <span aria-hidden="true">⚠️</span>
            Operator Attention Required ({readiness.needsAttention.details.length})
          </div>
          <ul className="mt-3 divide-y divide-amber-200/60 text-[13.5px] text-amber-900 dark:divide-amber-900/40 dark:text-amber-300">
            {readiness.needsAttention.details.map((item, i) => (
              <li key={i} className="py-2 flex items-center justify-between gap-3">
                <span>{item.message}</span>
                <span className="rounded bg-amber-200/80 px-2 py-0.5 text-xs font-semibold uppercase text-amber-950 dark:bg-amber-900 dark:text-amber-200">
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
