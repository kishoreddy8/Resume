"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminLoadingState,
  AdminPageHeader,
  AdminStatus,
  OperationalTable,
  TechnicalDetails,
} from "@/components/admin";
import { useAdminCandidate } from "@/lib/admin/AdminContext";

type ApplicationRun = {
  id: number;
  candidate: string;
  jobTitle: string | null;
  company: string | null;
  ats: string | null;
  status: string;
  waitingReason: string | null;
  createdAt: string;
  updatedAt: string;
  latestEvent: string | null;
  latestEventDetail: string | null;
};

type AppData = {
  runs: ApplicationRun[];
  page: number;
  total: number;
  totalPages: number;
};

const FILTERS = [
  "",
  "QUEUED",
  "RUNNING",
  "ACCOUNT_REQUIRED",
  "WAITING_FOR_ANSWER",
  "WAITING_FOR_CAPTCHA",
  "WAITING_FOR_MFA",
  "WAITING_FOR_EMAIL_VERIFICATION",
  "READY_FOR_REVIEW",
  "WAITING_FOR_SUBMIT_APPROVAL",
  "SUBMITTING",
  "SUBMITTED",
  "SUBMISSION_UNCONFIRMED",
  "FAILED",
  "CANCELLED",
  "COMPLETED",
];

function getRunStatusPresentation(s: string) {
  if (s === "SUBMITTED" || s === "COMPLETED") return "completed";
  if (s === "FAILED" || s === "SUBMISSION_UNCONFIRMED") return "failed";
  if (s.includes("WAITING") || s === "ACCOUNT_REQUIRED" || s === "READY_FOR_REVIEW")
    return "needs_intervention";
  if (s === "RUNNING" || s === "SUBMITTING") return "running";
  if (s === "QUEUED") return "queued";
  return "unknown";
}

export default function AdminApplicationsPage() {
  const { candidateId } = useAdminCandidate();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [data, setData] = useState<AppData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({
        candidateId: String(candidateId),
        page: String(page),
        limit: "25",
        status: filter,
      });
      const r = await fetch(`/api/admin/application-runs?${p}`);
      if (!r.ok) {
        throw new Error((await r.json()).error ?? "Application operations data unavailable");
      }
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Application operations data unavailable");
    }
  }, [candidateId, page, filter]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  if (error && !data) {
    return <AdminErrorState detail={error} retry={() => void load()} />;
  }

  if (!data) {
    return <AdminLoadingState label="Loading application runs and execution pipeline state" />;
  }

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="Pipeline Execution"
        title="Application Operations"
        description="Observe cross-candidate application execution health, intervention bottlenecks, and status transitions."
        statusSummary={
          <AdminStatus
            status="healthy"
            label={`${data.total} Total Runs Tracked`}
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

      {/* Filter Bar */}
      <div className="admin-filter-bar admin-filter-compact">
        <label>
          <span>Filter by Operational Stage</span>
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(1);
            }}
          >
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {f ? f.replaceAll("_", " ") : "All Stages"}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Runs Table */}
      {data.runs.length > 0 ? (
        <OperationalTable label="Application run executions table">
          <thead>
            <tr>
              <th>Run ID</th>
              <th>Candidate</th>
              <th>Target Job & Company</th>
              <th>ATS Connector</th>
              <th>Current Stage</th>
              <th>Waiting / Block Reason</th>
              <th>Last Updated</th>
              <th>Latest Event</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <span className="font-mono font-bold text-primary">#{run.id}</span>
                </td>
                <td className="font-medium text-primary">{run.candidate}</td>
                <td>
                  <div className="font-semibold text-primary">{run.jobTitle ?? "Unknown Job"}</div>
                  <div className="admin-meta">{run.company ?? "Unknown Company"}</div>
                </td>
                <td>
                  <span className="font-mono text-xs font-semibold text-secondary">
                    {run.ats ?? "General"}
                  </span>
                </td>
                <td>
                  <AdminStatus
                    status={getRunStatusPresentation(run.status)}
                    label={run.status.replaceAll("_", " ")}
                  />
                </td>
                <td>
                  {run.waitingReason ? (
                    <span className="inline-block rounded-md bg-amber-100 dark:bg-amber-950/40 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
                      {run.waitingReason}
                    </span>
                  ) : (
                    <span className="text-tertiary text-xs">—</span>
                  )}
                </td>
                <td className="text-secondary text-sm">{new Date(run.updatedAt).toLocaleString()}</td>
                <td>
                  <span className="font-medium text-primary">{run.latestEvent ?? "—"}</span>
                  {run.latestEventDetail && (
                    <TechnicalDetails summary="Event detail">
                      <p>{run.latestEventDetail}</p>
                    </TechnicalDetails>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </OperationalTable>
      ) : (
        <AdminEmptyState
          title="No application runs found"
          detail="No persisted application runs match the selected stage filter."
        />
      )}

      {/* Pagination */}
      <nav className="admin-pagination" aria-label="Application run pages">
        <button
          type="button"
          className="admin-button admin-button-secondary"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span className="tabular-nums font-medium">
          Page {data.page} of {data.totalPages} · {data.total} total runs
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
    </div>
  );
}
