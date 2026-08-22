"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { JobRow } from "./JobRow";
import { JobListSkeleton, LoadingRegion } from "./Skeletons";
import { EmptyState } from "./EmptyState";
import { useSetupNotice } from "@/lib/useSetupNotice";
import type { QueueItem } from "./queue";
import type { LifecycleThresholds } from "@/lib/jobLifecycle";
import type { ListMatchSummary } from "@/lib/rank/jobsList";
import type { CandidateRankingPreferences } from "@/db/queries/candidateSettings";
import type { ForYouResponseEntry, ForYouBucketCounts } from "@/app/api/candidates/[candidateId]/for-you/route";

type CandidateFeedMode = "forYou" | "saved";

interface ForYouApiResponse {
  candidateId: number;
  preferences: CandidateRankingPreferences;
  bucketCounts: ForYouBucketCounts;
  bucketCountsUnfiltered: ForYouBucketCounts;
  entries: ForYouResponseEntry[];
}

function toSummary(ranking: ForYouResponseEntry["ranking"]): ListMatchSummary | undefined {
  if (!ranking.decision) return undefined;
  return {
    decision: ranking.decision as ListMatchSummary["decision"],
    overallScore: ranking.overallScore ?? 0,
    insufficientJdSignal: Boolean(ranking.insufficientJdSignal),
  };
}

function RecommendationMeta({ ranking }: { ranking: ForYouResponseEntry["ranking"] }) {
  if (ranking.badges.isTopMatch) {
    return <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 font-semibold text-[var(--accent)]">Top match</span>;
  }
  if (ranking.roleFamilyTier === "PRIMARY") {
    return <span className="rounded-full bg-[var(--z0-bg)] px-2.5 py-1 font-medium text-secondary">Primary role</span>;
  }
  if (ranking.hasReadyResume) {
    return <span className="rounded-full bg-[var(--pill-success-bg)] px-2.5 py-1 font-semibold text-[var(--pill-success-fg)]">Resume ready</span>;
  }
  return null;
}

export function ForYouList({
  mode,
  candidateId,
  thresholds,
  search,
  selectedJobId,
  onSelect,
  onQueueChange,
}: {
  mode: CandidateFeedMode;
  candidateId: number;
  thresholds: LifecycleThresholds;
  search: string;
  selectedJobId: number | null;
  onSelect: (id: number) => void;
  onQueueChange?: (queue: QueueItem[]) => void;
}) {
  const router = useRouter();
  const setupNotice = useSetupNotice();
  const listRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ForYouApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [includeStale, setIncludeStale] = useState(false);
  const [minScore, setMinScore] = useState("");
  const [roleScope, setRoleScope] = useState<"matched" | "all">("matched");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (mode === "saved") {
        params.set("savedOnly", "true");
        params.set("includeStale", "true");
      } else if (includeStale) params.set("includeStale", "true");
      if (search.trim()) params.set("search", search.trim());
      if (mode === "forYou" && minScore) params.set("minScore", minScore);
      if (mode === "forYou" && roleScope === "matched") params.set("roleFamily", "PRIMARY,SECONDARY");
      const response = await fetch(`/api/candidates/${candidateId}/for-you?${params.toString()}`);
      const body = await response.json();
      setData(response.ok ? body : null);
    } finally {
      setLoading(false);
    }
  }, [candidateId, includeStale, minScore, mode, roleScope, search]);

  useEffect(() => {
    // Fetch-on-filter-change is intentional; the API ranks and filters before its bounded limit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const entries = useMemo(
    () => (data?.entries ?? []).filter((entry) => mode !== "saved" || entry.job.pinned === 1),
    [data, mode]
  );

  const queueKey = entries.map((entry) => entry.job.id).join(",");
  useEffect(() => {
    onQueueChange?.(entries.map((entry) => ({ id: entry.job.id, title: entry.job.title })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey]);

  const selectionVisible = selectedJobId !== null && entries.some((entry) => entry.job.id === selectedJobId);
  useEffect(() => {
    if (entries.length > 0 && !selectionVisible) onSelect(entries[0].job.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, selectionVisible]);

  function openJob(id: number) {
    onSelect(id);
    router.push(`/jobs/${id}`);
  }

  function updateSaved(jobId: number, saved: boolean) {
    setData((current) =>
      current
        ? {
            ...current,
            entries: current.entries.map((entry) =>
              entry.job.id === jobId ? { ...entry, job: { ...entry.job, pinned: saved ? 1 : 0 } } : entry
            ),
          }
        : current
    );
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key) || entries.length === 0) return;
    if ((event.target as HTMLElement).closest("input, select, textarea, button, a, [contenteditable]")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (selectedJobId !== null) openJob(selectedJobId);
      return;
    }
    event.preventDefault();
    const index = entries.findIndex((entry) => entry.job.id === selectedJobId);
    const next = event.key === "ArrowDown" ? Math.min(index + 1, entries.length - 1) : Math.max(index - 1, 0);
    const entry = entries[next < 0 ? 0 : next];
    if (entry) {
      onSelect(entry.job.id);
      listRef.current?.querySelector(`[data-job-row="${entry.job.id}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }

  return (
    <section className="rounded-[22px] border border-[var(--border)] bg-[color-mix(in_oklab,var(--surface)_88%,transparent)] p-3 shadow-[var(--lift-1)] md:p-5">
      {mode === "forYou" ? (
        <div className="mb-5 flex flex-wrap items-center gap-3 border-b border-[var(--separator)] pb-4">
          <select
            value={minScore}
            onChange={(event) => setMinScore(event.target.value)}
            aria-label="Minimum match score"
            className="h-11 rounded-[11px] border border-[var(--border)] bg-surface px-3 text-[13.5px] text-primary"
          >
            <option value="">Any match score</option>
            <option value="90">90+ match</option>
            <option value="85">85+ match</option>
            <option value="80">80+ match</option>
            <option value="70">70+ match</option>
          </select>
          <select
            value={roleScope}
            onChange={(event) => setRoleScope(event.target.value as "matched" | "all")}
            aria-label="Role scope"
            className="h-11 rounded-[11px] border border-[var(--border)] bg-surface px-3 text-[13.5px] text-primary"
          >
            <option value="matched">My target roles</option>
            <option value="all">All roles</option>
          </select>
          <label className="flex min-h-11 items-center gap-2 px-1 text-[13.5px] text-secondary">
            <input type="checkbox" checked={includeStale} onChange={(event) => setIncludeStale(event.target.checked)} className="h-[18px] w-[18px] accent-[var(--accent)]" />
            Include older jobs
          </label>
          <span className="ml-auto text-[13px] text-tertiary"><strong className="text-primary">{entries.length}</strong> recommended</span>
        </div>
      ) : (
        <div className="mb-5 flex items-center justify-between border-b border-[var(--separator)] pb-4">
          <div>
            <h2 className="text-[18px] font-semibold text-primary">Saved opportunities</h2>
            <p className="mt-1 text-[13.5px] text-secondary">Your shortlist, kept in one calm place.</p>
          </div>
          <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1.5 text-[13px] font-semibold text-[var(--accent)]">{entries.length} saved</span>
        </div>
      )}

      {loading ? (
        <AnimatePresence mode="wait"><motion.div key="loading" exit={{ opacity: 0 }}><LoadingRegion label="Loading jobs" /><JobListSkeleton /></motion.div></AnimatePresence>
      ) : entries.length === 0 && setupNotice && mode === "forYou" ? (
        <EmptyState title={setupNotice.title} body={setupNotice.body} action={<Link href={setupNotice.href} className="inline-flex rounded-[10px] bg-[var(--accent)] px-4 py-2 font-semibold text-[var(--accent-fg)]">{setupNotice.cta}</Link>} />
      ) : entries.length === 0 ? (
        <EmptyState
          title={mode === "saved" ? "Save roles you want to revisit" : search.trim() ? "No recommendations match that search" : "No recommendations yet"}
          body={mode === "saved" ? "Tap the heart on any job to build a focused shortlist. Saved jobs stay here even when they get older." : "Try widening your role or match filters. New evaluated opportunities will appear here automatically."}
          action={mode === "saved" ? <button type="button" onClick={() => router.push("/jobs")} className="rounded-[10px] bg-[var(--accent)] px-4 py-2 text-[13.5px] font-semibold text-[var(--accent-fg)]">Explore jobs</button> : null}
        />
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label={mode === "saved" ? "Saved jobs" : "Recommended jobs"}
          aria-activedescendant={selectedJobId !== null ? `candidate-job-${selectedJobId}` : undefined}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="space-y-3"
        >
          {entries.map(({ job, ranking }) => (
            <JobRow
              key={job.id}
              job={job}
              candidateId={candidateId}
              thresholds={thresholds}
              summary={toSummary(ranking)}
              selected={job.id === selectedJobId}
              onOpen={openJob}
              onSavedChange={updateSaved}
              optionId={`candidate-job-${job.id}`}
              meta={<RecommendationMeta ranking={ranking} />}
            />
          ))}
        </div>
      )}
    </section>
  );
}
