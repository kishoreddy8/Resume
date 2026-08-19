"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { JobRow } from "./JobRow";
import type { LifecycleThresholds } from "@/lib/jobLifecycle";
import {
  compareJobsBestFirst,
  matchesDecisionFilter,
  type DecisionFilter,
  type ListMatchSummary,
} from "@/lib/rank/jobsList";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import type { JobWithCompany } from "@/types";

const DECISION_FILTERS: DecisionFilter[] = ["All", "READY_FOR_TAILORING", "NEEDS_REVIEW", "BLOCKED", "Not Evaluated"];
const DECISION_FILTER_LABELS: Record<DecisionFilter, string> = {
  All: "All",
  READY_FOR_TAILORING: "Ready for Tailoring",
  NEEDS_REVIEW: "Needs Review",
  BLOCKED: "Blocked",
  "Not Evaluated": "Not Evaluated",
};

/** Rows materialized on first paint. The full filtered+sorted set is still computed; see the note
 *  in JobList on why only rendering is bounded. */
const INITIAL_RENDER_LIMIT = 100;
const RENDER_LIMIT_STEP = 200;

/** Batch-fetches the latest Phase 2 match decision for every visible job's dedupe_key in one
 *  request — never one request per row. Purely additive/client-side: does not touch listJobs'
 *  server-side SQL or JobFilterSidebar's URL-param-driven filters. */
function useMatchDecisions(jobs: JobWithCompany[], candidateId: number): Record<string, ListMatchSummary> {
  const [decisions, setDecisions] = useState<Record<string, ListMatchSummary>>({});
  const dedupeKeysKey = jobs.map((j) => j.dedupe_key).join(",");

  useEffect(() => {
    const dedupeKeys = dedupeKeysKey ? dedupeKeysKey.split(",") : [];
    let cancelled = false;
    // Always resolves asynchronously (even the empty-list case) so setDecisions is never called
    // synchronously within the effect body itself.
    const request: Promise<Record<string, ListMatchSummary>> =
      dedupeKeys.length === 0
        ? Promise.resolve({})
        : fetch("/api/jobs/match-decisions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dedupeKeys, candidateId }),
          })
            .then((res) => res.json())
            .then((body) => body.decisions ?? {});

    request.then((decisions) => {
      if (!cancelled) setDecisions(decisions);
    }).catch(() => {
      if (!cancelled) setDecisions({});
    });

    return () => {
      cancelled = true;
    };
  }, [dedupeKeysKey, candidateId]);

  return decisions;
}

/** Ordering and the decision filter both come from @/lib/rank/jobsList — see that module for the
 *  contract and why it lives there rather than inline. */
export function JobList({
  jobs,
  thresholds,
  selectedJobId,
  onSelect,
}: {
  jobs: JobWithCompany[];
  thresholds: LifecycleThresholds;
  selectedJobId: number | null;
  onSelect: (id: number) => void;
}) {
  const candidateId = useActiveCandidateId();
  const decisions = useMatchDecisions(jobs, candidateId);
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("All");
  const router = useRouter();
  const listRef = useRef<HTMLDivElement>(null);
  // Shared-layout travel is allowed for pointer selection and suppressed for keyboard selection:
  // Arrow-key traversal is the app's highest-frequency action and must stay instant.
  const [sharedLayout, setSharedLayout] = useState(true);

  const visibleJobs = useMemo(
    () =>
      jobs
        .filter((job) => matchesDecisionFilter(job, decisions, decisionFilter))
        .slice()
        .sort((a, b) => compareJobsBestFirst(a, b, decisions)),
    [jobs, decisions, decisionFilter]
  );

  // Stage 32 — bound how many rows are MATERIALIZED, never how many are considered.
  //
  // Filtering and best-first sorting above still run over the entire result set, so the rows shown
  // are genuinely the best matches for the current filters; this only stops React from building
  // ~15.7k <tr> elements (each with links, badges and date formatting) on first paint, which was
  // the largest remaining cost in the jobs page after the API work. "Show more" reveals the rest in
  // place, and the header states the true total so the count is never misleading.
  // Changing the filter, or receiving a different job set, starts the list over at the top. This is
  // React's "adjust state during render" pattern rather than an effect: an effect would paint the
  // previous filter's rows once before correcting itself, which is both a visible flash and the
  // cascading render the lint rule warns about.
  const resetKey = `${decisionFilter}:${jobs.length}`;
  const [renderState, setRenderState] = useState({ key: resetKey, limit: INITIAL_RENDER_LIMIT });
  if (renderState.key !== resetKey) {
    setRenderState({ key: resetKey, limit: INITIAL_RENDER_LIMIT });
  }
  const renderLimit = renderState.key === resetKey ? renderState.limit : INITIAL_RENDER_LIMIT;
  const renderedJobs = visibleJobs.slice(0, renderLimit);
  const hiddenCount = visibleJobs.length - renderedJobs.length;

  // Keep the selection inside the rendered window. This is re-checked whenever the selection stops
  // being visible — which matters on first paint, because the match decisions arrive after the jobs
  // do and the best-first order changes when they land. Selecting purely on mount would strand the
  // selection on a job that the re-ranked list no longer renders.
  const selectionVisible =
    selectedJobId !== null && renderedJobs.some((j) => j.id === selectedJobId);
  useEffect(() => {
    if (renderedJobs.length === 0 || selectionVisible) return;
    onSelect(renderedJobs[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionVisible, renderedJobs.length]);

  /**
   * Arrow-key traversal. Deliberately narrow:
   *  - only acts when the event target is the list itself or a row, so selects, inputs, textareas
   *    and buttons inside the pane keep their own arrow behaviour;
   *  - moves selection only — it never triggers an action, never tailors, never mutates;
   *  - suppresses the shared-layout travel, because this is the highest-frequency interaction.
   */
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea, button, a, [contenteditable]")) return;
    if (renderedJobs.length === 0) return;

    if (e.key === "Enter") {
      if (selectedJobId !== null) router.push(`/jobs/${selectedJobId}`);
      return;
    }

    e.preventDefault();
    setSharedLayout(false);
    const i = renderedJobs.findIndex((j) => j.id === selectedJobId);
    const next =
      e.key === "ArrowDown"
        ? Math.min(i + 1, renderedJobs.length - 1)
        : Math.max(i - 1, 0);
    const nextJob = renderedJobs[next < 0 ? 0 : next];
    if (nextJob) {
      onSelect(nextJob.id);
      listRef.current
        ?.querySelector(`[data-job-row="${nextJob.id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--separator)] px-4 py-2 text-xs">
        <span className="text-tertiary">Match decision:</span>
        <select
          value={decisionFilter}
          onChange={(e) => setDecisionFilter(e.target.value as DecisionFilter)}
          className="rounded-md border border-[var(--border)] bg-surface px-2 py-1 text-primary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)]"
        >
          {DECISION_FILTERS.map((f) => (
            <option key={f} value={f}>
              {DECISION_FILTER_LABELS[f]}
            </option>
          ))}
        </select>
        {visibleJobs.length > 0 && (
          <span className="ml-auto tabular-nums text-tertiary">
            {renderedJobs.length.toLocaleString()} / {visibleJobs.length.toLocaleString()}
          </span>
        )}
      </div>

      {visibleJobs.length === 0 ? (
        <div className="m-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] p-10 text-center text-[13px] text-tertiary">
          No jobs match these filters. Add companies and run a scan, or widen your filters.
        </div>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Jobs"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onPointerDown={() => setSharedLayout(true)}
          // scroll-padding keeps a keyboard-focused row clear of the sticky filter bar
          // (WCAG 2.2 "Focus Not Obscured").
          className="min-h-0 flex-1 overflow-y-auto [scroll-padding-block:3rem]"
        >
          {renderedJobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              thresholds={thresholds}
              summary={decisions[job.dedupe_key]}
              selected={job.id === selectedJobId}
              onSelect={onSelect}
              sharedLayout={sharedLayout}
            />
          ))}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setRenderState((prev) => ({ key: resetKey, limit: prev.limit + RENDER_LIMIT_STEP }))}
              className="w-full px-4 py-3 text-[13px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:bg-[var(--surface-active)]"
            >
              Show {Math.min(RENDER_LIMIT_STEP, hiddenCount).toLocaleString()} more ({hiddenCount.toLocaleString()} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
