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
  DESCRIPTION_FETCH_FAILURE: "description fetch failure",
  UNCLASSIFIED: "unclassified",
};

// Deliberately neutral, not alarming — these are data-quality/verification notes, not operational
// problems. A company can be fully healthy and still carry one of these (see AtsCoverageWarning's
// own doc comment in atsCoverage.ts for exactly what does and doesn't produce one).
const WARNING_LABELS: Record<string, string> = {
  LOCATION_UNKNOWN: "location warning",
  DESCRIPTION_PARTIAL: "description warning",
  SAMPLE_VERIFICATION: "verification sample only",
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
              {c.warnings.length > 0 && (
                <div className="mt-0.5 max-w-md text-blue-600 dark:text-blue-400">
                  {c.warnings.map((w) => w.label).join(" · ")}
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

// --- Discovery V2 Stage 3: Source Recovery Proposals ----------------------------------------------
// Deliberately separate confidence styling — HIGH looks like a normal review item, MEDIUM carries an
// explicit "zero jobs, needs more review" warning, LOW/failed is visually disabled (never
// approvable), and SECURITY_REJECTED-derived candidates are red and never approvable. Approval here
// only ever changes SOURCE CONFIGURATION — never implies the connector is healthy or jobs already
// loaded (see atsSourceProposals.ts's own doc comment); the next real scan proves that separately.

interface SourceProposal {
  id: number;
  company_id: number;
  current_source_type: string | null;
  current_board_token: string | null;
  proposed_source_type: string;
  proposed_board_token: string;
  proposed_canonical_url: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  validation_status: string;
  recommendation: string;
  evidence_json: string;
  status: string;
  created_at: string;
}

const CONFIDENCE_STYLES: Record<string, string> = {
  HIGH: "border-zinc-200 dark:border-zinc-800",
  MEDIUM: "border-amber-300 dark:border-amber-800",
  LOW: "border-zinc-200 dark:border-zinc-800 opacity-60",
};

function isApprovable(p: SourceProposal): boolean {
  if (p.confidence === "LOW") return false;
  return p.validation_status === "VALIDATED_JOBS" || p.validation_status === "VALIDATED_ZERO_JOBS";
}

function ProposalCard({ proposal, onDecided }: { proposal: SourceProposal; onDecided: () => void }) {
  const [busy, setBusy] = useState(false);
  const approvable = isApprovable(proposal);
  const securityRejected = proposal.validation_status === "SECURITY_REJECTED";
  let evidence: { evidenceTypes?: string[]; evidenceUrls?: string[] } = {};
  try {
    evidence = JSON.parse(proposal.evidence_json);
  } catch {
    // malformed/legacy evidence — render without it rather than crash the card
  }

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    try {
      const res = await fetch(`/api/companies/${proposal.company_id}/source-proposals/${proposal.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) onDecided();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`rounded border p-3 ${securityRejected ? "border-red-400 dark:border-red-800" : CONFIDENCE_STYLES[proposal.confidence]}`}>
      <div className="flex items-center justify-between">
        <span className="font-medium">Company #{proposal.company_id}</span>
        <span
          className={
            securityRejected
              ? "text-xs font-semibold text-red-600 dark:text-red-400"
              : proposal.confidence === "HIGH"
                ? "text-xs font-semibold text-emerald-700 dark:text-emerald-400"
                : proposal.confidence === "MEDIUM"
                  ? "text-xs font-semibold text-amber-700 dark:text-amber-400"
                  : "text-xs font-semibold text-zinc-400"
          }
        >
          {securityRejected ? "SECURITY REJECTED" : proposal.confidence}
        </span>
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        current: {proposal.current_source_type ?? "(none)"} / {proposal.current_board_token ?? "(none)"}
      </div>
      <div className="text-xs text-zinc-700 dark:text-zinc-300">
        proposed: {proposal.proposed_source_type} / {proposal.proposed_board_token}
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        validation: {proposal.validation_status} · recommendation: {proposal.recommendation}
      </div>
      {proposal.confidence === "MEDIUM" && (
        <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          Board is reachable and structurally valid but currently shows zero jobs — needs human review before approval, not automatically healthy.
        </div>
      )}
      {evidence.evidenceTypes && evidence.evidenceTypes.length > 0 && (
        <div className="mt-1 text-xs text-zinc-400">evidence: {evidence.evidenceTypes.join(", ")}</div>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={!approvable || busy}
          onClick={() => decide("approve")}
          className={`rounded px-2 py-1 text-xs font-medium ${
            approvable
              ? "bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              : "cursor-not-allowed bg-zinc-200 text-zinc-400 dark:bg-zinc-800"
          }`}
          title={approvable ? "Approve this source configuration" : "Not approvable at this confidence/validation level"}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide("reject")}
          className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function SourceProposalsSection() {
  const [proposals, setProposals] = useState<SourceProposal[] | null>(null);

  async function load() {
    const res = await fetch("/api/ats-source-proposals");
    const json = await res.json();
    setProposals(json.proposals ?? []);
  }

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, []);

  if (proposals === null) return null;

  return (
    <Section
      title={`Source Recovery Proposals (${proposals.length})`}
      subtitle="Discovery V2 candidates awaiting explicit human review. Approving only changes source configuration — it does not mean the connector is healthy or jobs are already loaded; the next normal scan verifies that separately."
    >
      {proposals.length === 0 ? (
        <p className="text-xs text-zinc-500">No pending source proposals.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} onDecided={load} />
          ))}
        </div>
      )}
    </Section>
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

      <SourceProposalsSection />

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
                {Object.keys(g.warningBreakdown).length > 0 && (
                  <div className="mt-0.5 text-xs text-blue-600 dark:text-blue-400">
                    {Object.entries(g.warningBreakdown)
                      .map(([code, count]) => `${count} ${WARNING_LABELS[code] ?? code}`)
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
