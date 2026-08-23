"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AdminConfirmDialog,
  AdminEmptyState,
  AdminErrorState,
  AdminFeedbackBanner,
  AdminLoadingState,
  AdminPageHeader,
  AdminStatus,
  OperationalCardList,
  OperationalTable,
  TechnicalDetails,
} from "@/components/admin";
import { useAdminCandidate } from "@/lib/admin/AdminContext";
import { CompanyIntelligence } from "./CompanyIntelligence";

type CompanyRow = {
  id: number;
  name: string;
  sourceType: string;
  isActive: number;
  connectorHealth: string;
  resolutionStatus: string;
  lastScannedAt: string | null;
  lastScanStatus: string | null;
  consecutiveFailures: number;
  lastErrorMessage: string | null;
  activeJobs: number;
  careerPageUrl: string | null;
  discoveryReason: string | null;
};

type ResponseData = {
  companies: CompanyRow[];
  page: number;
  total: number;
  totalPages: number;
};

export default function AdminCompaniesPage() {
  const { candidateId } = useAdminCandidate();
  const [search, setSearch] = useState("");
  const [active, setActive] = useState("");
  const [health, setHealth] = useState("");
  const [sort, setSort] = useState("name");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ResponseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{
    company: CompanyRow;
    action: "delete" | "toggle";
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        candidateId: String(candidateId),
        page: String(page),
        limit: "25",
        search,
        active,
        health,
        sort,
      });
      const res = await fetch(`/api/admin/companies?${params}`);
      if (!res.ok) {
        throw new Error((await res.json()).error ?? "Companies registry unavailable");
      }
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Companies registry unavailable");
    }
  }, [candidateId, page, search, active, health, sort]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 150);
    return () => clearTimeout(timer);
  }, [load]);

  async function scan(company: CompanyRow) {
    setBusy(company.id);
    setFeedback(null);
    try {
      const res = await fetch(`/api/scan?candidateId=${candidateId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? json.error ?? "Scan failed");
      setFeedback(`Discovery scan completed for ${company.name}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setBusy(null);
    }
  }

  async function confirmAction() {
    if (!confirm) return;
    setBusy(confirm.company.id);
    setFeedback(null);
    try {
      const url = `/api/companies/${confirm.company.id}?candidateId=${candidateId}`;
      const res = await fetch(
        url,
        confirm.action === "delete"
          ? { method: "DELETE" }
          : {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ is_active: !confirm.company.isActive }),
            }
      );
      if (!res.ok) throw new Error((await res.json()).error ?? "Company action failed");
      setFeedback(
        confirm.action === "delete"
          ? `Deleted company ${confirm.company.name}.`
          : `${confirm.company.isActive ? "Paused" : "Resumed"} discovery for ${confirm.company.name}.`
      );
      setConfirm(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Company action failed");
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) {
    return <AdminErrorState detail={error} retry={() => void load()} />;
  }

  if (!data) {
    return <AdminLoadingState label="Loading company registry and source configurations" />;
  }

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="Source Registry"
        title="Company Registry"
        description="Search, inspect, and configure company career page sources, active ATS connector bindings, and scan frequencies."
        statusSummary={
          <AdminStatus
            status="healthy"
            label={`${data.total.toLocaleString()} Companies Registered`}
          />
        }
        actions={
          <button
            type="button"
            className="admin-button admin-button-secondary"
            onClick={() => void load()}
          >
            Refresh
          </button>
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

      {/* Filter Bar */}
      <div className="admin-filter-bar">
        <label>
          <span>Search by Company Name</span>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Type company name…"
          />
        </label>
        <label>
          <span>Active State</span>
          <select
            value={active}
            onChange={(e) => {
              setActive(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All States</option>
            <option value="active">Active Only</option>
            <option value="paused">Paused Only</option>
          </select>
        </label>
        <label>
          <span>Connector Health</span>
          <select
            value={health}
            onChange={(e) => {
              setHealth(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Health Statuses</option>
            <option value="healthy">Healthy</option>
            <option value="degraded">Degraded</option>
            <option value="down">Down / Offline</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          <span>Sort Order</span>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
          >
            <option value="name">Company Name (A–Z)</option>
            <option value="last_scan">Last Scan Time</option>
            <option value="failures">Consecutive Failures</option>
          </select>
        </label>
      </div>

      {/* Companies List */}
      {data.companies.length === 0 ? (
        <AdminEmptyState
          title="No companies found"
          detail="No companies match the selected search and filter criteria. Adjust your filters or request a new company connector via Scanner."
        />
      ) : (
        <>
          <OperationalTable label="Company source registry table">
            <thead>
              <tr>
                <th>Company</th>
                <th>ATS / Source Type</th>
                <th>Status</th>
                <th>Connector Health</th>
                <th>Last Scanned</th>
                <th>Active Jobs</th>
                <th>Failures</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.companies.map((c) => {
                const isExpanded = expandedId === c.id;
                const isScanningThis = busy === c.id;
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="font-bold text-primary text-[15.5px]">{c.name}</div>
                      <div className="admin-meta">
                        #{c.id} · <span className="uppercase text-xs">{c.resolutionStatus}</span>
                      </div>
                    </td>
                    <td>
                      <span className="font-mono text-sm font-semibold text-secondary">
                        {c.sourceType}
                      </span>
                    </td>
                    <td>
                      <AdminStatus
                        status={c.isActive ? "healthy" : "disabled"}
                        label={c.isActive ? "Active" : "Paused"}
                      />
                    </td>
                    <td>
                      <AdminStatus status={c.connectorHealth} />
                    </td>
                    <td className="text-secondary text-sm">
                      {c.lastScannedAt ? new Date(c.lastScannedAt).toLocaleString() : "Never"}
                      {c.lastScanStatus && (
                        <div className="text-xs text-tertiary">{c.lastScanStatus}</div>
                      )}
                    </td>
                    <td className="tabular-nums font-bold text-primary text-base">
                      {c.activeJobs.toLocaleString()}
                    </td>
                    <td className="tabular-nums font-medium text-secondary">
                      {c.consecutiveFailures > 0 ? (
                        <span className="text-red-700 dark:text-red-400 font-bold">
                          {c.consecutiveFailures}
                        </span>
                      ) : (
                        "0"
                      )}
                    </td>
                    <td>
                      <div className="admin-row-actions">
                        <button
                          type="button"
                          className="admin-button admin-button-primary !min-h-[38px] !text-xs"
                          disabled={isScanningThis || !c.isActive}
                          onClick={() => void scan(c)}
                          title={
                            !c.isActive
                              ? "Company is paused. Resume company before scanning."
                              : "Run immediate discovery scan for this company"
                          }
                        >
                          {isScanningThis ? "Scanning…" : "Scan"}
                        </button>
                        <button
                          type="button"
                          className="admin-button admin-button-secondary !min-h-[38px] !text-xs"
                          onClick={() => setExpandedId(isExpanded ? null : c.id)}
                          aria-expanded={isExpanded}
                          aria-label={`View intelligence for ${c.name}`}
                        >
                          {isExpanded ? "Hide Intel" : "Intel"}
                        </button>
                        <details>
                          <summary aria-label={`More options for ${c.name}`}>•••</summary>
                          <div>
                            <button
                              type="button"
                              onClick={() => setConfirm({ company: c, action: "toggle" })}
                            >
                              {c.isActive ? "Pause Discovery" : "Resume Discovery"}
                            </button>
                            <button
                              type="button"
                              className="text-red-700 dark:text-red-400"
                              onClick={() => setConfirm({ company: c, action: "delete" })}
                            >
                              Delete Company
                            </button>
                          </div>
                        </details>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </OperationalTable>

          {/* Expanded Company Intelligence view if opened */}
          {expandedId !== null && (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--z2-bg)] p-4 shadow-sm">
              <div className="flex items-center justify-between pb-3 border-b border-[var(--separator)] mb-3">
                <h3 className="text-base font-bold text-primary">
                  Observed Intelligence for Company #{expandedId}
                </h3>
                <button
                  type="button"
                  onClick={() => setExpandedId(null)}
                  className="text-xs font-semibold text-secondary hover:text-primary"
                >
                  Close Intel ✕
                </button>
              </div>
              <CompanyIntelligence companyId={expandedId} candidateId={candidateId} />
            </div>
          )}

          {/* Mobile responsive cards */}
          <OperationalCardList>
            {data.companies.map((c) => (
              <article key={c.id} className="admin-card admin-mobile-card">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-bold text-lg">{c.name}</h2>
                    <p className="text-sm text-secondary">
                      {c.sourceType} · {c.activeJobs} active jobs
                    </p>
                  </div>
                  <AdminStatus status={c.connectorHealth} />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="admin-button admin-button-primary flex-1"
                    disabled={busy === c.id || !c.isActive}
                    onClick={() => void scan(c)}
                  >
                    Scan
                  </button>
                  <button
                    type="button"
                    className="admin-button admin-button-secondary"
                    onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                  >
                    {expandedId === c.id ? "Hide" : "Intel"}
                  </button>
                </div>
                {expandedId === c.id && (
                  <CompanyIntelligence companyId={c.id} candidateId={candidateId} />
                )}
                {c.lastErrorMessage && (
                  <TechnicalDetails summary="Last failure reason">
                    <p>{c.lastErrorMessage}</p>
                  </TechnicalDetails>
                )}
              </article>
            ))}
          </OperationalCardList>
        </>
      )}

      {/* Pagination */}
      <nav className="admin-pagination" aria-label="Company registry pages">
        <button
          type="button"
          className="admin-button admin-button-secondary"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span className="tabular-nums font-medium">
          Page {data.page} of {data.totalPages} · {data.total.toLocaleString()} total companies
        </span>
        <button
          type="button"
          className="admin-button admin-button-secondary"
          disabled={page >= data.totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </nav>

      {/* Confirmation Dialog for Delete / Pause / Resume */}
      <AdminConfirmDialog
        open={confirm !== null}
        title={
          confirm?.action === "delete"
            ? `Delete ${confirm?.company.name}?`
            : `${confirm?.company.isActive ? "Pause" : "Resume"} ${confirm?.company.name}?`
        }
        description={
          confirm?.action === "delete"
            ? `This removes ${confirm?.company.name} and its source connector bindings from the registry. Existing discovered jobs remain preserved.`
            : confirm?.company.isActive
            ? `Pausing ${confirm?.company.name} will exclude it from automatic background scans.`
            : `Resuming ${confirm?.company.name} will re-enable automatic scheduled scans for this company.`
        }
        confirmLabel={
          confirm?.action === "delete"
            ? "Delete Company"
            : confirm?.company.isActive
            ? "Pause Discovery"
            : "Resume Discovery"
        }
        destructive={confirm?.action === "delete"}
        busy={busy !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => void confirmAction()}
      />
    </div>
  );
}
