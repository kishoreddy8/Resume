"use client";

import { useEffect, useState } from "react";
import type { AtsCoverageCompany, AtsCoverageSummary } from "@/db/queries/atsCoverage";
import { PROVIDER_LABELS } from "@/lib/ats/providerLabels";

const HEALTH_STYLES: Record<string, string> = {
  healthy: "text-emerald-700 dark:text-emerald-400",
  degraded: "text-amber-700 dark:text-amber-400",
  down: "text-red-600 dark:text-red-400",
  unknown: "text-zinc-400",
};

const REASON_LABELS: Record<string, string> = {
  HEALTHY: "healthy",
  NEVER_SCANNED: "never scanned",
  REPEATED_FAILURES: "repeated failures",
  TRANSIENT_FAILURE: "transient failure",
  PARTIAL_DATA_QUALITY: "partial data quality",
  UNCLASSIFIED: "unclassified",
};

function CompanyDrilldown({ companies, emptyLabel }: { companies: AtsCoverageCompany[]; emptyLabel: string }) {
  const [open, setOpen] = useState(false);
  if (companies.length === 0) return <p className="text-xs text-zinc-500">{emptyLabel}</p>;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
      >
        {open ? "Hide" : "Show"} {companies.length} compan{companies.length === 1 ? "y" : "ies"}
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5 border-l border-zinc-200 pl-3 dark:border-zinc-800">
          {companies.map((c) => (
            <li key={c.id} className="text-xs">
              <a href="/companies" className="font-medium hover:underline">
                {c.name}
              </a>
              <span className={`ml-2 ${HEALTH_STYLES[c.connector_health] ?? ""}`}>{c.connector_health}</span>
              {c.job_count > 0 && <span className="ml-2 text-zinc-400">{c.job_count} active job{c.job_count === 1 ? "" : "s"}</span>}
              {c.healthReasonCode !== "HEALTHY" && (
                <div className="mt-0.5 max-w-md text-zinc-500" title={c.healthReasonLabel}>
                  {c.healthReasonLabel.length > 120 ? `${c.healthReasonLabel.slice(0, 120)}…` : c.healthReasonLabel}
                </div>
              )}
              {c.discovery_reason && (
                <div className="mt-0.5 max-w-md text-zinc-500" title={c.discovery_reason}>
                  {c.discovery_reason.length > 120 ? `${c.discovery_reason.slice(0, 120)}…` : c.discovery_reason}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-zinc-500">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

export default function AtsCoveragePage() {
  const [data, setData] = useState<AtsCoverageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/ats-coverage");
        setData(await res.json());
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading || !data) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">ATS coverage &amp; source health</h1>
        <p className="text-sm text-zinc-500">
          What&apos;s blocking job discovery, and what to improve next — derived from the {data.totals.companies}{" "}
          companies currently in the registry. See the{" "}
          <a href="/companies" className="underline">
            Companies
          </a>{" "}
          page to add sources or retry discovery.
        </p>
      </div>

      <Section
        title={`Companies on a supported connector (${data.totals.supported})`}
        subtitle="Every company currently on one of the 34 supported ATS connectors, regardless of current health."
      >
        {data.supported.length === 0 ? (
          <p className="text-xs text-zinc-500">No companies on a supported connector yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.supported.map((g) => (
              <div key={g.sourceType} className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{PROVIDER_LABELS[g.sourceType]}</span>
                  <span className="text-xs text-zinc-500">
                    {g.companyCount} compan{g.companyCount === 1 ? "y" : "ies"} · {g.jobCount} active job{g.jobCount === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  <span className="text-emerald-700 dark:text-emerald-400">{g.healthyCount} healthy</span>
                  {g.degradedCount > 0 && <span className="ml-2 text-amber-700 dark:text-amber-400">{g.degradedCount} degraded</span>}
                  {g.downCount > 0 && <span className="ml-2 text-red-600 dark:text-red-400">{g.downCount} down</span>}
                </div>
                {(g.degradedCount > 0 || g.downCount > 0) && (
                  <div className="mt-0.5 text-xs text-zinc-400">
                    {Object.entries(g.reasonBreakdown)
                      .filter(([code]) => code !== "HEALTHY")
                      .map(([code, count]) => `${count} ${REASON_LABELS[code] ?? code}`)
                      .join(" · ")}
                  </div>
                )}
                <div className="mt-2">
                  <CompanyDrilldown companies={g.companies} emptyLabel="" />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={`Needs adapter (${data.totals.needsAdapter})`}
        subtitle="A recognized-but-unsupported ATS platform was found. No connector exists yet — grouped by platform so it's clear which one would unblock the most companies if built next."
      >
        {data.needsAdapter.length === 0 ? (
          <p className="text-xs text-zinc-500">No known-but-unsupported platforms encountered yet.</p>
        ) : (
          <div className="space-y-3">
            {data.needsAdapter.map((g) => (
              <div key={g.suspectedAts} className="rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-amber-900 dark:text-amber-200">{g.suspectedAts}</span>
                  <span className="text-xs text-amber-800/80 dark:text-amber-300/70">
                    {g.companyCount} compan{g.companyCount === 1 ? "y" : "ies"} blocked
                  </span>
                </div>
                <div className="mt-2">
                  <CompanyDrilldown companies={g.companies} emptyLabel="" />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={`Generic scrape (${data.totals.generic})`}
        subtitle="No known ATS found, but a careers/jobs page was reached — best-effort scraping, no per-posting description in most cases."
      >
        <CompanyDrilldown companies={data.generic} emptyLabel="None." />
      </Section>

      <Section
        title={`Unresolved / unknown (${data.totals.unresolved})`}
        subtitle="Nothing found within discovery bounds, or a temporary fetch failure. See each company's reason for why."
      >
        <CompanyDrilldown companies={data.unresolved} emptyLabel="None." />
      </Section>
    </div>
  );
}
