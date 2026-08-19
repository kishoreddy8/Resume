"use client";

import { useEffect, useMemo, useState } from "react";
import type { Company, ConnectorHealth, ScanRunWithCompany } from "@/types";

const HEALTH_STYLES: Record<ConnectorHealth, string> = {
  healthy: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400",
  degraded: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400",
  down: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400",
  unknown: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

function HealthBadge({ health }: { health: ConnectorHealth }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${HEALTH_STYLES[health]}`}>
      {health}
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  success: "text-emerald-700 dark:text-emerald-400",
  partial: "text-amber-700 dark:text-amber-400",
  failed: "text-red-600 dark:text-red-400",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex-1 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

export default function ScannerPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [latestRuns, setLatestRuns] = useState<ScanRunWithCompany[]>([]);
  const [recentRuns, setRecentRuns] = useState<ScanRunWithCompany[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [companiesRes, latestRes, recentRes] = await Promise.all([
        fetch("/api/companies"),
        fetch("/api/scan-runs?latestPerCompany=1"),
        fetch("/api/scan-runs?limit=25"),
      ]);
      const companiesData = await companiesRes.json();
      const latestData = await latestRes.json();
      const recentData = await recentRes.json();
      setCompanies(companiesData.companies ?? []);
      setLatestRuns(latestData.scanRuns ?? []);
      setRecentRuns(recentData.scanRuns ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Intentional: fetch-on-mount with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  const latestRunByCompany = useMemo(() => {
    const map = new Map<number, ScanRunWithCompany>();
    for (const run of latestRuns) map.set(run.company_id, run);
    return map;
  }, [latestRuns]);

  const healthCounts = useMemo(() => {
    const counts: Record<ConnectorHealth, number> = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
    for (const c of companies) counts[c.connector_health ?? "unknown"]++;
    return counts;
  }, [companies]);

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="page-title">Scanner</h1>
        <button
          onClick={load}
          className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        <SummaryCard label="Companies" value={companies.length} />
        <SummaryCard label="Healthy" value={healthCounts.healthy} tone="text-emerald-600 dark:text-emerald-400" />
        <SummaryCard label="Degraded" value={healthCounts.degraded} tone="text-amber-600 dark:text-amber-400" />
        <SummaryCard label="Down" value={healthCounts.down} tone="text-red-600 dark:text-red-400" />
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Connector health</h2>
        {companies.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No companies yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Company</th>
                  <th className="px-3 py-2 font-medium">Health</th>
                  <th className="px-3 py-2 font-medium">Last scan</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Found / Added / Updated / Closed</th>
                  <th className="px-3 py-2 font-medium">Consecutive failures</th>
                  <th className="px-3 py-2 font-medium">Latest error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {companies.map((c) => {
                  const run = latestRunByCompany.get(c.id);
                  return (
                    <tr key={c.id}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{c.name}</div>
                        <div className="text-xs text-zinc-500">{c.source_type}</div>
                      </td>
                      <td className="px-3 py-2">
                        <HealthBadge health={c.connector_health ?? "unknown"} />
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-500">
                        {run ? (
                          <>
                            <span className={STATUS_STYLES[run.status] ?? ""}>{run.status}</span>
                            <div>{formatTimestamp(run.started_at)}</div>
                          </>
                        ) : (
                          "never"
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-500">{run ? formatDuration(run.duration_ms) : "—"}</td>
                      <td className="px-3 py-2 text-xs text-zinc-500">
                        {run
                          ? `${run.jobs_discovered} / ${run.jobs_added} / ${run.jobs_updated} / ${run.jobs_closed}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <span className={c.consecutive_failures > 0 ? "font-medium text-red-600 dark:text-red-400" : "text-zinc-500"}>
                          {c.consecutive_failures}
                        </span>
                      </td>
                      <td className="px-3 py-2 max-w-xs text-xs text-zinc-500">
                        {c.last_error_message ? (
                          <span title={c.last_error_message}>
                            {c.last_error_category && (
                              <span className="mr-1 rounded bg-zinc-100 px-1 py-0.5 text-[10px] font-medium dark:bg-zinc-800">
                                {c.last_error_category}
                              </span>
                            )}
                            {c.last_error_message.length > 60
                              ? `${c.last_error_message.slice(0, 60)}…`
                              : c.last_error_message}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Recent scan runs</h2>
        {recentRuns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No scans have run yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Company</th>
                  <th className="px-3 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Retries</th>
                  <th className="px-3 py-2 font-medium">Found / Added / Updated / Unchanged / Closed</th>
                  <th className="px-3 py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td className="px-3 py-2 font-medium">{run.company_name}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{formatTimestamp(run.started_at)}</td>
                    <td className={`px-3 py-2 text-xs font-medium ${STATUS_STYLES[run.status] ?? ""}`}>{run.status}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{formatDuration(run.duration_ms)}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{run.retry_count}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">
                      {run.jobs_discovered} / {run.jobs_added} / {run.jobs_updated} / {run.jobs_unchanged} /{" "}
                      {run.jobs_closed}
                    </td>
                    <td className="px-3 py-2 max-w-xs text-xs text-zinc-500" title={run.error_message ?? ""}>
                      {run.error_category ?? (run.error_message ? "—" : "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
