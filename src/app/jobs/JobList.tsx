"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FreshnessBadge } from "@/components/FreshnessBadge";
import { H1bBadge } from "@/components/H1bBadge";
import { MatchDecisionBadge, type MatchDecision } from "@/components/MatchDecisionBadge";
import { NotInterestedToggle } from "@/components/NotInterestedToggle";
import { PipelineStatusSelect } from "@/components/PipelineStatusSelect";
import { getJobAgeBand, getJobAgeDays, type LifecycleThresholds } from "@/lib/jobLifecycle";
import { computeFreshnessTier } from "@/lib/rank/forYou";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import type { JobWithCompany } from "@/types";

type DecisionFilter = "All" | MatchDecision | "Not Evaluated";
const DECISION_FILTERS: DecisionFilter[] = ["All", "READY_FOR_TAILORING", "NEEDS_REVIEW", "BLOCKED", "Not Evaluated"];
const DECISION_FILTER_LABELS: Record<DecisionFilter, string> = {
  All: "All",
  READY_FOR_TAILORING: "Ready for Tailoring",
  NEEDS_REVIEW: "Needs Review",
  BLOCKED: "Blocked",
  "Not Evaluated": "Not Evaluated",
};

interface ListMatchSummary {
  decision: MatchDecision;
  overallScore: number;
  /** Stage 24B — the engine's own JD-evidence-quality flag, carried through
   *  /api/jobs/match-decisions so this list can distinguish an untrustworthy score from a real one
   *  exactly as the For You feed does. */
  insufficientJdSignal: boolean;
}

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

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Fresh is the age-based lifecycle policy's "highlight as high priority" band — computed live from
 *  posted_at/first_seen_at, never persisted. `thresholds` comes from Settings > Lifecycle (see
 *  useLifecycleThresholds) so this always agrees with what the automated sweep will actually do. */
function FreshBadge({ job, thresholds }: { job: JobWithCompany; thresholds: LifecycleThresholds }) {
  const ageDays = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at });
  if (getJobAgeBand(ageDays, thresholds) !== "fresh") return null;
  return (
    <span
      className="ml-1.5 inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
      title={`Posted ${ageDays} day${ageDays === 1 ? "" : "s"} ago — high priority`}
    >
      Fresh
    </span>
  );
}

function TailoringCheckbox({ jobId, initial, candidateId }: { jobId: number; initial: boolean; candidateId: number }) {
  const [checked, setChecked] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function toggle() {
    const next = !checked;
    setChecked(next);
    setSaving(true);
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, markedForTailoring: next }),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={saving}
      onChange={toggle}
      title="Mark for resume tailoring"
      className="h-4 w-4"
    />
  );
}

/** Stage 24B — same three-state contract as the For You feed's cell (not evaluated / insufficient
 *  data / evaluated). Kept local to this component rather than shared, because the two lists read
 *  from different response shapes; the SEMANTICS are what must agree, and they do. */
function MatchFitCell({ summary }: { summary: ListMatchSummary | undefined }) {
  if (!summary) return <span className="text-xs text-zinc-400">Not evaluated</span>;
  if (summary.insufficientJdSignal) {
    return (
      <span
        className="inline-flex items-center rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        title="This posting did not yield enough structured requirements to score reliably."
      >
        Insufficient data
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <MatchDecisionBadge decision={summary.decision} />
      <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">{Math.round(summary.overallScore)}/100</span>
    </div>
  );
}

/** Stage 24B (Phase 13) — deterministic best-first ordering for the All Jobs view, which previously
 *  rendered listJobs()' raw SQL order and could therefore show an unevaluated or insufficient-signal
 *  posting above a strong fresh match. Same key philosophy as src/lib/rank/forYou.ts, applied to the
 *  facts this view actually has: decision, evidence quality, score, then recency, then a stable id
 *  tie-break. Client-side and display-only — it does not touch listJobs' SQL or its filters. */
const LIST_DECISION_RANK: Record<MatchDecision, number> = { READY_FOR_TAILORING: 0, NEEDS_REVIEW: 1, BLOCKED: 3 };

function compareJobsBestFirst(
  a: JobWithCompany,
  b: JobWithCompany,
  decisions: Record<string, ListMatchSummary>
): number {
  const am = decisions[a.dedupe_key];
  const bm = decisions[b.dedupe_key];

  const aDecision = am ? LIST_DECISION_RANK[am.decision] : 2; // not evaluated sits above BLOCKED
  const bDecision = bm ? LIST_DECISION_RANK[bm.decision] : 2;
  if (aDecision !== bDecision) return aDecision - bDecision;

  const aEvidence = am ? (am.insufficientJdSignal ? 1 : 0) : 2;
  const bEvidence = bm ? (bm.insufficientJdSignal ? 1 : 0) : 2;
  if (aEvidence !== bEvidence) return aEvidence - bEvidence;

  const aScore = am && !am.insufficientJdSignal ? am.overallScore : -1;
  const bScore = bm && !bm.insufficientJdSignal ? bm.overallScore : -1;
  if (aScore !== bScore) return bScore - aScore;

  const aPosted = a.posted_at ? new Date(a.posted_at).getTime() : 0;
  const bPosted = b.posted_at ? new Date(b.posted_at).getTime() : 0;
  if (aPosted !== bPosted) return bPosted - aPosted;

  return b.id - a.id;
}

export function JobList({ jobs, thresholds }: { jobs: JobWithCompany[]; thresholds: LifecycleThresholds }) {
  const candidateId = useActiveCandidateId();
  const decisions = useMatchDecisions(jobs, candidateId);
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("All");

  const visibleJobs = jobs
    .filter((job) => {
      if (decisionFilter === "All") return true;
      const entry = decisions[job.dedupe_key];
      if (decisionFilter === "Not Evaluated") return !entry;
      return entry?.decision === decisionFilter;
    })
    .slice()
    .sort((a, b) => compareJobsBestFirst(a, b, decisions));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-500">Match decision:</span>
        <select
          value={decisionFilter}
          onChange={(e) => setDecisionFilter(e.target.value as DecisionFilter)}
          className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
        >
          {DECISION_FILTERS.map((f) => (
            <option key={f} value={f}>
              {DECISION_FILTER_LABELS[f]}
            </option>
          ))}
        </select>
      </div>

      {visibleJobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No jobs match these filters. Add companies and run a scan, or widen your filters.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Title / Company</th>
                <th className="px-3 py-2 font-medium">Location</th>
                <th className="px-3 py-2 font-medium">Posted</th>
                <th className="px-3 py-2 font-medium">H1B</th>
                <th className="px-3 py-2 font-medium">Match</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-center">Tailor</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {visibleJobs.map((job) => (
            <tr key={job.id} className={job.is_active ? "" : "opacity-50"}>
              <td className="px-3 py-2">
                <Link href={`/jobs/${job.id}`} className="font-medium hover:underline">
                  {job.title}
                </Link>
                <FreshBadge job={job} thresholds={thresholds} />
                <div className="text-xs text-zinc-500">
                  {job.company_name} · {job.source_type}
                  {!job.is_active && " · closed"}
                </div>
              </td>
              <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{job.location ?? "—"}</td>
              <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                <div>{formatDate(job.posted_at)}</div>
                <FreshnessBadge tier={computeFreshnessTier(job.posted_at)} />
              </td>
              <td className="px-3 py-2">
                <H1bBadge confidence={job.h1b_combined_confidence} />
              </td>
              <td className="px-3 py-2">
                <MatchFitCell summary={decisions[job.dedupe_key]} />
              </td>
              <td className="px-3 py-2">
                <PipelineStatusSelect jobId={job.id} value={job.pipeline_status} candidateId={candidateId} />
              </td>
              <td className="px-3 py-2 text-center">
                <TailoringCheckbox jobId={job.id} initial={job.marked_for_tailoring === 1} candidateId={candidateId} />
              </td>
              <td className="px-3 py-2 text-right">
                <div className="flex flex-col items-end gap-1">
                  <a
                    href={job.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                  >
                    View ↗
                  </a>
                  <NotInterestedToggle
                    jobId={job.id}
                    jobTitle={job.title}
                    candidateId={candidateId}
                    initialNotInterested={job.not_interested === 1}
                  />
                </div>
              </td>
            </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
