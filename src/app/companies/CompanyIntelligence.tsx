"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * What Career-Ops has observed about one company.
 *
 * THE WORDING IS THE FEATURE. Every figure here comes from postings this installation happened to
 * scan and actions this user happened to take. A role Career-Ops never saw is simply missing, and
 * its absence means nothing about the company. So the panel says "observed in Career-Ops" rather
 * than describing hiring strategy, and never presents scanned postings as market demand — a sample
 * relabelled as a fact is the most convincing kind of wrong.
 *
 * BOUNDED AND LAZY. The endpoint aggregates in SQL and caps its lists: a company with 1,451
 * postings returns 1,416 bytes. It is fetched only when a row is opened, so the companies list
 * costs nothing extra.
 */

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
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 py-1">
      <span className="w-[9rem] shrink-0 text-[11px] uppercase tracking-[0.07em] text-tertiary">{label}</span>
      <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-secondary">{children}</div>
    </div>
  );
}

export function CompanyIntelligence({ companyId, candidateId }: { companyId: number; candidateId: number }) {
  const [data, setData] = useState<Intelligence | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/companies/${companyId}/intelligence?candidateId=${candidateId}`)
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

  if (state === "loading")
    return (
      <p role="status" className="px-4 py-3 text-[12px] text-tertiary">
        Loading what Career-Ops has observed…
      </p>
    );
  if (state === "error" || !data)
    return <p className="px-4 py-3 text-[12px] text-tertiary">This company&rsquo;s details could not be loaded.</p>;

  const { company, observed, applications } = data;
  const fmt = (d: string | null) =>
    d ? new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

  return (
    <div className="border-t border-[var(--separator)] bg-[var(--z0-bg)] px-4 py-3">
      <p className="mb-2 text-[11px] leading-relaxed text-tertiary">
        Everything below is what Career-Ops has seen while scanning, and what you have recorded. It is
        not a description of the company&rsquo;s hiring.
      </p>

      <Row label="Postings seen">
        <span className="tabular-nums">{observed.discoveredJobs.toLocaleString()}</span> discovered ·{" "}
        <span className="tabular-nums">{observed.activeJobs.toLocaleString()}</span> currently active
      </Row>
      <Row label="Seen between">
        {fmt(observed.firstSeenAt)} and {fmt(observed.lastSeenAt)}
      </Row>

      <Row label="Roles observed">
        {observed.roles.length === 0 ? (
          <span className="text-tertiary">None recorded.</span>
        ) : (
          <>
            {observed.roles.map((r) => `${r.title} (${r.n})`).join(" · ")}
            {observed.rolesTruncated && <span className="text-tertiary"> — most frequent shown</span>}
          </>
        )}
      </Row>

      <Row label="Locations observed">
        {observed.locations.length === 0
          ? "None recorded."
          : observed.locations.map((l) => `${l.location} (${l.n})`).join(" · ")}
      </Row>

      <Row label="Source systems">
        {observed.sources.length === 0
          ? "None recorded."
          : observed.sources.map((s) => `${s.source} (${s.n})`).join(" · ")}
        {company.configuredSource && (
          <span className="text-tertiary"> · configured as {company.configuredSource}</span>
        )}
      </Row>

      <Row label="Last scan">
        {fmt(company.lastScannedAt)}
        {company.lastScanStatus && <span className="text-tertiary"> · {company.lastScanStatus}</span>}
      </Row>

      {/* Passed through from the existing H1B layer — this panel computes no sponsorship signal. */}
      <Row label="Sponsorship">
        {company.h1b.confidence ?? "Unknown"}
        {typeof company.h1b.lcaCount === "number" && company.h1b.lcaCount > 0 && (
          <span className="text-tertiary">
            {" "}
            · {company.h1b.lcaCount.toLocaleString()} LCA records
            {company.h1b.latestFiscalYear ? ` through FY${company.h1b.latestFiscalYear}` : ""}
          </span>
        )}
        {company.h1b.evidence && <span className="block text-[11px] text-tertiary">{company.h1b.evidence}</span>}
      </Row>

      <Row label="Your history">
        {applications.length === 0 ? (
          <span className="text-tertiary">You have not acted on any job at this company.</span>
        ) : (
          <ul className="space-y-0.5">
            {applications.map((a) => (
              <li key={a.jobId}>
                <Link href={`/jobs/${a.jobId}`} className="underline-offset-2 hover:underline">
                  {a.title}
                </Link>
                <span className="text-tertiary"> — {a.stage}</span>
              </li>
            ))}
          </ul>
        )}
      </Row>
    </div>
  );
}
