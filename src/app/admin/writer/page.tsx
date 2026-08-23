"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminGuidanceCard,
  AdminLoadingState,
  AdminPageHeader,
  AdminStatus,
  HealthTile,
  OperationalTable,
  TechnicalDetails,
} from "@/components/admin";
import { useAdminCandidate } from "@/lib/admin/AdminContext";

type WorkflowItem = {
  id: number;
  candidate: string;
  jobTitle: string | null;
  company: string | null;
  status: string;
  iteration: number;
  maxIterations: number;
  lastScore: number | null;
  provider: string | null;
  model: string | null;
  blocker: string | null;
  createdAt: string;
  updatedAt: string;
};

type WriterData = {
  generatedAt: string;
  health: {
    state: string;
    detail: string;
    writerEnabled: boolean;
    schedulerEnabled: boolean;
    pendingWorkflowCount: number;
    lastTickAt: string | null;
    lastPassCompletedAt: string | null;
    lastPassOutcome: string | null;
    lastPassError: string | null;
  };
  worker: {
    running: boolean;
    currentActivity: string | null;
    statusStale: boolean;
  };
  runtime: {
    web: { sourceRevision: string; contractVersion: string };
    compatibility: { state: string; detail: string };
  };
  workflows: WorkflowItem[];
  page: number;
  total: number;
  totalPages: number;
};

function formatWorkflowStatus(value: string) {
  if (value === "READY") return "completed";
  if (value === "FAILED") return "failed";
  if (value.includes("RUNNING")) return "running";
  if (value === "CREATED") return "queued";
  return "waiting";
}

export default function AdminWriterPage() {
  const { candidateId } = useAdminCandidate();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [data, setData] = useState<WriterData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({
        candidateId: String(candidateId),
        page: String(page),
        limit: "25",
        status: filter,
      });
      const r = await fetch(`/api/admin/writer-workflows?${p}`);
      if (!r.ok) {
        throw new Error((await r.json()).error ?? "Writer operations data unavailable");
      }
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Writer operations data unavailable");
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
    return <AdminLoadingState label="Loading resume writer operations and active workflows" />;
  }

  const isWriterEnabled = data.health.writerEnabled;

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="Tailoring Operations"
        title="Resume Writer"
        description="Monitor tailoring queue depth, worker activity, provider usage, and quality workflow transitions without exposing candidate resume content."
        statusSummary={
          <AdminStatus
            status={!isWriterEnabled ? "disabled" : data.health.state === "PROCESSING" ? "running" : "healthy"}
            label={!isWriterEnabled ? "Writer Disabled" : data.health.state === "PROCESSING" ? "Writer Processing" : "Writer Ready"}
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

      {!isWriterEnabled && (
        <AdminGuidanceCard
          title="Resume Writer Automation Disabled"
          purpose="Automatic resume tailoring is turned off in Settings. Queued tailoring workflows will wait until the writer switch is enabled."
          currentState="Writer switch is OFF"
          nextSteps="Open Settings to enable Resume Writer automation."
          action={
            <Link href="/admin/settings" className="admin-button admin-button-secondary">
              Open Settings
            </Link>
          }
          tone="warning"
        />
      )}

      {data.runtime.compatibility.state === "MISMATCH" && (
        <div className="admin-critical-banner" role="alert">
          <strong className="font-bold">Version mismatch:</strong>
          <span>{data.runtime.compatibility.detail}</span>
        </div>
      )}

      {/* Health Tiles */}
      <div className="admin-health-grid admin-health-grid-four">
        <HealthTile
          label="Writer State"
          status={
            data.health.state === "IDLE"
              ? "idle"
              : data.health.state === "PROCESSING"
              ? "running"
              : data.health.state.includes("UNAVAILABLE")
              ? "offline"
              : "needs_intervention"
          }
          value={data.health.state.replaceAll("_", " ")}
          detail={data.health.detail}
        />
        <HealthTile
          label="Automation Setting"
          status={isWriterEnabled ? "healthy" : "disabled"}
          value={isWriterEnabled ? "Enabled" : "Disabled"}
          detail={isWriterEnabled ? "Automatic tailoring ON" : "Automatic tailoring OFF"}
          href="/admin/settings"
        />
        <HealthTile
          label="Worker Status"
          status={data.health.schedulerEnabled ? (data.worker.running ? "healthy" : "stale") : "disabled"}
          value={data.worker.running ? "Active" : "Offline"}
          detail={data.worker.running ? data.worker.currentActivity ?? "Worker idle" : "Worker process offline"}
        />
        <HealthTile
          label="Queue Depth"
          status={data.health.pendingWorkflowCount > 0 ? "queued" : "idle"}
          value={data.health.pendingWorkflowCount}
          detail="Tailoring workflows in queue"
        />
      </div>

      {/* Filter Bar */}
      <div className="admin-filter-bar admin-filter-compact">
        <label>
          <span>Filter by Workflow Status</span>
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Statuses</option>
            <option value="CREATED">CREATED (Queued)</option>
            <option value="WRITER_RUNNING">WRITER_RUNNING (Tailoring)</option>
            <option value="REVIEW_RUNNING">REVIEW_RUNNING (Evaluating)</option>
            <option value="IMPROVEMENT_RUNNING">IMPROVEMENT_RUNNING (Targeted Repair)</option>
            <option value="READY">READY (Completed)</option>
            <option value="FAILED">FAILED (Blocked/Error)</option>
          </select>
        </label>
      </div>

      {/* Workflows Table */}
      {data.workflows.length > 0 ? (
        <OperationalTable label="Resume writer workflow queue">
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Candidate</th>
              <th>Target Job & Company</th>
              <th>Status</th>
              <th>Iteration</th>
              <th>Score & Provider</th>
              <th>Operational Blocker</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.workflows.map((w) => (
              <tr key={w.id}>
                <td>
                  <span className="font-mono font-bold text-primary">#{w.id}</span>
                </td>
                <td className="font-medium">{w.candidate}</td>
                <td>
                  <div className="font-semibold text-primary">{w.jobTitle ?? "Unknown Role"}</div>
                  <div className="admin-meta">{w.company ?? "Unknown Company"}</div>
                </td>
                <td>
                  <AdminStatus
                    status={formatWorkflowStatus(w.status)}
                    label={w.status.replaceAll("_", " ")}
                  />
                </td>
                <td className="tabular-nums font-semibold">
                  {w.iteration} <span className="text-xs text-tertiary">/ {w.maxIterations}</span>
                </td>
                <td>
                  <div className="font-bold tabular-nums">
                    {w.lastScore !== null ? `${w.lastScore} / 100` : "—"}
                  </div>
                  <div className="admin-meta font-mono text-xs">
                    {w.provider ?? "No provider recorded"}
                    {w.model ? ` · ${w.model}` : ""}
                  </div>
                </td>
                <td>
                  {w.blocker ? (
                    <span className="text-amber-700 dark:text-amber-400 font-medium text-xs">
                      {w.blocker}
                    </span>
                  ) : (
                    <span className="text-tertiary text-xs">None</span>
                  )}
                </td>
                <td className="text-secondary text-sm">{new Date(w.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </OperationalTable>
      ) : (
        <AdminEmptyState
          title="No tailoring workflows found"
          detail="No resume tailoring workflows match the current status filter."
        />
      )}

      {/* Pagination */}
      <nav className="admin-pagination" aria-label="Resume workflow pages">
        <button
          type="button"
          className="admin-button admin-button-secondary"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span className="tabular-nums font-medium">
          Page {data.page} of {data.totalPages} · {data.total} total workflows
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

      {/* Technical details */}
      <TechnicalDetails summary="Writer Runtime & Process Pass Info">
        <dl className="admin-technical-grid">
          <div>
            <dt>Web Process Revision</dt>
            <dd>{data.runtime.web.sourceRevision}</dd>
          </div>
          <div>
            <dt>Contract Version</dt>
            <dd>{data.runtime.web.contractVersion}</dd>
          </div>
          <div>
            <dt>Last Worker Tick</dt>
            <dd>{data.health.lastTickAt ? new Date(data.health.lastTickAt).toLocaleString() : "Never"}</dd>
          </div>
          <div>
            <dt>Last Pass Outcome</dt>
            <dd>{data.health.lastPassOutcome ?? "None"}</dd>
          </div>
          <div>
            <dt>Last Pass Error</dt>
            <dd>{data.health.lastPassError ?? "None"}</dd>
          </div>
        </dl>
      </TechnicalDetails>
    </div>
  );
}
