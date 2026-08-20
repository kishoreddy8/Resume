"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import {
  LoadingRegion,
  Metric,
  PageHeader,
  SkeletonMetrics,
  SkeletonRows,
  Status,
  StatusDot,
  Surface,
  type StatusTone,
} from "@/components/ui";

/**
 * Career Intelligence Dashboard.
 *
 * ONE request: /api/operations, which the Operations page already serves and which already
 * aggregates every number below. No new endpoint, no new query, no widened payload.
 *
 * Every figure is read straight through. There is no composite "career score", no readiness
 * percentage and no trend arrow, because none of those exist in the data — a headline number
 * synthesised from unrelated counters would be the most authoritative-looking lie on the page.
 * What this does instead is put the real counters where they answer "what should I do next".
 */

type Health = "HEALTHY" | "WARNING" | "ERROR" | string;

interface OperationsResponse {
  overview: Record<string, Health | string | null>;
  matching: { candidate: { readyForTailoring: number; needsReview: number; blocked: number } };
  applications: {
    candidate: {
      new: number;
      interested: number;
      applied: number;
      interviewing: number;
      offer: number;
      employerRejected: number;
      readyToApply: number;
    };
  };
  resumeQuality: { candidate: { tailoringRunsTotal: number; workflowsByStatus: Record<string, number> } };
  notifications: {
    candidate: { total: number; unread: number };
    recent: { id: number; type: string; title: string; createdAt: string; readAt: string | null }[];
  };
  scanning: { window: { jobsAdded: number; companiesScanned: number; runs: number }; latest: { status: string } | null };
}

const HEALTH_TONE: Record<string, StatusTone> = {
  HEALTHY: "ready",
  WARNING: "attention",
  ERROR: "blocked",
};

function relative(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(d.getTime())) return value;
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function DashboardPage() {
  const candidateId = useActiveCandidateId();
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/operations?candidateId=${candidateId}&window=7d`);
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setData(body);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  if (loading && !data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Career Intelligence" description="Everything Career-Ops currently knows about your search." />
        <LoadingRegion label="Loading career intelligence" />
        <Surface level="z3" className="rounded-[var(--radius-xl)] p-5">
          <SkeletonMetrics count={4} />
        </Surface>
        <Surface level="z3" className="rounded-[var(--radius-xl)] p-5">
          <SkeletonRows rows={6} />
        </Surface>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Career Intelligence" />
        <Surface level="z3" className="rounded-[var(--radius-xl)] px-6 py-12 text-center">
          <p className="text-[13px] font-medium text-primary">Intelligence unavailable</p>
          <p className="mt-1 text-[12px] text-tertiary">The operations endpoint did not return data for this candidate.</p>
        </Surface>
      </div>
    );
  }

  const m = data.matching.candidate;
  const a = data.applications.candidate;
  const rq = data.resumeQuality.candidate;
  const n = data.notifications;

  /* The pipeline, as the candidate's own counts. Every stage is a real column value; a stage with
   * nothing in it shows 0 because that IS measured, unlike a metric that was never computed. */
  const pipeline: { label: string; value: number; href: string; tone: StatusTone }[] = [
    { label: "Needs review", value: m.needsReview, href: "/jobs", tone: m.needsReview > 0 ? "attention" : "neutral" },
    { label: "Ready to tailor", value: m.readyForTailoring, href: "/jobs", tone: m.readyForTailoring > 0 ? "active" : "neutral" },
    { label: "Ready to apply", value: a.readyToApply, href: "/pipeline", tone: a.readyToApply > 0 ? "ready" : "neutral" },
    { label: "Applied", value: a.applied, href: "/pipeline", tone: "neutral" },
    { label: "Interviewing", value: a.interviewing, href: "/pipeline", tone: a.interviewing > 0 ? "ready" : "neutral" },
    { label: "Offer", value: a.offer, href: "/pipeline", tone: a.offer > 0 ? "ready" : "neutral" },
  ];

  const systems = [
    { label: "Scheduler", key: "scheduler" },
    { label: "Scanning", key: "scanning" },
    { label: "Connectors", key: "connectors" },
    { label: "Matching", key: "matching" },
    { label: "Resume pipeline", key: "resumePipeline" },
    { label: "Notifications", key: "notifications" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Career Intelligence"
        description="Everything Career-Ops currently knows about your search. Every figure is a recorded count — nothing here is estimated or projected."
        actions={
          <Link
            href="/jobs"
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
          >
            Open Jobs
          </Link>
        }
      />

      {/* What matters today. Four counts that each imply an action. */}
      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Ready to tailor" value={m.readyForTailoring} tone={m.readyForTailoring > 0 ? "accent" : "default"} hint="cleared review" />
          <Metric label="Ready to apply" value={a.readyToApply} tone={a.readyToApply > 0 ? "success" : "default"} hint="resume passed the gate" />
          <Metric label="Needs review" value={m.needsReview} tone={m.needsReview > 0 ? "attention" : "default"} hint="fell short of ready" />
          <Metric label="Unread alerts" value={n.candidate.unread} hint={`${n.candidate.total} total`} />
        </div>
      </Surface>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          {/* Pipeline as a horizontal progression rather than six equal tiles. */}
          <section className="space-y-2">
            <h2 className="section-title">Pipeline</h2>
            <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
              <ol className="grid grid-cols-3 items-start gap-y-5 sm:grid-cols-6">
                {pipeline.map((stage, i) => (
                  <li key={stage.label} className="relative flex min-w-0 flex-col">
                    {i > 0 && (
                      <span aria-hidden="true" className="absolute left-0 top-[3px] h-px w-full -translate-x-1/2 bg-[var(--separator)]" />
                    )}
                    <Link href={stage.href} className="group relative z-[1] flex flex-col rounded px-1 py-0.5 transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)]">
                      <StatusDot tone={stage.tone} />
                      <span className="mt-2 text-[9px] font-semibold uppercase tracking-[0.1em] text-tertiary">{stage.label}</span>
                      <span className="mt-0.5 text-[19px] font-semibold leading-none tabular-nums tracking-[-0.02em] text-primary">
                        {stage.value.toLocaleString()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </Surface>
          </section>

          {/* Activity, from the notifications the app already records. */}
          <section className="space-y-2">
            <h2 className="section-title">Recent activity</h2>
            <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-3">
              {n.recent.length === 0 ? (
                <p className="py-8 text-center text-[12px] text-tertiary">Nothing recorded yet.</p>
              ) : (
                <ol>
                  {n.recent.slice(0, 8).map((item) => (
                    <li key={item.id} className="relative flex items-baseline gap-3 border-b border-[var(--separator)] py-2.5 pl-5 last:border-b-0">
                      <span aria-hidden="true" className="absolute left-[3px] top-0 h-full w-px bg-[var(--separator)]" />
                      <span className="absolute left-0 top-[13px]">
                        <StatusDot tone={item.readAt ? "neutral" : "active"} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-primary" title={item.title}>
                        {item.title}
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-[11px] text-tertiary">{relative(item.createdAt)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Surface>
          </section>
        </div>

        <div className="flex flex-col gap-6">
          {/* System health, straight from overview.*. No aggregate "all good" claim. */}
          <section className="space-y-2">
            <h2 className="section-title">System</h2>
            <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-3">
              {systems.map((s) => {
                const value = String(data.overview[s.key] ?? "UNKNOWN");
                return (
                  <div key={s.key} className="flex items-center justify-between gap-3 border-b border-[var(--separator)] py-2 last:border-b-0">
                    <span className="text-[12px] text-primary">{s.label}</span>
                    <Status tone={HEALTH_TONE[value] ?? "unknown"}>{value.toLowerCase()}</Status>
                  </div>
                );
              })}
              <Link
                href="/operations"
                className="mt-2 inline-block rounded px-1 text-[11.5px] text-secondary transition-colors duration-150 ease-out hover:text-primary"
              >
                Operations detail →
              </Link>
            </Surface>
          </section>

          <section className="space-y-2">
            <h2 className="section-title">Discovery &amp; resumes</h2>
            <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
              <div className="grid grid-cols-2 gap-5">
                <Metric label="Jobs added" value={data.scanning.window.jobsAdded} hint="last 7 days" />
                <Metric label="Companies scanned" value={data.scanning.window.companiesScanned} hint="last 7 days" />
                <Metric label="Tailoring runs" value={rq.tailoringRunsTotal} />
                <Metric
                  label="Resumes ready"
                  value={rq.workflowsByStatus?.READY ?? 0}
                  tone={(rq.workflowsByStatus?.READY ?? 0) > 0 ? "success" : "default"}
                  hint={rq.workflowsByStatus?.FAILED ? `${rq.workflowsByStatus.FAILED} need attention` : undefined}
                />
              </div>
            </Surface>
          </section>
        </div>
      </div>
    </div>
  );
}
