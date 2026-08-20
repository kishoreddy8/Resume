"use client";

import { useEffect, useMemo, useState } from "react";
import type { Company, ConnectorHealth, ScanRunWithCompany } from "@/types";
import { Metric, PageHeader, SkeletonMetrics, SkeletonRows, Status, StatusDot, Surface, LoadingRegion } from "@/components/ui";
import type { StatusTone } from "@/components/ui";

/**
 * ATS Operations Center.
 *
 * Same three requests, same fields, same numbers — this is a presentation rewrite. What changed is
 * that the page now reads as a control room rather than two HTML tables: connectors are grouped by
 * the ATS they actually run on, and scan history is a timeline rather than a second table of the
 * same shape as the first.
 *
 * Nothing here fabricates activity. A connector that has never run says "never"; a run with no
 * error category shows nothing rather than an invented "OK". There is no live progress bar, because
 * scans are triggered from the Jobs toolbar and this page does not poll.
 */

/* The connector table rendered every configured company — ~2,500 rows and 67,902 DOM nodes on the
 * measured dataset, which is an order of magnitude more than the entire Jobs workspace. Capped with
 * the same vocabulary the jobs list already uses, and the count of what is hidden is always shown so
 * the cap can never be mistaken for the full set. Connectors needing attention sort first, because
 * a capped list must not hide the rows an operator opened this page to find. */
const CONNECTOR_LIMIT = 100;
const CONNECTOR_STEP = 200;

const ATTENTION_RANK: Record<ConnectorHealth, number> = { down: 0, degraded: 1, unknown: 2, healthy: 3 };

const HEALTH_TONE: Record<ConnectorHealth, StatusTone> = {
  healthy: "ready",
  degraded: "attention",
  down: "blocked",
  unknown: "unknown",
};

const RUN_TONE: Record<string, StatusTone> = {
  success: "ready",
  partial: "attention",
  failed: "blocked",
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

function relative(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function ScannerPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [latestRuns, setLatestRuns] = useState<ScanRunWithCompany[]>([]);
  const [recentRuns, setRecentRuns] = useState<ScanRunWithCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectorLimit, setConnectorLimit] = useState(CONNECTOR_LIMIT);

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

  /** Connectors grouped by the ATS they actually run on — read from source_type, never assumed. */
  const bySource = useMemo(() => {
    const map = new Map<string, Company[]>();
    for (const c of companies) {
      const key = c.source_type ?? "unknown";
      const list = map.get(key);
      if (list) list.push(c);
      else map.set(key, [c]);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [companies]);

  /* Attention first, then name. Presentation ordering only — no API or query semantics touched. */
  const orderedCompanies = useMemo(
    () =>
      [...companies].sort(
        (a, b) =>
          ATTENTION_RANK[a.connector_health ?? "unknown"] - ATTENTION_RANK[b.connector_health ?? "unknown"] ||
          a.name.localeCompare(b.name)
      ),
    [companies]
  );
  const shownCompanies = orderedCompanies.slice(0, connectorLimit);
  const hiddenCompanies = orderedCompanies.length - shownCompanies.length;

  const refresh = (
    <button
      type="button"
      onClick={load}
      disabled={loading}
      className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-[12px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98] disabled:opacity-50"
    >
      {loading ? "Refreshing…" : "Refresh"}
    </button>
  );

  if (loading && companies.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="ATS Operations" description="Connector health and scan history across every configured source." />
        <LoadingRegion label="Loading ATS operations" />
        <Surface level="z3" className="rounded-[var(--radius-xl)] p-5">
          <SkeletonMetrics count={4} />
        </Surface>
        <Surface level="z3" className="rounded-[var(--radius-xl)] p-5">
          <SkeletonRows rows={8} />
        </Surface>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="ATS Operations"
        description="Connector health and scan history across every configured source. Scans are triggered from the Jobs toolbar; this page reports what they did."
        actions={refresh}
      />

      {/* Fleet state. Four counts, all real; a health the connector has never reported stays unknown. */}
      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Connectors" value={companies.length} hint={`${bySource.length} ATS types`} />
          <Metric label="Healthy" value={healthCounts.healthy} tone="success" />
          <Metric label="Degraded" value={healthCounts.degraded} tone={healthCounts.degraded > 0 ? "attention" : "default"} />
          <Metric
            label="Down"
            value={healthCounts.down}
            tone={healthCounts.down > 0 ? "blocked" : "default"}
            hint={healthCounts.unknown > 0 ? `${healthCounts.unknown} unknown` : undefined}
          />
        </div>
      </Surface>

      {/* By ATS. This is the grouping the operator actually thinks in — "is Greenhouse healthy?" */}
      {bySource.length > 0 && (
        <section className="space-y-2">
          <h2 className="section-title">By ATS</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {bySource.map(([source, list]) => {
              const down = list.filter((c) => c.connector_health === "down").length;
              const degraded = list.filter((c) => c.connector_health === "degraded").length;
              const tone: StatusTone = down > 0 ? "blocked" : degraded > 0 ? "attention" : "ready";
              return (
                <Surface
                  key={source}
                  level="z3"
                  className="tint-info rounded-[var(--radius-lg)] px-4 py-3 transition-transform duration-150 ease-out hover:-translate-y-px"
                >
                  <div className="flex items-center gap-1.5">
                    <StatusDot tone={tone} />
                    <span className="truncate text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
                      {source}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[19px] font-semibold leading-none tabular-nums tracking-[-0.02em] text-primary">
                    {list.length}
                  </div>
                  <div className="mt-1 text-[11px] text-tertiary">
                    {down > 0 ? `${down} down` : degraded > 0 ? `${degraded} degraded` : "all healthy"}
                  </div>
                </Surface>
              );
            })}
          </div>
        </section>
      )}

      {/* Connector detail. A table, because this genuinely is tabular — but on the token system. */}
      <section className="space-y-2">
        <h2 className="section-title">Connector health</h2>
        {companies.length === 0 ? (
          <Surface level="z3" className="rounded-[var(--radius-xl)] px-6 py-12 text-center">
            <p className="text-[13px] font-medium text-primary">No connectors configured</p>
            <p className="mt-1 text-[12px] text-tertiary">Add a company on the Companies page to start scanning.</p>
          </Surface>
        ) : (
          <Surface level="z3" className="overflow-hidden rounded-[var(--radius-xl)]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12.5px]">
                <thead>
                  <tr className="border-b border-[var(--separator)]">
                    {["Company", "Health", "Last scan", "Duration", "Found / Added / Updated / Closed", "Failures", "Latest error"].map(
                      (h) => (
                        <th
                          key={h}
                          className="whitespace-nowrap px-3 py-2 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-tertiary"
                        >
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {shownCompanies.map((c) => {
                    const run = latestRunByCompany.get(c.id);
                    const health = c.connector_health ?? "unknown";
                    return (
                      <tr key={c.id} className="border-b border-[var(--separator)] last:border-b-0 hover:bg-[var(--surface-hover)]">
                        <td className="px-3 py-2">
                          <div className="font-medium text-primary">{c.name}</div>
                          <div className="text-[11px] text-tertiary">{c.source_type}</div>
                        </td>
                        <td className="px-3 py-2">
                          <Status tone={HEALTH_TONE[health]}>{health}</Status>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[11.5px] text-tertiary">
                          {run ? (
                            <>
                              <Status tone={RUN_TONE[run.status] ?? "neutral"}>{run.status}</Status>
                              <div className="mt-0.5">{relative(run.started_at)}</div>
                            </>
                          ) : (
                            "never"
                          )}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-[11.5px] text-tertiary">
                          {run ? formatDuration(run.duration_ms) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-[11.5px] text-tertiary">
                          {run ? `${run.jobs_discovered} / ${run.jobs_added} / ${run.jobs_updated} / ${run.jobs_closed}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-[11.5px]">
                          <span
                            className={
                              c.consecutive_failures > 0 ? "font-semibold tabular-nums text-[var(--error)]" : "tabular-nums text-tertiary"
                            }
                          >
                            {c.consecutive_failures}
                          </span>
                        </td>
                        <td className="max-w-xs px-3 py-2 text-[11.5px] text-tertiary">
                          {c.last_error_message ? (
                            <span title={c.last_error_message}>
                              {c.last_error_category && (
                                <span className="mr-1 rounded bg-[var(--z0-bg)] px-1 py-0.5 text-[10px] font-medium text-secondary">
                                  {c.last_error_category}
                                </span>
                              )}
                              {c.last_error_message.length > 60 ? `${c.last_error_message.slice(0, 60)}…` : c.last_error_message}
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
            {hiddenCompanies > 0 && (
              <div className="flex items-center justify-between gap-3 border-t border-[var(--separator)] px-3 py-2">
                <span className="text-[11.5px] tabular-nums text-tertiary">
                  Showing {shownCompanies.length.toLocaleString()} of {orderedCompanies.length.toLocaleString()} — connectors
                  needing attention first
                </span>
                <button
                  type="button"
                  onClick={() => setConnectorLimit((n) => n + CONNECTOR_STEP)}
                  className="shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98]"
                >
                  Show {Math.min(CONNECTOR_STEP, hiddenCompanies).toLocaleString()} more
                </button>
              </div>
            )}
          </Surface>
        )}
      </section>

      {/* Activity, as a timeline rather than a second table of the same shape. */}
      <section className="space-y-2">
        <h2 className="section-title">Recent activity</h2>
        {recentRuns.length === 0 ? (
          <Surface level="z3" className="rounded-[var(--radius-xl)] px-6 py-12 text-center">
            <p className="text-[13px] font-medium text-primary">No scans yet</p>
            <p className="mt-1 text-[12px] text-tertiary">Run one from the Jobs toolbar to populate this timeline.</p>
          </Surface>
        ) : (
          <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-3">
            <ol>
              {recentRuns.map((run) => (
                <li
                  key={run.id}
                  className="relative flex items-baseline gap-3 border-b border-[var(--separator)] py-2.5 pl-5 last:border-b-0"
                >
                  {/* The spine, and this run's node on it. */}
                  <span aria-hidden="true" className="absolute left-[3px] top-0 h-full w-px bg-[var(--separator)]" />
                  <span className="absolute left-0 top-[13px]">
                    <StatusDot tone={RUN_TONE[run.status] ?? "neutral"} />
                  </span>

                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-primary">{run.company_name}</span>
                  <span className="shrink-0 text-[11.5px] text-secondary">{run.status}</span>
                  <span className="hidden shrink-0 tabular-nums text-[11.5px] text-tertiary sm:inline">
                    {run.jobs_discovered} found · {run.jobs_added} new · {run.jobs_closed} closed
                  </span>
                  <span className="shrink-0 tabular-nums text-[11px] text-tertiary">{formatDuration(run.duration_ms)}</span>
                  <span
                    className="shrink-0 whitespace-nowrap text-[11px] text-tertiary"
                    title={formatTimestamp(run.started_at)}
                  >
                    {relative(run.started_at)}
                  </span>
                  {run.error_category && (
                    <span className="shrink-0 rounded bg-[var(--z0-bg)] px-1 py-0.5 text-[10px] text-[var(--error)]" title={run.error_message ?? ""}>
                      {run.error_category}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </Surface>
        )}
      </section>
    </div>
  );
}
