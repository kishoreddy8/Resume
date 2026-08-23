"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AdminConfirmDialog,
  AdminErrorState,
  AdminFeedbackBanner,
  AdminLoadingState,
  AdminPageHeader,
  AdminStatus,
  HealthTile,
  TechnicalDetails,
} from "@/components/admin";
import { useAdminCandidate } from "@/lib/admin/AdminContext";
import { MorningReadinessSection } from "./MorningReadinessSection";

type OperationData = {
  settings: {
    enabled: boolean;
    scanEnabled: boolean;
    writerEnabled: boolean;
  };
  scheduler: {
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    lastError: string | null;
  };
  scanLock: {
    held: boolean;
    trueAcquiredAt?: string | null;
  };
  worker: {
    running: boolean;
    statusStale: boolean;
    currentActivity: string | null;
    heavySlotHeldBy: string | null;
    lastStatusAt: string | null;
    ticks: Record<string, unknown> | null;
  };
  writer: {
    state: string;
    detail: string;
  };
  runtime: {
    web: { sourceRevision: string; contractVersion: string };
    compatibility: { state: string; detail: string };
  };
};

export default function AdminOperationsPage() {
  const { candidateId } = useAdminCandidate();
  const [data, setData] = useState<OperationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/operations?candidateId=${candidateId}`);
      if (!r.ok) {
        throw new Error((await r.json()).error ?? "Operations data unavailable");
      }
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operations data unavailable");
    }
  }, [candidateId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function runCycle() {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await fetch(`/api/production-cycle?candidateId=${candidateId}`, {
        method: "POST",
      });
      if (!r.ok) {
        throw new Error((await r.json()).error ?? "Production cycle failed");
      }
      setFeedback("Production ingestion and evaluation cycle initiated successfully.");
      setConfirm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Production cycle failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return <AdminErrorState detail={error} retry={() => void load()} />;
  }

  if (!data) {
    return <AdminLoadingState label="Loading operational systems and background worker state" />;
  }

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="Incident Triage & Automation"
        title="System Operations"
        description="Cross-service scheduler status, background worker lifecycle, resource leases, and production cycle orchestration."
        statusSummary={
          <AdminStatus
            status={data.settings.enabled ? "healthy" : "disabled"}
            label={data.settings.enabled ? "Automation Active" : "Automation Disabled"}
          />
        }
        actions={
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="admin-button admin-button-primary"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              {busy ? "Running…" : "Run Production Cycle"}
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

      {data.runtime.compatibility.state === "MISMATCH" && (
        <div className="admin-critical-banner" role="alert">
          <strong className="font-bold">Runtime Version Mismatch:</strong>
          <span>{data.runtime.compatibility.detail}</span>
        </div>
      )}

      {/* Health Tiles */}
      <div className="admin-health-grid admin-health-grid-four">
        <HealthTile
          label="Master Scheduler"
          status={data.settings.enabled ? "healthy" : "disabled"}
          value={data.settings.enabled ? "Enabled" : "Disabled"}
          detail={data.settings.enabled ? "Scheduled tasks active" : "Scheduled tasks paused"}
          href="/admin/settings"
        />
        <HealthTile
          label="Background Worker"
          status={!data.worker.running ? "offline" : data.worker.statusStale ? "stale" : "healthy"}
          value={!data.worker.running ? "Offline" : "Running"}
          detail={data.worker.currentActivity ?? "Worker idle (no active task)"}
        />
        <HealthTile
          label="Scan Resource Lease"
          status={data.scanLock.held ? "running" : "idle"}
          value={data.scanLock.held ? "Lease Held" : "Idle"}
          detail={data.scanLock.held ? "Discovery scan in progress" : "No active scan lease"}
          href="/admin/scanner"
        />
        <HealthTile
          label="Runtime Compatibility"
          status={
            data.runtime.compatibility.state === "MATCH"
              ? "healthy"
              : data.runtime.compatibility.state === "MISMATCH"
              ? "version_mismatch"
              : "unknown"
          }
          detail={data.runtime.compatibility.detail}
        />
      </div>

      {/* Morning Readiness Summary */}
      <section aria-labelledby="morning-readiness-heading">
        <h2 id="morning-readiness-heading" className="sr-only">
          Morning Readiness
        </h2>
        <MorningReadinessSection />
      </section>

      {/* Subsystems Navigation */}
      <section aria-labelledby="subsystems-heading">
        <h2 id="subsystems-heading" className="admin-section-title">
          Subsystem Dashboards
        </h2>
        <div className="admin-link-grid">
          <Link href="/admin/scanner" className="admin-card">
            <h2>Job Discovery & Scanner</h2>
            <p>Runs, ATS connector health, and discovered source proposals.</p>
          </Link>
          <Link href="/admin/writer" className="admin-card">
            <h2>Resume Writer Operations</h2>
            <p>{data.writer.detail}</p>
          </Link>
          <Link href="/admin/applications" className="admin-card">
            <h2>Application Pipeline</h2>
            <p>Observe all-candidate execution stages and intervention states.</p>
          </Link>
        </div>
      </section>

      {/* Lease & Scheduler Details */}
      <TechnicalDetails summary="Lease, Scheduler & Worker Details">
        <dl className="admin-technical-grid">
          <div>
            <dt>Last Scheduler Start</dt>
            <dd>{data.scheduler.lastStartedAt ? new Date(data.scheduler.lastStartedAt).toLocaleString() : "Never"}</dd>
          </div>
          <div>
            <dt>Last Scheduler Completion</dt>
            <dd>{data.scheduler.lastCompletedAt ? new Date(data.scheduler.lastCompletedAt).toLocaleString() : "Never"}</dd>
          </div>
          <div>
            <dt>Last Scheduler Error</dt>
            <dd>{data.scheduler.lastError ?? "None recorded"}</dd>
          </div>
          <div>
            <dt>Worker Last Status Ping</dt>
            <dd>{data.worker.lastStatusAt ? new Date(data.worker.lastStatusAt).toLocaleString() : "Never"}</dd>
          </div>
          <div>
            <dt>Heavy Slot Occupant</dt>
            <dd>{data.worker.heavySlotHeldBy ?? "None (available)"}</dd>
          </div>
          <div>
            <dt>Web Process Revision</dt>
            <dd>{data.runtime.web.sourceRevision}</dd>
          </div>
        </dl>
      </TechnicalDetails>

      {/* Confirm Production Cycle Modal */}
      <AdminConfirmDialog
        open={confirm}
        title="Run Full Production Cycle?"
        description="This triggers the complete production ingestion, ATS scanning, and matching evaluation cycle. Existing concurrency locks and safety preconditions remain enforced."
        confirmLabel="Run Production Cycle"
        busy={busy}
        onClose={() => setConfirm(false)}
        onConfirm={() => void runCycle()}
      />
    </div>
  );
}
