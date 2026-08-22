"use client";

import { memo, type ReactNode } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import { getJobAgeBand, getJobAgeDays, type LifecycleThresholds } from "@/lib/jobLifecycle";
import type { ListMatchSummary } from "@/lib/rank/jobsList";
import type { JobWithCompany, JobWithCompanySummary } from "@/types";
import { candidateStatus } from "@/lib/candidateStatus";
import { SaveJobButton } from "./SaveJobButton";

export type { JobWithCompanySummary };
export type RowJob = Pick<
  JobWithCompany,
  | "id"
  | "dedupe_key"
  | "title"
  | "company_name"
  | "location"
  | "is_active"
  | "h1b_combined_confidence"
  | "posted_at"
  | "first_seen_at"
  | "marked_for_tailoring"
  | "pipeline_status"
  | "pinned"
>;

function companyMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "JB";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function MatchFit({ summary }: { summary: ListMatchSummary | undefined }) {
  if (!summary) return <span className="text-[13px] font-medium text-tertiary">Not evaluated</span>;
  if (summary.insufficientJdSignal) {
    return (
      <span className="rounded-full bg-[var(--pill-amber-bg)] px-2.5 py-1 text-[13px] font-semibold text-[var(--pill-amber-fg)]">
        Insufficient data
      </span>
    );
  }
  const tone =
    summary.decision === "READY_FOR_TAILORING"
      ? "bg-[var(--pill-success-bg)] text-[var(--pill-success-fg)]"
      : summary.decision === "NEEDS_REVIEW"
        ? "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]"
        : "bg-[var(--pill-red-bg)] text-[var(--pill-red-fg)]";
  const label =
    summary.decision === "READY_FOR_TAILORING"
      ? candidateStatus("readyToTailor").label
      : summary.decision === "NEEDS_REVIEW"
        ? candidateStatus("needsReview").label
        : candidateStatus("blocked").label;
  return (
    <span className="flex items-center gap-2.5 whitespace-nowrap">
      <span className={`rounded-full px-2.5 py-1 text-[13px] font-semibold ${tone}`}>{label}</span>
      <span className="text-[18px] font-bold tabular-nums text-primary">{Math.round(summary.overallScore)}</span>
    </span>
  );
}

function AgeLabel({ job, thresholds }: { job: RowJob; thresholds: LifecycleThresholds }) {
  const days = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at });
  const fresh = getJobAgeBand(days, thresholds) === "fresh";
  const label = days === 0 ? "Today" : days === 1 ? "1 day ago" : `${days} days ago`;
  return <span className={fresh ? "font-semibold text-[var(--accent)]" : "text-tertiary"}>{label}</span>;
}

export const JobRow = memo(function JobRow({
  job,
  candidateId,
  thresholds,
  summary,
  selected,
  onOpen,
  onSavedChange,
  meta,
  optionId,
}: {
  job: RowJob;
  candidateId: number;
  thresholds: LifecycleThresholds;
  summary: ListMatchSummary | undefined;
  selected: boolean;
  onOpen: (id: number) => void;
  onSavedChange?: (jobId: number, saved: boolean) => void;
  sharedLayout?: boolean;
  meta?: ReactNode;
  optionId?: string;
}) {
  return (
    <div
      id={optionId}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-job-row={job.id}
      onClick={() => onOpen(job.id)}
      className={`group relative cursor-pointer rounded-[18px] border bg-surface p-4 shadow-[var(--lift-1)] transition-[border-color,box-shadow,transform] duration-150 md:p-5 ${
        selected
          ? "border-[var(--accent)] shadow-[var(--lift-2)]"
          : "border-[var(--border)] hover:-translate-y-px hover:border-[color-mix(in_oklab,var(--accent)_35%,var(--border))] hover:shadow-[var(--lift-2)]"
      } ${job.is_active ? "" : "opacity-65"}`}
    >
      <div className="flex items-start gap-3.5 md:gap-4">
        <div
          aria-hidden="true"
          className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-[linear-gradient(145deg,var(--accent-soft),var(--z0-bg))] text-[14px] font-bold tracking-[0.04em] text-[var(--accent)] ring-1 ring-inset ring-[color-mix(in_oklab,var(--accent)_18%,transparent)] md:h-14 md:w-14"
        >
          {companyMonogram(job.company_name)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <h2 className="truncate text-[17px] font-semibold leading-tight tracking-[-0.015em] text-primary md:text-[18px]" title={job.title}>
                {job.title}
              </h2>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-secondary">
                <span className="font-medium text-primary">{job.company_name}</span>
                {job.location ? <><span aria-hidden="true">·</span><span>{job.location}</span></> : null}
                <span aria-hidden="true">·</span>
                <AgeLabel job={job} thresholds={thresholds} />
                {!job.is_active ? <><span aria-hidden="true">·</span><span>Closed</span></> : null}
              </p>
            </div>
            <MatchFit summary={summary} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[14px]">
            <H1bBadge confidence={job.h1b_combined_confidence} />
            {job.marked_for_tailoring === 1 ? (
              <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 font-semibold text-[var(--accent)]">Tailoring approved</span>
            ) : null}
            {job.pipeline_status && job.pipeline_status !== "New" ? (
              <span className="rounded-full bg-[var(--z0-bg)] px-2.5 py-1 font-medium text-secondary">{job.pipeline_status}</span>
            ) : null}
            {meta}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <SaveJobButton
            jobId={job.id}
            jobTitle={job.title}
            candidateId={candidateId}
            initialSaved={job.pinned === 1}
            onSavedChange={onSavedChange}
          />
          <span aria-hidden="true" className="hidden h-11 w-8 place-items-center text-tertiary transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-[var(--accent)] sm:grid">
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m6 3 5 5-5 5" /></svg>
          </span>
        </div>
      </div>
    </div>
  );
});
