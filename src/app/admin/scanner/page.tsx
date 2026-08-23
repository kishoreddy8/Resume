"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AdminConfirmDialog,
  AdminEmptyState,
  AdminErrorState,
  AdminFeedbackBanner,
  AdminGuidanceCard,
  AdminLoadingState,
  AdminPageHeader,
  AdminStatus,
  HealthTile,
  OperationalTable,
  TechnicalDetails,
} from "@/components/admin";
import { useAdminCandidate } from "@/lib/admin/AdminContext";

type Provider = {
  provider: string;
  label: string;
  eligibleCompanies: number;
  recentSuccessfulScans: number;
  recentFailedScans: number;
  successRate: number | null;
  recoveringCount: number;
  needsReviewCount: number;
  downCount: number;
  healthyCount: number;
  activeJobs: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  interventionState: string;
};

type Run = {
  id: number;
  company: string;
  provider: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: string;
  discovered: number;
  added: number;
  updated: number;
  closed: number;
  errorCategory: string | null;
  errorMessage: string | null;
};

type Proposal = {
  id: number;
  company_id: number;
  proposed_source_type: string;
  proposed_board_token: string;
  confidence: string;
  validation_status: string;
  status: string;
};

type Projection = {
  generatedAt: string;
  settings: { scanEnabled: boolean };
  lock: { held: boolean; acquiredAt?: string | null };
  reliability: {
    healthy: number;
    recovering: number;
    needsReview: number;
    down: number;
    unknown: number;
  };
  providers: Provider[];
  runs: Run[];
  proposals: Proposal[];
  unresolvedCompanies: Array<{
    id: number;
    name: string;
    careerPageUrl: string | null;
    resolutionStatus: string;
    suspectedAts: string | null;
  }>;
};

type Tab = "status" | "history" | "connectors";

export default function AdminScannerPage() {
  const { candidateId } = useAdminCandidate();
  const searchParams = useSearchParams();
  const initial = searchParams.get("tab");
  const [tab, setTab] = useState<Tab>(
    initial === "connectors" || initial === "history" ? initial : "status"
  );
  const [data, setData] = useState<Projection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [requestCompany, setRequestCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState<Proposal | null>(null);
  const [confirmScanAll, setConfirmScanAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/scanner?candidateId=${candidateId}&limit=50`);
      if (!res.ok) {
        throw new Error((await res.json()).error ?? "Scanner operations unavailable");
      }
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scanner operations unavailable");
    }
  }, [candidateId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function requestConnector() {
    if (!requestCompany) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/companies/${requestCompany}/discover?candidateId=${candidateId}`,
        { method: "POST" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Connector discovery request failed");
      setFeedback("Connector discovery started for selected company.");
      setRequestCompany("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connector discovery request failed");
    } finally {
      setBusy(false);
    }
  }

  async function triggerScan() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/scan?candidateId=${candidateId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? json.message ?? "Scan trigger failed");
      setFeedback("Discovery scan run initiated successfully.");
      setConfirmScanAll(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan trigger failed");
    } finally {
      setBusy(false);
    }
  }

  async function decide(proposal: Proposal, action: "approve" | "reject") {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/companies/${proposal.company_id}/source-proposals/${proposal.id}/${action}?candidateId=${candidateId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }
      );
      if (!res.ok) throw new Error((await res.json()).error ?? "Proposal action failed");
      setFeedback(`Source proposal #${proposal.id} successfully ${action}d.`);
      setConfirmApprove(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Proposal action failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return <AdminErrorState detail={error} retry={() => void load()} />;
  }

  if (!data) {
    return <AdminLoadingState label="Loading scanner operations and connector catalog" />;
  }

  const isScannerEnabled = data.settings.scanEnabled;
  const isScanning = data.lock.held;

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="Discovery Machinery"
        title="Job Scanner"
        description="Monitor job discovery runs, inspect ATS connector reliability and coverage, trigger on-demand scans, and review discovered source proposals."
        statusSummary={
          <AdminStatus
            status={!isScannerEnabled ? "disabled" : isScanning ? "running" : "healthy"}
            label={!isScannerEnabled ? "Scanner Disabled" : isScanning ? "Scan In Progress" : "Scanner Ready"}
          />
        }
        actions={
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="admin-button admin-button-primary"
              disabled={busy || isScanning || !isScannerEnabled}
              onClick={() => setConfirmScanAll(true)}
              title={
                !isScannerEnabled
                  ? "Scanner is disabled in Settings"
                  : isScanning
                  ? "A scan lease is already held"
                  : "Trigger discovery scan for all active companies"
              }
            >
              {isScanning ? "Scanning in progress…" : "Trigger Scan"}
            </button>
            <button
              type="button"
              className="admin-button admin-button-secondary"
              disabled={busy}
              onClick={() => void load()}
            >
              Refresh
            </button>
          </div>
        }
      />

      {feedback && (
        <AdminFeedbackBanner
          tone="success"
          message={feedback}
          onDismiss={() => setFeedback(null)}
        />
      )}

      {error && (
        <AdminFeedbackBanner
          tone="error"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}

      {!isScannerEnabled && (
        <AdminGuidanceCard
          title="Automatic Scanning Disabled"
          purpose="Job discovery scans are currently turned off in Settings. No automatic ingestion will run until enabled."
          currentState="Scanner switch is OFF"
          nextSteps="Open Admin Settings to turn on automatic scheduled scanning."
          action={
            <Link href="/admin/settings" className="admin-button admin-button-secondary">
              Open Settings
            </Link>
          }
          tone="warning"
        />
      )}

      {/* Tabs */}
      <div className="admin-tabs" role="tablist" aria-label="Scanner sections">
        {[
          { id: "status", label: "Overview & Status" },
          { id: "history", label: `Run History (${data.runs.length})` },
          { id: "connectors", label: `ATS Connectors & Proposals (${data.providers.length})` },
        ].map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id as Tab)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Tab: Overview & Status */}
      {tab === "status" && (
        <>
          <div className="admin-health-grid admin-health-grid-four">
            <HealthTile
              label="Scanner State"
              status={!isScannerEnabled ? "disabled" : isScanning ? "running" : "idle"}
              value={!isScannerEnabled ? "Disabled" : isScanning ? "Running" : "Idle"}
              detail={isScanning ? "Scan lease held by worker" : "Ready for next scan window"}
            />
            <HealthTile
              label="Healthy Connectors"
              status="healthy"
              value={data.reliability.healthy}
              detail="Connectors operating normally"
            />
            <HealthTile
              label="Needs Review / Down"
              status={data.reliability.down > 0 ? "offline" : data.reliability.needsReview > 0 ? "needs_intervention" : "healthy"}
              value={data.reliability.down + data.reliability.needsReview}
              detail={`${data.reliability.down} down · ${data.reliability.needsReview} need review`}
            />
            <HealthTile
              label="Recovering Connectors"
              status={data.reliability.recovering > 0 ? "degraded" : "healthy"}
              value={data.reliability.recovering}
              detail="Recovering from previous errors"
            />
          </div>

          <section aria-labelledby="status-metrics-heading">
            <h2 id="status-metrics-heading" className="admin-section-title">
              Scanner Runtime State
            </h2>
            <div className="admin-operational-card">
              <dl className="admin-metric-list">
                <div>
                  <dt>Scan Schedule Enabled</dt>
                  <dd>{isScannerEnabled ? "Yes" : "No"}</dd>
                </div>
                <div>
                  <dt>Active Lease Lock</dt>
                  <dd>{isScanning ? "Held (Active)" : "None (Idle)"}</dd>
                </div>
                <div>
                  <dt>Last Completed Scan</dt>
                  <dd>
                    {data.runs[0]
                      ? new Date(data.runs[0].finishedAt).toLocaleString()
                      : "Never run"}
                  </dd>
                </div>
                <div>
                  <dt>Last Scan Outcome</dt>
                  <dd className="capitalize">{data.runs[0]?.status ?? "No runs recorded"}</dd>
                </div>
              </dl>
            </div>
          </section>
        </>
      )}

      {/* Tab: History */}
      {tab === "history" && (
        <section aria-labelledby="history-heading">
          <div className="admin-section-heading">
            <div>
              <h2 id="history-heading" className="admin-section-title">
                Recent Scan Executions
              </h2>
              <p>Bounded list of the latest 50 ATS discovery runs with job counts and durations.</p>
            </div>
          </div>
          {data.runs.length > 0 ? (
            <OperationalTable label="Recent scan history">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>ATS Connector</th>
                  <th>Started At</th>
                  <th>Status</th>
                  <th>Discovered</th>
                  <th>Added</th>
                  <th>Updated</th>
                  <th>Closed</th>
                  <th>Duration / Error</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((run) => (
                  <tr key={run.id}>
                    <td className="font-semibold text-primary">{run.company}</td>
                    <td>
                      <span className="font-mono text-[13.5px] font-medium text-secondary">
                        {run.provider}
                      </span>
                    </td>
                    <td className="text-secondary">{new Date(run.startedAt).toLocaleString()}</td>
                    <td>
                      <AdminStatus
                        status={
                          run.status === "success"
                            ? "completed"
                            : run.status === "partial"
                            ? "degraded"
                            : "failed"
                        }
                        label={run.status}
                      />
                    </td>
                    <td className="tabular-nums font-medium">{run.discovered}</td>
                    <td className="tabular-nums font-medium text-emerald-700 dark:text-emerald-400">
                      +{run.added}
                    </td>
                    <td className="tabular-nums font-medium text-secondary">{run.updated}</td>
                    <td className="tabular-nums font-medium text-tertiary">{run.closed}</td>
                    <td>
                      <span className="tabular-nums font-medium">
                        {(run.durationMs / 1000).toFixed(1)}s
                      </span>
                      {run.errorMessage && (
                        <TechnicalDetails summary="Error details">
                          <p>
                            <strong>Category:</strong> {run.errorCategory ?? "General"}<br />
                            <strong>Message:</strong> {run.errorMessage}
                          </p>
                        </TechnicalDetails>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </OperationalTable>
          ) : (
            <AdminEmptyState
              title="No scan history"
              detail="No scan executions have been recorded yet in durable storage."
            />
          )}
        </section>
      )}

      {/* Tab: Connectors & Proposals */}
      {tab === "connectors" && (
        <>
          <section aria-labelledby="connectors-heading">
            <div className="admin-section-heading">
              <div>
                <h2 id="connectors-heading" className="admin-section-title">
                  Supported ATS Connectors
                </h2>
                <p>
                  Health, reliability rates, and active job coverage across all supported ATS provider integrations.
                </p>
              </div>
            </div>
            <OperationalTable label="Supported ATS connectors catalog">
              <thead>
                <tr>
                  <th>ATS Connector</th>
                  <th>Connector Health</th>
                  <th>Success Rate</th>
                  <th>Active Jobs</th>
                  <th>Companies Bound</th>
                  <th>Last Success</th>
                  <th>Last Failure</th>
                  <th>Intervention Status</th>
                </tr>
              </thead>
              <tbody>
                {data.providers.map((p) => (
                  <tr key={p.provider}>
                    <td>
                      <strong className="text-primary font-bold">{p.label}</strong>
                      <div className="font-mono text-xs text-tertiary">{p.provider}</div>
                    </td>
                    <td>
                      <AdminStatus
                        status={p.downCount > 0 ? "offline" : p.healthyCount > 0 ? "healthy" : "unknown"}
                      />
                    </td>
                    <td className="tabular-nums font-medium">
                      {p.successRate === null ? "No recent runs" : `${Math.round(p.successRate * 100)}%`}
                    </td>
                    <td className="tabular-nums font-semibold text-primary">
                      {p.activeJobs.toLocaleString()} jobs
                    </td>
                    <td className="tabular-nums text-secondary">{p.eligibleCompanies}</td>
                    <td className="text-secondary">
                      {p.lastSuccess ? new Date(p.lastSuccess).toLocaleString() : "Never"}
                    </td>
                    <td className="text-secondary">
                      {p.lastFailure ? new Date(p.lastFailure).toLocaleString() : "Never"}
                    </td>
                    <td>
                      <AdminStatus
                        status={
                          p.interventionState === "Healthy"
                            ? "healthy"
                            : p.interventionState === "Recovering"
                            ? "degraded"
                            : p.interventionState === "Not configured"
                            ? "unknown"
                            : "needs_intervention"
                        }
                        label={p.interventionState}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </OperationalTable>
          </section>

          <div className="admin-two-column">
            {/* Discover connector */}
            <section aria-labelledby="discover-heading">
              <h2 id="discover-heading" className="admin-section-title">
                Discover Company Connector
              </h2>
              <div className="admin-operational-card space-y-4">
                <p className="admin-card-description">
                  Select an unresolved company to run CareerOps&rsquo; bounded ATS discovery flow. Validated endpoints become source proposals below.
                </p>
                <label className="admin-field">
                  <span>Select Unresolved Company</span>
                  <select
                    value={requestCompany}
                    onChange={(e) => setRequestCompany(e.target.value)}
                    disabled={busy || data.unresolvedCompanies.length === 0}
                  >
                    <option value="">
                      {data.unresolvedCompanies.length === 0
                        ? "No unresolved companies available"
                        : "Choose a company to discover…"}
                    </option>
                    {data.unresolvedCompanies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.resolutionStatus}
                        {c.suspectedAts ? ` (${c.suspectedAts})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="admin-button admin-button-primary"
                  disabled={!requestCompany || busy}
                  onClick={() => void requestConnector()}
                >
                  {busy ? "Discovering…" : "Request Connector Review"}
                </button>
              </div>
            </section>

            {/* Source proposals */}
            <section aria-labelledby="proposals-heading">
              <h2 id="proposals-heading" className="admin-section-title">
                Reviewed Source Proposals ({data.proposals.length})
              </h2>
              {data.proposals.length > 0 ? (
                <ul className="admin-intervention-list">
                  {data.proposals.map((p) => {
                    const isApprovable =
                      p.confidence === "HIGH" && p.validation_status === "VALIDATED_JOBS";
                    return (
                      <li key={p.id} className="flex-col !items-start gap-3">
                        <div className="w-full">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="font-bold text-primary">{p.proposed_source_type}</h3>
                            <div className="flex items-center gap-1.5">
                              <span className="rounded-md border border-[var(--border)] px-2 py-0.5 text-xs font-semibold uppercase text-secondary">
                                {p.confidence}
                              </span>
                              <span className="rounded-md border border-[var(--border)] px-2 py-0.5 text-xs font-semibold uppercase text-secondary">
                                {p.validation_status}
                              </span>
                            </div>
                          </div>
                          <p className="mt-1 text-secondary">
                            Company #{p.company_id} · Board Token:{" "}
                            <span className="font-mono text-primary font-medium">
                              {p.proposed_board_token}
                            </span>
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--separator)] w-full justify-between">
                          {!isApprovable ? (
                            <span className="text-xs text-amber-800 dark:text-amber-300 font-medium">
                              Requires HIGH confidence & VALIDATED_JOBS status
                            </span>
                          ) : (
                            <span className="text-xs text-emerald-800 dark:text-emerald-300 font-medium">
                              Validated and ready to approve
                            </span>
                          )}
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="admin-button admin-button-primary !min-h-[38px] !text-xs"
                              disabled={busy || !isApprovable}
                              onClick={() => setConfirmApprove(p)}
                              title={
                                !isApprovable
                                  ? "Cannot approve: Proposal is not high confidence or jobs not validated"
                                  : "Approve this source configuration"
                              }
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className="admin-button admin-button-secondary !min-h-[38px] !text-xs"
                              disabled={busy}
                              onClick={() => void decide(p, "reject")}
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <AdminEmptyState
                  title="No pending source proposals"
                  detail="No automated connector candidates are waiting for operator review."
                />
              )}
            </section>
          </div>
        </>
      )}

      {/* Confirm Approve Proposal */}
      <AdminConfirmDialog
        open={confirmApprove !== null}
        title="Approve Validated Connector Source?"
        description={`This applies the ${confirmApprove?.proposed_source_type} connector configuration for Company #${confirmApprove?.company_id}. It will enable scheduled job discovery for this company.`}
        confirmLabel="Approve Source"
        busy={busy}
        onClose={() => setConfirmApprove(null)}
        onConfirm={() => confirmApprove && void decide(confirmApprove, "approve")}
      />

      {/* Confirm Trigger Scan */}
      <AdminConfirmDialog
        open={confirmScanAll}
        title="Trigger Full Discovery Scan?"
        description="This will start an immediate discovery scan across all active companies using their configured ATS connectors."
        confirmLabel="Start Scan Now"
        busy={busy}
        onClose={() => setConfirmScanAll(false)}
        onConfirm={() => void triggerScan()}
      />
    </div>
  );
}
