"use client";

import { useEffect, useState } from "react";
import { adminApiUrl } from "@/lib/admin/client";
import Link from "next/link";

interface Intelligence {
  company: {
    id: number;
    name: string;
    configuredSource: string | null;
    careerPageUrl: string | null;
    lastScannedAt: string | null;
    lastScanStatus: string | null;
    h1b: {
      confidence: string | null;
      lcaCount: number | null;
      latestFiscalYear: number | null;
      matchedEmployerName: string | null;
      evidence: string | null;
    };
  };
  observed: {
    discoveredJobs: number;
    activeJobs: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    roles: { title: string; n: number }[];
    rolesTruncated: boolean;
    locations: { location: string; n: number }[];
    sources: { source: string; n: number }[];
  };
  applications: { jobId: number; title: string; stage: string; updatedAt: string | null }[];
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-1.5 border-b border-[var(--separator)] last:border-0">
      <span className="w-44 shrink-0 text-[13.5px] font-semibold text-secondary">{label}</span>
      <div className="min-w-0 flex-1 text-[14px] leading-relaxed text-primary">{children}</div>
    </div>
  );
}

export function CompanyIntelligence({
  companyId,
  candidateId,
}: {
  companyId: number;
  candidateId: number;
}) {
  const [data, setData] = useState<Intelligence | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(adminApiUrl(`/api/companies/${companyId}/intelligence`, candidateId))
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        if (!body) return setState("error");
        setData(body as Intelligence);
        setState("ready");
      })
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [companyId, candidateId]);

  if (state === "loading") {
    return (
      <div role="status" className="px-6 py-5 text-[14px] text-secondary flex items-center gap-2">
        <span className="admin-loading-mark !w-4 !h-4" aria-hidden="true" />
        <span>Loading observed company intelligence…</span>
      </div>
    );
  }

  if (state === "error" || !data) {
    return (
      <div className="px-6 py-5 text-[14px] text-red-600 dark:text-red-400">
        Company operational intelligence could not be loaded.
      </div>
    );
  }

  const { company, observed, applications } = data;
  const fmt = (d: string | null) =>
    d
      ? new Date(d).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "—";

  return (
    <div className="border-t border-[var(--border)] bg-[var(--surface-hover)] px-6 py-5 rounded-b-xl space-y-3">
      <p className="text-[13.5px] leading-relaxed text-secondary mb-3">
        <strong>Observed Discovery Profile:</strong> Figures below reflect postings scanned by CareerOps and actions recorded by candidates.
      </p>

      <Row label="Postings Observed">
        <span className="tabular-nums font-semibold">{observed.discoveredJobs.toLocaleString()}</span> discovered ·{" "}
        <span className="tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">
          {observed.activeJobs.toLocaleString()}
        </span>{" "}
        currently active
      </Row>

      <Row label="Observation Window">
        {fmt(observed.firstSeenAt)} to {fmt(observed.lastSeenAt)}
      </Row>

      <Row label="Roles Discovered">
        {observed.roles.length === 0 ? (
          <span className="text-tertiary">None recorded</span>
        ) : (
          <>
            {observed.roles.map((r) => `${r.title} (${r.n})`).join(" · ")}
            {observed.rolesTruncated && <span className="text-tertiary"> — top roles shown</span>}
          </>
        )}
      </Row>

      <Row label="Locations Discovered">
        {observed.locations.length === 0
          ? "None recorded"
          : observed.locations.map((l) => `${l.location} (${l.n})`).join(" · ")}
      </Row>

      <Row label="Configured Source">
        {company.configuredSource ? (
          <span className="font-mono font-medium text-primary">{company.configuredSource}</span>
        ) : (
          <span className="text-tertiary">No connector configured</span>
        )}
        {company.careerPageUrl && (
          <a
            href={company.careerPageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-3 text-[13.5px] text-[var(--accent)] hover:underline"
          >
            Visit Career Page ↗
          </a>
        )}
      </Row>

      <Row label="Last Scan Attempt">
        {fmt(company.lastScannedAt)}{" "}
        {company.lastScanStatus && (
          <span className="ml-2 rounded bg-[var(--z2-bg)] px-2 py-0.5 text-xs font-semibold uppercase text-secondary border border-[var(--border)]">
            {company.lastScanStatus}
          </span>
        )}
      </Row>

      <Row label="H-1B & LCA Record">
        <span className="font-semibold">{company.h1b.confidence ?? "Unknown"}</span>
        {typeof company.h1b.lcaCount === "number" && company.h1b.lcaCount > 0 && (
          <span className="text-secondary ml-2">
            · {company.h1b.lcaCount.toLocaleString()} filings
            {company.h1b.latestFiscalYear ? ` (FY${company.h1b.latestFiscalYear})` : ""}
          </span>
        )}
        {company.h1b.evidence && (
          <span className="block text-[13px] text-tertiary mt-1">{company.h1b.evidence}</span>
        )}
      </Row>

      <Row label="Candidate Applications">
        {applications.length === 0 ? (
          <span className="text-tertiary">No candidate applications submitted for this company yet.</span>
        ) : (
          <ul className="space-y-1 mt-1">
            {applications.map((a) => (
              <li key={a.jobId} className="flex items-center gap-2">
                <Link
                  href={`/jobs/${a.jobId}`}
                  className="font-medium text-[var(--accent)] hover:underline"
                >
                  {a.title}
                </Link>
                <span className="text-secondary text-[13px]">· {a.stage}</span>
              </li>
            ))}
          </ul>
        )}
      </Row>
    </div>
  );
}
