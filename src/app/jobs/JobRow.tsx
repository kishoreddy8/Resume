"use client";

import { memo, type ReactNode } from "react";
import { motion } from "motion/react";
import { H1bBadge } from "@/components/H1bBadge";
import { getJobAgeBand, getJobAgeDays, type LifecycleThresholds } from "@/lib/jobLifecycle";
import type { ListMatchSummary } from "@/lib/rank/jobsList";
import type { JobWithCompany, JobWithCompanySummary } from "@/types";

/**
 * Exactly the fields a row draws — nothing more. Typing against this rather than JobWithCompany is
 * deliberate: the For You feed is served the trimmed JobWithCompanySummary projection (Stage 32
 * dropped description_html and friends from list payloads), and the row must fit that shape rather
 * than the payload being widened back out to fit the row.
 */
export type { JobWithCompanySummary };
export type RowJob = Pick<
  JobWithCompany,
  | "id"
  | "title"
  | "company_name"
  | "location"
  | "is_active"
  | "h1b_combined_confidence"
  | "posted_at"
  | "first_seen_at"
  /* Candidate-personal workflow state. Both list payloads already carry these 51-field job objects,
   * so reading them widens nothing — RowJob simply stops narrowing them away. */
  | "marked_for_tailoring"
  | "pipeline_status"
>;

/**
 * WORKBENCH PHASE 2 — the one job row used by both lists.
 *
 * All Jobs and For You read from different response shapes (a decisions map keyed by dedupe_key
 * versus an inline `ranking` object), but the three fit states they display are the same contract,
 * and they should look the same. Rather than let two row implementations drift, the shape each list
 * already has is narrowed to `ListMatchSummary` at the call site and this component renders it.
 *
 * `meta` is the only concession to the two views differing: For You passes its bucket and rank
 * through it, All Jobs passes nothing. That is a slot, not a second design system.
 */

/** Stage 24B — same three-state contract as the For You feed's cell (not evaluated / insufficient
 *  data / evaluated). Kept local to this component rather than shared, because the two lists read
 *  from different response shapes; the SEMANTICS are what must agree, and they do.
 *
 *  WORKBENCH — laid out inline for a two-line row instead of stacked in a table cell. The three
 *  states, their wording and their meaning are untouched. */
function MatchFit({ summary }: { summary: ListMatchSummary | undefined }) {
  if (!summary) {
    return <span className="shrink-0 text-[11px] italic text-tertiary">Not evaluated</span>;
  }
  if (summary.insufficientJdSignal) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-[var(--warning)]"
        title="This posting did not yield enough structured requirements to score reliably."
      >
        <span aria-hidden="true" className="h-1 w-1 rounded-full bg-[var(--warning)]" />
        Insufficient data
      </span>
    );
  }
  const tone =
    summary.decision === "READY_FOR_TAILORING"
      ? "text-[var(--success)]"
      : summary.decision === "NEEDS_REVIEW"
        ? "text-[var(--warning)]"
        : "text-[var(--error)]";
  const label =
    summary.decision === "READY_FOR_TAILORING"
      ? "Ready"
      : summary.decision === "NEEDS_REVIEW"
        ? "Review"
        : "Blocked";
  return (
    <span className="flex shrink-0 items-baseline gap-2 whitespace-nowrap">
      {/* Decision as semantic text, score as a number. Two different concepts should not
       *  share one pill shape — the number is the thing you scan, the word qualifies it. */}
      <span className={`text-[11px] font-semibold uppercase tracking-[0.05em] ${tone}`}>{label}</span>
      <span className="w-[3ch] text-right text-[14px] font-semibold tabular-nums leading-none text-primary">
        {Math.round(summary.overallScore)}
      </span>
    </span>
  );
}

/**
 * Workflow cue for a queue row.
 *
 * Built strictly from fields the list payload ALREADY carries on every job — `marked_for_tailoring`
 * and `pipeline_status` are both on the wire in All Jobs and For You alike, so this needs no payload
 * widening and no per-row request. It is two spans and no SVG.
 *
 * What it deliberately cannot show: whether a resume has been GENERATED. That state
 * (`hasReadyResume`) exists only on the For You ranking, and For You already renders its own
 * "Resume Ready" chip. Inferring it for All Jobs would require widening the Stage 32 decision
 * projection across ~15.7k jobs, so All Jobs shows tailoring/apply state only.
 */
function WorkflowCue({ job }: { job: RowJob }) {
  const approved = job.marked_for_tailoring === 1;
  const applied =
    job.pipeline_status !== null && ["Applied", "Interviewing", "Offer", "Employer Rejected"].includes(job.pipeline_status);
  if (!approved && !applied) return null;
  // Text, not colour alone — the dot repeats the word, it never replaces it.
  return (
    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] uppercase tracking-[0.06em] text-[var(--accent)]">
      <span aria-hidden="true" className="h-1 w-1 rounded-full bg-[var(--accent)] shadow-[0_0_6px_var(--accent)]" />
      {applied ? job.pipeline_status : "Tailoring"}
    </span>
  );
}

/** Compact age. The lifecycle "fresh" band — the same getJobAgeBand policy the sweep uses — is kept
 *  as an accent tint on the number rather than a separate badge, so no signal is lost. */
function AgeLabel({ job, thresholds }: { job: RowJob; thresholds: LifecycleThresholds }) {
  const days = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at });
  const fresh = getJobAgeBand(days, thresholds) === "fresh";
  return (
    <span
      className={`shrink-0 tabular-nums text-[11px] ${fresh ? "font-medium text-[var(--accent)]" : "text-tertiary"}`}
      title={fresh ? `Posted ${days} day${days === 1 ? "" : "s"} ago — high priority` : `${days} days old`}
    >
      {days}d
    </span>
  );
}

/**
 * One row of the Workbench master list.
 *
 * Deliberately NOT a Motion component. There are up to 100 of these and they are selected tens of
 * times per session; per the frequency rule, the highest-frequency interaction in the app must be
 * instant, so selection is a plain class change with no transition on the surface tint. Only the
 * accent bar participates in shared-layout motion, and only for the one selected row.
 */
export const JobRow = memo(function JobRow({
  job,
  thresholds,
  summary,
  selected,
  onOpen,
  sharedLayout,
  meta,
}: {
  job: RowJob;
  thresholds: LifecycleThresholds;
  summary: ListMatchSummary | undefined;
  selected: boolean;
  /** Opens the job's workspace. Arrow-key selection is separate and stays on the list. */
  onOpen: (id: number) => void;
  sharedLayout: boolean;
  /** View-specific context. For You puts its bucket + rank here; All Jobs passes nothing. */
  meta?: ReactNode;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-job-row={job.id}
      onClick={() => onOpen(job.id)}
      /* Selection lifts the row toward the viewer: its own surface tone, a lit top
       *  edge and a contact shadow. Hover is a 1px rise, transform-only, and gated
       *  to real pointers so a touch tap never leaves a row stuck raised. */
      className={`relative cursor-pointer select-none border-b border-[var(--separator)] py-[11px] pl-4 pr-3.5 row-lift transition-[background-color,box-shadow] duration-150 ease-out ${
        selected
          ? "z-[1] bg-[var(--z3-bg)] shadow-[var(--lift-2)]"
          : "hover:bg-[var(--surface-hover)]"
      } ${job.is_active ? "" : "opacity-60"}`}
    >
      {/* The single shared-layout participant. When selection moves, this one bar travels; nothing
       *  else in the list animates. On keyboard selection the travel is suppressed (see JobList). */}
      {selected &&
        (sharedLayout ? (
          <motion.span
            layoutId="workbench-selection"
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-[3px] rounded-r-full bg-[var(--accent)] shadow-[0_0_12px_var(--accent-soft)]"
            transition={{ type: "spring", duration: 0.32, bounce: 0 }}
          />
        ) : (
          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-[var(--accent)]" />
        ))}

      <div className="flex items-baseline gap-3">
        {/* Title carries the weight: 13.5px, tightened tracking, and it is the only
         *  element that grows in weight on selection. */}
        <span
          className={`min-w-0 flex-1 truncate text-[13.5px] leading-[1.3] tracking-[-0.008em] ${
            selected ? "font-semibold text-primary" : "font-medium text-primary"
          }`}
          title={job.title}
        >
          {job.title}
        </span>
        <AgeLabel job={job} thresholds={thresholds} />
        <MatchFit summary={summary} />
      </div>

      <div className="mt-1 flex items-center gap-2 text-[11px] leading-none">
        <span className="min-w-0 truncate text-secondary">
          {job.company_name}
          {job.location ? <span className="text-tertiary"> · {job.location}</span> : null}
          {!job.is_active && <span className="text-tertiary"> · closed</span>}
        </span>
        <WorkflowCue job={job} />
        {meta}
        <span className="ml-auto shrink-0">
          <H1bBadge confidence={job.h1b_combined_confidence} />
        </span>
      </div>
    </div>
  );
});
