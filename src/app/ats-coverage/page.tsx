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

// Stage 4: production approval is restricted to HIGH confidence + VALIDATED_JOBS only. Mirrors
// isProposalApprovable() in src/db/queries/atsSourceProposals.ts — the server enforces this
// independently, this is only for honest button state, not the actual gate.
function isApprovable(p: SourceProposal): boolean {
  return p.confidence === "HIGH" && p.validation_status === "VALIDATED_JOBS";
}

function notApprovableReason(p: SourceProposal): string {
  if (p.validation_status === "SECURITY_REJECTED") return "Security-rejected candidates are never approvable.";
  if (p.confidence === "LOW") return "LOW confidence is never approvable.";
  if (p.confidence === "MEDIUM" && p.validation_status === "VALIDATED_ZERO_JOBS") {
    return "MEDIUM confidence (board valid, zero jobs currently seen) is review-only in Stage 4 — not approvable yet.";
  }
  return "Not approvable at this confidence/validation level.";
}

function ProposalCard({ proposal, onDecided }: { proposal: SourceProposal; onDecided: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
      setConfirming(false);
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
          Not approvable in Stage 4.
        </div>
      )}
      {evidence.evidenceTypes && evidence.evidenceTypes.length > 0 && (
        <div className="mt-1 text-xs text-zinc-400">evidence: {evidence.evidenceTypes.join(", ")}</div>
      )}

      {confirming ? (
        <div className="mt-2 rounded border border-emerald-300 bg-emerald-50 p-2 text-xs dark:border-emerald-800 dark:bg-emerald-950/20">
          <p className="font-medium text-emerald-900 dark:text-emerald-200">Confirm: approve source configuration?</p>
          <dl className="mt-1 space-y-0.5 text-emerald-800 dark:text-emerald-300">
            <div>Current Source: {proposal.current_source_type ?? "(none)"} / {proposal.current_board_token ?? "(none)"}</div>
            <div>Proposed Source: {proposal.proposed_source_type} / {proposal.proposed_board_token}</div>
            <div>Validation: {proposal.validation_status}</div>
            <div>Confidence: {proposal.confidence}</div>
          </dl>
          <p className="mt-1 text-emerald-700 dark:text-emerald-400">
            This only accepts the source configuration. It does not mean jobs are loaded, the connector is healthy, or the company has open
            jobs — the next normal scan verifies that separately.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => decide("approve")}
              className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Confirm approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={!approvable || busy}
            onClick={() => setConfirming(true)}
            className={`rounded px-2 py-1 text-xs font-medium ${
              approvable
                ? "bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                : "cursor-not-allowed bg-zinc-200 text-zinc-400 dark:bg-zinc-800"
            }`}
            title={approvable ? "Approve source configuration" : notApprovableReason(proposal)}
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
      )}
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

interface ConnectorReliabilitySummary {
  healthy: number;
  recovering: number;
  needsReview: number;
  down: number;
  unknown: number;
  needsAttention: { id: number; name: string; sourceType: string; state: "NEEDS_REVIEW" | "DOWN"; reason: string }[];
}

interface ProviderHealthSummary {
  provider: string;
  eligibleCompanies: number;
  recentSuccessfulScans: number;
  recentFailedScans: number;
  successRate: number | null;
  dominantFailureCategory: string | null;
  recoveringCount: number;
  needsReviewCount: number;
  downCount: number;
  healthyCount: number;
}

const RELIABILITY_STATE_STYLES: Record<string, string> = {
  NEEDS_REVIEW: "text-blue-700 dark:text-blue-400",
  DOWN: "text-red-600 dark:text-red-400",
};

/** Phase 11 — the top-line "Connector Reliability" counts, per-provider success rates, and the
 *  "Needs Attention" list (NEEDS_REVIEW/DOWN only — RECOVERING is deliberately never listed here, so
 *  the panel isn't overwhelmed by expected, self-healing transient failures). */
function ReliabilitySection() {
  const [data, setData] = useState<{ summary: ConnectorReliabilitySummary; providers: ProviderHealthSummary[] } | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/connector-reliability");
      setData(await res.json());
    })();
  }, []);

  if (!data) return null;
  const { summary, providers } = data;

  return (
    <Section
      title="Connector reliability"
      subtitle="Automatic failure detection, retry, and stale-source rediscovery status — derived from real scan outcomes, never from a discovery attempt alone."
    >
      <div className="flex flex-wrap gap-4 text-sm">
        <span className="text-emerald-700 dark:text-emerald-400">{summary.healthy} healthy</span>
        <span className="text-amber-700 dark:text-amber-400">{summary.recovering} recovering</span>
        <span className="text-blue-700 dark:text-blue-400">{summary.needsReview} needs review</span>
        <span className="text-red-600 dark:text-red-400">{summary.down} down</span>
        {summary.unknown > 0 && <span className="text-zinc-400">{summary.unknown} never scanned</span>}
      </div>

      {providers.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {providers.map((p) => (
            <div key={p.provider} className="flex items-center justify-between rounded border border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
              <span>{PROVIDER_LABELS[p.provider as keyof typeof PROVIDER_LABELS] ?? p.provider}</span>
              <span className="text-zinc-500">
                {p.successRate === null ? "no recent scans" : `${Math.round(p.successRate * 100)}% success`}
                {p.dominantFailureCategory ? ` · mostly ${p.dominantFailureCategory}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {summary.needsAttention.length > 0 && (
        <div className="mt-3 space-y-1">
          <p className="text-xs font-medium text-zinc-500">Needs attention</p>
          {summary.needsAttention.map((c) => (
            <div key={c.id} className="text-xs">
              <span className={RELIABILITY_STATE_STYLES[c.state]}>{c.state === "NEEDS_REVIEW" ? "Needs review" : "Down"}</span>
              {" — "}
              <span className="font-medium">{c.name}</span>
              {" — "}
              <span className="text-zinc-500">{c.reason}</span>
            </div>
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
        <h1 className="page-title">ATS coverage &amp; source health</h1>
        <p className="text-sm text-zinc-500">
          What&apos;s blocking job discovery, and what to improve next — derived from the {data.totals.companies}{" "}
          companies currently in the registry. See the{" "}
          <a href="/companies" className="underline">
            Companies
          </a>{" "}
          page to add sources or retry discovery.
        </p>
      </div>

      <ReliabilitySection />

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
