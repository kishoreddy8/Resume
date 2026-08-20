"use client";

import Link from "next/link";
import type { QueueItem } from "./queue";
import { ScrollStrip } from "./ScrollStrip";
import { useCallback, useEffect, useRef, useState } from "react";
import { JobRow } from "./JobRow";
import { JobListSkeleton, LoadingRegion } from "./Skeletons";
import { EmptyState } from "./EmptyState";
import { AnimatePresence, motion } from "motion/react";
import type { RoleFamilyTier } from "@/lib/rank/forYou";
import type { CandidateJobBucket } from "@/lib/rank/candidateJobBucket";
import type { LifecycleThresholds } from "@/lib/jobLifecycle";
import type { ListMatchSummary } from "@/lib/rank/jobsList";
import type { CandidateRankingPreferences } from "@/db/queries/candidateSettings";
import type { ForYouResponseEntry, ForYouBucketCounts } from "@/app/api/candidates/[candidateId]/for-you/route";

/**
 * Phase 4 Stage 3 — Actionable "For You" Candidate Job Feed Component.
 *
 * Renders the actionable candidate-scoped feed with:
 * - Dynamic tab bar for actionable buckets: All, New Today, Top Matches, Ready for Tailoring,
 *   Needs Review, Ready to Apply, Applied, Interviewing.
 * - Dynamic live counts per bucket.
 * - Rich search and minimum match score filtering.
 * - Clear "Resume Ready" indicator for READY_TO_APPLY jobs with direct navigation to the
 *   existing resume quality workflow to inspect and download approved resumes.
 * - Full candidate isolation and zero N+1 database queries.
 *
 * WORKBENCH PHASE 2 — presentation only. This is now a Workbench master list rather than a
 * standalone table: it renders the same JobRow as All Jobs, hands selection up to the same
 * persistent review pane, and inherits that pane's motion, sheet and request behaviour. The feed's
 * ranking, buckets, inclusion rules, scores and API contract are untouched — every field below is
 * still whatever `/api/candidates/{id}/for-you` returned, in the order it returned it.
 *
 * Two things moved for consistency rather than preference:
 *  - search is now the toolbar's, passed in as a prop, because two search boxes for one view is a
 *    worse answer than one; it is also debounced there, where this component used to refetch the
 *    whole feed on every keystroke.
 *  - the per-row action buttons and pipeline control moved into the review pane, which is where
 *    All Jobs already puts them and where every one of them still works unchanged.
 */

type FeedTab =
  | "all"
  | "new_today"
  | "top_matches"
  | "ready_for_tailoring"
  | "needs_review"
  | "ready_to_apply"
  | "applied"
  | "interviewing";

interface TabConfig {
  id: FeedTab;
  label: string;
  countKey: keyof ForYouBucketCounts;
}

const TABS: TabConfig[] = [
  { id: "all", label: "All", countKey: "all" },
  { id: "new_today", label: "New Today", countKey: "newToday" },
  { id: "top_matches", label: "Top Matches", countKey: "topMatches" },
  { id: "ready_for_tailoring", label: "Ready for Tailoring", countKey: "readyForTailoring" },
  { id: "needs_review", label: "Needs Review", countKey: "needsReview" },
  { id: "ready_to_apply", label: "Ready to Apply", countKey: "readyToApply" },
  { id: "applied", label: "Applied", countKey: "applied" },
  { id: "interviewing", label: "Interviewing", countKey: "interviewing" },
];

/** Bucket label + dot. Same values and wording the feed already used; one chip shape instead of
 *  seven saturated fills, so the bucket reads as context beside the decision rather than against it. */
const BUCKET: Record<CandidateJobBucket, { label: string; dot: string }> = {
  READY_TO_APPLY: { label: "Resume Ready", dot: "bg-emerald-600 dark:bg-emerald-400" },
  READY_FOR_TAILORING: { label: "Ready for Tailoring", dot: "bg-purple-600 dark:bg-purple-400" },
  NEEDS_REVIEW: { label: "Needs Review", dot: "bg-amber-500 dark:bg-amber-400" },
  TOP_MATCH: { label: "Top Match", dot: "bg-indigo-600 dark:bg-indigo-400" },
  NEW_TODAY: { label: "New Today", dot: "bg-teal-600 dark:bg-teal-400" },
  APPLIED: { label: "Applied", dot: "bg-zinc-500 dark:bg-zinc-400" },
  INTERVIEWING: { label: "Interviewing", dot: "bg-blue-600 dark:bg-blue-400" },
};

const ROLE_FAMILY_LABEL: Record<Exclude<RoleFamilyTier, "NONE">, string> = {
  PRIMARY: "Primary role",
  SECONDARY: "Secondary role",
};

/**
 * True when the bucket chip would only restate the decision badge sitting a few pixels away.
 *
 * Most of the feed lands in READY_FOR_TAILORING or NEEDS_REVIEW, and for those the bucket name and
 * the decision name are the same word — 99% of rows were printing their verdict twice, in two
 * different visual languages, in the densest part of the UI. Suppressing the echo is presentation
 * only: the bucket value is untouched, and every bucket that carries workflow context the decision
 * cannot express (Resume Ready, Top Match, New Today, Applied, Interviewing) still renders.
 *
 * The `insufficientJdSignal` guard matters. When the engine distrusts the score the row shows
 * "Insufficient data" instead of the decision label, so the bucket is no longer a duplicate — it is
 * the only place the workflow state appears, and it stays.
 */
function bucketEchoesDecision(ranking: ForYouResponseEntry["ranking"]): boolean {
  if (ranking.insufficientJdSignal) return false;
  if (!ranking.decision || !ranking.primaryBucket) return false;
  return ranking.primaryBucket === ranking.decision;
}

/**
 * The recommendation-specific context that All Jobs has no equivalent for.
 *
 * The role cue now NAMES the target role that matched rather than printing the bare tier. Both
 * halves are already on the wire: `ranking.roleFamilyTier` is per entry, and the matched role text
 * comes from the response's own top-level `preferences` — the same object the empty state already
 * reads. No extra field, no extra request, and no second line: it replaces the label that was
 * occupying that slot, so row height and row DOM are unchanged.
 *
 * Which secondary role matched is not resolvable per row (the API sends the tier, not the winning
 * preference string), so SECONDARY names no role rather than guessing one.
 */
function RecommendationMeta({
  ranking,
  prefs,
}: {
  ranking: ForYouResponseEntry["ranking"];
  prefs: CandidateRankingPreferences | null;
}) {
  const bucket =
    ranking.primaryBucket && !bucketEchoesDecision(ranking) ? BUCKET[ranking.primaryBucket] : null;
  const tier = ranking.roleFamilyTier;
  const family =
    tier === "PRIMARY"
      ? prefs?.primaryTargetRole
        ? `P · ${prefs.primaryTargetRole}`
        : ROLE_FAMILY_LABEL.PRIMARY
      : tier === "SECONDARY"
        ? ROLE_FAMILY_LABEL.SECONDARY
        : null;
  if (!bucket && !family) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2">
      {family && (
        <span
          className={`truncate text-[10px] uppercase tracking-[0.06em] ${
            tier === "PRIMARY" ? "font-semibold text-[var(--accent)]" : "text-tertiary"
          }`}
        >
          {family}
        </span>
      )}
      {bucket && (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium text-secondary">
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${bucket.dot}`} />
          {bucket.label}
        </span>
      )}
    </span>
  );
}

/**
 * Stage 24B — the single place the list turns a persisted evaluation into a fit label.
 *
 * Three states, never conflated (Phase 15):
 *   NOT EVALUATED      — no job_match_results row for this candidate yet. No number is invented.
 *   INSUFFICIENT DATA  — evaluated, but the engine could not extract enough structured requirements
 *                        to trust the number (scoring.ts's MIN_REQUIREMENT_UNITS floor). The score is
 *                        deliberately NOT shown as a percentage.
 *   EVALUATED          — decision badge plus the real score.
 *
 * WORKBENCH — the same three states are now expressed by the shared row's MatchFit, so All Jobs and
 * For You cannot drift. This only narrows the feed's `ranking` to the shape that row expects; it
 * decides nothing and rewrites nothing.
 */
function toSummary(ranking: ForYouResponseEntry["ranking"]): ListMatchSummary | undefined {
  if (!ranking.decision) return undefined;
  return {
    decision: ranking.decision as ListMatchSummary["decision"],
    overallScore: ranking.overallScore ?? 0,
    insufficientJdSignal: Boolean(ranking.insufficientJdSignal),
  };
}

interface ForYouApiResponse {
  candidateId: number;
  preferences: CandidateRankingPreferences;
  bucketCounts: ForYouBucketCounts;
  entries: ForYouResponseEntry[];
}

export function ForYouList({
  candidateId,
  thresholds,
  search,
  selectedJobId,
  onSelect,
  onQueueChange,
}: {
  candidateId: number;
  thresholds: LifecycleThresholds;
  /** Committed (already debounced) search text from the application toolbar. */
  search: string;
  selectedJobId: number | null;
  onSelect: (id: number) => void;
  /** Same contract as JobList: the rendered order, so Previous/Next never recomputes neighbours. */
  onQueueChange?: (queue: QueueItem[]) => void;
}) {
  const [data, setData] = useState<ForYouApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<FeedTab>("all");
  const [includeStale, setIncludeStale] = useState(false);
  const [minScore, setMinScore] = useState<string>("");
  /* For You defaults to roles you actually target. Measured on the live feed: 364 of 500 entries
   * were NONE-tier — "Sr. Bioinformatics Scientist", "Financial Consultant Senior" — so three
   * quarters of the recommendations were not the job you are looking for. Filtering happens on the
   * server, before the limit, because role tier is only a tie-breaker in the ranking: 66 matched
   * jobs sat after the first unmatched one in a 200-item page, so a client-side filter would drop
   * matches that fell past the cap. Switchable, never silent. */
  const [roleScope, setRoleScope] = useState<"matched" | "all">("matched");
  const listRef = useRef<HTMLDivElement>(null);
  const [sharedLayout, setSharedLayout] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (includeStale) params.set("includeStale", "true");
      if (activeTab !== "all") params.set("bucket", activeTab);
      if (search.trim()) params.set("search", search.trim());
      if (minScore) params.set("minScore", minScore);
      if (roleScope === "matched") params.set("roleFamily", "PRIMARY,SECONDARY");

      const res = await fetch(`/api/candidates/${candidateId}/for-you?${params.toString()}`);
      const body = await res.json();
      setData(res.ok ? body : null);
    } finally {
      setLoading(false);
    }
  }, [candidateId, includeStale, activeTab, search, minScore, roleScope]);

  useEffect(() => {
    // Intentional: fetch-on-mount/filter-change with loading flag, not a render loop
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const entries = data?.entries ?? [];

  /* Publish the rendered order for Previous/Next. Same keying discipline as JobList. */
  const queueKey = entries.map((e) => e.job.id).join(",");
  useEffect(() => {
    if (!onQueueChange) return;
    onQueueChange(entries.map((e) => ({ id: e.job.id, title: e.job.title })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey]);

  // Same contract as the All Jobs list: keep the selection on something the feed actually renders.
  const selectionVisible = selectedJobId !== null && entries.some((e) => e.job.id === selectedJobId);
  useEffect(() => {
    if (entries.length === 0 || selectionVisible) return;
    onSelect(entries[0].job.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionVisible, entries.length]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea, button, a, [contenteditable]")) return;
    if (entries.length === 0) return;
    e.preventDefault();
    setSharedLayout(false);
    const i = entries.findIndex((entry) => entry.job.id === selectedJobId);
    const next = e.key === "ArrowDown" ? Math.min(i + 1, entries.length - 1) : Math.max(i - 1, 0);
    const nextEntry = entries[next < 0 ? 0 : next];
    if (nextEntry) {
      onSelect(nextEntry.job.id);
      listRef.current
        ?.querySelector(`[data-job-row="${nextEntry.job.id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }

  const hasPreferences =
    Boolean(data?.preferences.primaryTargetRole) || (data?.preferences.secondaryTargetRoles.length ?? 0) > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--separator)]">
        {!hasPreferences && (
          <div className="border-b border-[var(--separator)] px-4 py-2 text-[11px] text-tertiary">
            No target role set yet — jobs are ranked by fit/freshness only.{" "}
            <Link href={`/candidates/${candidateId}/settings`} className="underline">
              Set your target roles
            </Link>
          </div>
        )}

        {/* Bucket tabs. Every bucket must be REACHABLE, not merely present: the strip carries real
         *  scroll controls outside the track, and the active tab is scrolled into view whenever it
         *  changes. A fade alone left the later buckets unreachable by mouse or keyboard. */}
        <ScrollStrip label="job buckets" activeSelector="[data-bucket-active='true']">
          {TABS.map((tab) => {
            const count = data?.bucketCounts?.[tab.countKey] ?? 0;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-pressed={isActive}
                data-bucket-active={isActive ? "true" : undefined}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors duration-150 ease-out active:scale-[0.98] ${
                  isActive
                    ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                    : "text-secondary hover:bg-[var(--surface-hover)] hover:text-primary"
                }`}
              >
                <span>{tab.label}</span>
                <span className={`tabular-nums text-[10px] ${isActive ? "opacity-80" : "text-tertiary"}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </ScrollStrip>

        <div className="flex items-center gap-3 px-4 pb-2 text-[11px]">
          <select
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
            aria-label="Minimum match score"
            className="rounded-md border border-[var(--border)] bg-surface px-2 py-1 text-[11px] text-primary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)]"
          >
            <option value="">Any Score</option>
            <option value="90">90+ Score</option>
            <option value="85">85+ Score</option>
            <option value="80">80+ Score</option>
            <option value="70">70+ Score</option>
          </select>
          {/* Role scope. Named after the candidate's own target roles so it is obvious what is
           *  being filtered, and what switching it off would let back in. */}
          <select
            value={roleScope}
            onChange={(e) => setRoleScope(e.target.value as "matched" | "all")}
            aria-label="Role scope"
            className="rounded-md border border-[var(--border)] bg-surface px-2 py-1 text-[11px] text-primary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)]"
          >
            <option value="matched">My target roles</option>
            <option value="all">All roles</option>
          </select>
          <label className="flex items-center gap-1.5 text-secondary">
            <input type="checkbox" checked={includeStale} onChange={(e) => setIncludeStale(e.target.checked)} />
            Include stale (&gt;20d)
          </label>
          <span className="ml-auto tabular-nums text-tertiary">{entries.length}</span>
        </div>
      </div>

      {loading ? (
        <AnimatePresence mode="wait">
          <motion.div key="skeleton" exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
            <LoadingRegion label="Loading recommended jobs" />
            <JobListSkeleton />
          </motion.div>
        </AnimatePresence>
      ) : entries.length === 0 ? (
        <EmptyState
          title={search.trim() ? "No recommendations match that search" : activeTab === "all" ? "No recommendations yet" : "This bucket is empty"}
          body={
            search.trim()
              ? `Nothing in your feed matches “${search.trim()}”. Clear the search to see the full recommendation set.`
              : activeTab === "all"
                ? "Once jobs are scanned and evaluated against your profile, your strongest matches appear here."
                : "No job currently sits in this stage. Other buckets may still have work waiting."
          }
          action={
            activeTab !== "all" ? (
              <button
                type="button"
                onClick={() => setActiveTab("all")}
                className="rounded-[9px] bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] shadow-[var(--lift-1)] transition-colors duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
              >
                Show all recommendations
              </button>
            ) : null
          }
        />
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Recommended jobs"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onPointerDown={() => setSharedLayout(true)}
          className="min-h-0 flex-1 overflow-y-auto [scroll-padding-block:3rem]"
        >
          {entries.map(({ job, ranking }) => (
            <JobRow
              key={job.id}
              job={job}
              thresholds={thresholds}
              summary={toSummary(ranking)}
              selected={job.id === selectedJobId}
              onSelect={onSelect}
              sharedLayout={sharedLayout}
              meta={<RecommendationMeta ranking={ranking} prefs={data?.preferences ?? null} />}
            />
          ))}
        </div>
      )}
    </div>
  );
}
