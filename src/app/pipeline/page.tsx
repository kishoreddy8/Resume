"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import { PipelineStatusSelect } from "@/components/PipelineStatusSelect";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import { ApplicationList } from "./ApplicationList";
import type { JobWithCompany, PipelineStatus } from "@/types";
import {
  LoadingRegion,
  Metric,
  PageHeader,
  SkeletonRows,
  StatusDot,
  Surface,
  type StatusTone,
} from "@/components/ui";

/**
 * Application Command Center.
 *
 * THE PROBLEM THIS REPLACES, measured before touching anything:
 *   the board fetched /api/jobs?activeOnly=true — 16,005 jobs, a 25 MB response — and rendered
 *   every one as a card. 208,189 DOM nodes. Every job came back as pipeline_status "New" (jobs
 *   without a candidate_job_state row default to it), so one column held 16,005 cards and the
 *   other five were empty. It was a Trello board of the entire job database.
 *
 * WHAT IT DOES NOW:
 *   stage counts come from /api/operations, which already aggregates them and which the dashboard
 *   already calls — one small request instead of 25 MB. Item detail is fetched per stage through
 *   the API's OWN existing `status` parameter, and only for stages the counts say are non-empty,
 *   so an empty pipeline issues no item requests at all.
 *
 * No API, query, projection or ranking behaviour was changed — this uses parameters the route
 * already validates.
 *
 * "Discovered" is deliberately not a card list. 16,005 discovered jobs is a number, not a column;
 * the place to work through them is the Jobs queue, and this links there rather than mirroring it.
 */

/** The stages the candidate actually moves a job through, in workflow order. */
const ENGAGED: { status: PipelineStatus; label: string; tone: StatusTone }[] = [
  { status: "Interested", label: "Interested", tone: "active" },
  { status: "Applied", label: "Applied", tone: "active" },
  { status: "Interviewing", label: "Interviewing", tone: "ready" },
  { status: "Offer", label: "Offer", tone: "ready" },
  { status: "Employer Rejected", label: "Closed", tone: "neutral" },
];

interface OperationsSlice {
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
}

export default function PipelinePage() {
  const candidateId = useActiveCandidateId();
  const [ops, setOps] = useState<OperationsSlice | null>(null);
  const [itemsByStatus, setItemsByStatus] = useState<Record<string, JobWithCompany[]>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/operations?candidateId=${candidateId}&window=30d`);
      if (!res.ok) return;
      const body = (await res.json()) as OperationsSlice;
      setOps(body);

      // Only ask for items where the aggregate says items exist. An empty pipeline costs one request.
      const counts: Record<PipelineStatus, number> = {
        New: body.applications.candidate.new,
        Interested: body.applications.candidate.interested,
        Applied: body.applications.candidate.applied,
        Interviewing: body.applications.candidate.interviewing,
        Offer: body.applications.candidate.offer,
        "Employer Rejected": body.applications.candidate.employerRejected,
      };
      const wanted = ENGAGED.filter((s) => (counts[s.status] ?? 0) > 0);
      const fetched = await Promise.all(
        wanted.map(async (s) => {
          const r = await fetch(
            `/api/jobs?candidateId=${candidateId}&status=${encodeURIComponent(s.status)}&activeOnly=true`
          );
          if (!r.ok) return [s.status, [] as JobWithCompany[]] as const;
          const d = await r.json();
          return [s.status, (d.jobs ?? []) as JobWithCompany[]] as const;
        })
      );
      setItemsByStatus(Object.fromEntries(fetched));
    } finally {
      setLoading(false);
    }
  }, [candidateId]);

  useEffect(() => {
    // Intentional: fetch-on-mount/candidate-change with a loading flag, the same pattern every
    // other page in this app uses. Not a render loop — `load` is memoised on candidateId.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (loading && !ops) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Applications" description="Where every job you have engaged with currently stands." />
        <LoadingRegion label="Loading application pipeline" />
        <Surface level="z3" className="rounded-[var(--radius-xl)] p-5">
          <SkeletonRows rows={6} />
        </Surface>
      </div>
    );
  }

  const a = ops?.applications.candidate;
  const m = ops?.matching.candidate;

  const counts: Record<string, number> = {
    Interested: a?.interested ?? 0,
    Applied: a?.applied ?? 0,
    Interviewing: a?.interviewing ?? 0,
    Offer: a?.offer ?? 0,
    "Employer Rejected": a?.employerRejected ?? 0,
  };
  const engagedTotal = Object.values(counts).reduce((x, y) => x + y, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Applications"
        description="Where every job you have engaged with currently stands. Counts are recorded pipeline state — nothing here is projected."
      />

      {/* Today: the three questions worth answering before opening anything. */}
      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Today</h2>
        <div className="mt-3 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Needs review"
            value={m?.needsReview ?? null}
            tone={(m?.needsReview ?? 0) > 0 ? "attention" : "default"}
            hint={<Link href="/jobs" className="hover:text-primary">Open the queue →</Link>}
          />
          <Metric
            label="Ready to tailor"
            value={m?.readyForTailoring ?? null}
            tone={(m?.readyForTailoring ?? 0) > 0 ? "accent" : "default"}
            hint="cleared review"
          />
          <Metric
            label="Resume ready"
            value={a?.readyToApply ?? null}
            tone={(a?.readyToApply ?? 0) > 0 ? "success" : "default"}
            hint="passed the quality gate"
          />
          <Metric label="Awaiting reply" value={a?.applied ?? null} hint="applied, no outcome yet" />
        </div>
      </Surface>

      {/* The flow, as a connected path. Counts only — the items live below. */}
      <section className="space-y-2">
        <h2 className="section-title">Flow</h2>
        <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
          <ol className="grid grid-cols-3 items-start gap-y-5 lg:grid-cols-6">
            <li className="relative flex min-w-0 flex-col">
              <StatusDot tone="neutral" />
              <span className="mt-2 text-[9px] font-semibold uppercase tracking-[0.1em] text-tertiary">Discovered</span>
              {/* A number, not a column: 16,005 discovered jobs is not something to render as cards. */}
              <Link href="/jobs" className="mt-0.5 text-[19px] font-semibold leading-none tabular-nums tracking-[-0.02em] text-primary hover:text-[var(--accent)]">
                {((m?.needsReview ?? 0) + (m?.readyForTailoring ?? 0) + (m?.blocked ?? 0)).toLocaleString()}
              </Link>
              <span className="mt-0.5 text-[10px] text-tertiary">evaluated</span>
            </li>
            {ENGAGED.map((stage, i) => {
              const n = counts[stage.status] ?? 0;
              return (
                <li key={stage.status} className="relative flex min-w-0 flex-col">
                  <span
                    aria-hidden="true"
                    className={`absolute left-0 top-[3px] hidden h-px w-full -translate-x-1/2 lg:block ${
                      i === 0 || (counts[ENGAGED[i - 1].status] ?? 0) > 0
                        ? "bg-[var(--accent)] opacity-40"
                        : "bg-[var(--separator)]"
                    }`}
                  />
                  <span className="relative z-[1]">
                    <StatusDot tone={n > 0 ? stage.tone : "neutral"} />
                  </span>
                  <span className="mt-2 text-[9px] font-semibold uppercase tracking-[0.1em] text-tertiary">
                    {stage.label}
                  </span>
                  <span className="mt-0.5 text-[19px] font-semibold leading-none tabular-nums tracking-[-0.02em] text-primary">
                    {n.toLocaleString()}
                  </span>
                </li>
              );
            })}
          </ol>
        </Surface>
      </section>

      {/* Every job actually acted on: stage, next action, documents, notes, and its recorded
       *  history on demand. Sourced from candidate_job_state, so it is small by construction
       *  rather than by a cap applied to something large. */}
      <section className="space-y-2">
        <h2 className="section-title">Applications</h2>
        <ApplicationList candidateId={candidateId} />
      </section>

      {/* Items, per engaged stage. Rendered only where they exist. */}
      <section className="space-y-2">
        <h2 className="section-title">In flight</h2>
        {engagedTotal === 0 ? (
          <Surface level="z3" className="rounded-[var(--radius-xl)] px-6 py-12 text-center">
            <p className="text-[13px] font-medium text-primary">Nothing in the pipeline yet</p>
            <p className="mx-auto mt-1 max-w-[46ch] text-[12px] leading-relaxed text-tertiary">
              A job enters here once you set its status. Work through the queue, tailor what is ready, then mark it
              Applied.
            </p>
            <Link
              href="/jobs"
              className="mt-4 inline-block rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
            >
              Open Jobs
            </Link>
          </Surface>
        ) : (
          <div className="flex flex-col gap-4">
            {ENGAGED.filter((s) => (counts[s.status] ?? 0) > 0).map((stage) => {
              const items = itemsByStatus[stage.status] ?? [];
              return (
                <Surface key={stage.status} level="z3" className="rounded-[var(--radius-xl)] px-5 py-3">
                  <div className="flex items-center gap-2 pb-1">
                    <StatusDot tone={stage.tone} />
                    <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
                      {stage.label}
                    </h3>
                    <span className="text-[11px] tabular-nums text-tertiary">{counts[stage.status]}</span>
                  </div>
                  <ul>
                    {items.map((job) => (
                      <li
                        key={job.id}
                        className="flex items-center gap-3 border-b border-[var(--separator)] py-2 last:border-b-0"
                      >
                        <Link
                          href={`/jobs/${job.id}`}
                          className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-primary transition-colors duration-150 ease-out hover:text-[var(--accent)]"
                        >
                          {job.title}
                        </Link>
                        <span className="hidden min-w-0 max-w-[14rem] shrink truncate text-[11.5px] text-tertiary sm:inline">
                          {job.company_name}
                        </span>
                        <H1bBadge confidence={job.h1b_combined_confidence} />
                        <PipelineStatusSelect
                          jobId={job.id}
                          value={job.pipeline_status}
                          candidateId={candidateId}
                          onChanged={load}
                        />
                      </li>
                    ))}
                  </ul>
                </Surface>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
