"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FreshnessBadge } from "@/components/FreshnessBadge";
import { H1bBadge } from "@/components/H1bBadge";
import { MatchDecisionBadge, type MatchDecision } from "@/components/MatchDecisionBadge";
import { NotInterestedToggle } from "@/components/NotInterestedToggle";
import { PipelineStatusSelect } from "@/components/PipelineStatusSelect";
import type { RoleFamilyTier } from "@/lib/rank/forYou";
import type { CandidateJobBucket } from "@/lib/rank/candidateJobBucket";
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

function RoleFamilyBadge({ tier }: { tier: RoleFamilyTier }) {
  if (tier === "NONE") return null;
  const label = tier === "PRIMARY" ? "Primary role match" : "Secondary role match";
  const style =
    tier === "PRIMARY"
      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
      : "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300";
  return (
    <span className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style}`}>
      {label}
    </span>
  );
}

function PrimaryBucketBadge({ bucket }: { bucket: CandidateJobBucket | null }) {
  if (!bucket) return null;
  switch (bucket) {
    case "READY_TO_APPLY":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400" />
          Resume Ready
        </span>
      );
    case "READY_FOR_TAILORING":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-800 dark:bg-purple-950/60 dark:text-purple-300">
          Ready for Tailoring
        </span>
      );
    case "NEEDS_REVIEW":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
          Needs Review
        </span>
      );
    case "TOP_MATCH":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300">
          Top Match
        </span>
      );
    case "NEW_TODAY":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-teal-100 px-2 py-0.5 text-xs font-semibold text-teal-800 dark:bg-teal-950/60 dark:text-teal-300">
          New Today
        </span>
      );
    case "APPLIED":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-zinc-200 px-2 py-0.5 text-xs font-semibold text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
          Applied
        </span>
      );
    case "INTERVIEWING":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
          Interviewing
        </span>
      );
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Stage 24B — the single place the list turns a persisted evaluation into a fit label.
 *
 * Three states, never conflated (Phase 15):
 *   NOT EVALUATED      — no job_match_results row for this candidate yet. No number is invented.
 *   INSUFFICIENT DATA  — evaluated, but the engine could not extract enough structured requirements
 *                        to trust the number (scoring.ts's MIN_REQUIREMENT_UNITS floor). The score is
 *                        deliberately NOT shown as a percentage: showing "100%" for a posting whose
 *                        only applicable dimension was a years-of-experience minimum, or "0%" for one
 *                        whose description never parsed, is exactly the fake-confidence problem this
 *                        stage exists to remove.
 *   EVALUATED          — decision badge plus the real score.
 */
function MatchFitCell({ ranking }: { ranking: ForYouResponseEntry["ranking"] }) {
  if (!ranking.decision) {
    return <span className="text-xs text-zinc-400">Not evaluated</span>;
  }

  if (ranking.insufficientJdSignal) {
    return (
      <div className="flex flex-col gap-0.5">
        <span
          className="inline-flex w-fit items-center rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          title="This posting did not yield enough structured requirements to score reliably — the underlying number is not a confident match or non-match."
        >
          Insufficient data
        </span>
        <span className="text-[11px] text-zinc-400">score not reliable</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <MatchDecisionBadge decision={ranking.decision as MatchDecision} />
      {ranking.overallScore !== null && (
        <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
          Score: {Math.round(ranking.overallScore)}/100
        </span>
      )}
    </div>
  );
}

interface ForYouApiResponse {
  candidateId: number;
  preferences: CandidateRankingPreferences;
  bucketCounts: ForYouBucketCounts;
  entries: ForYouResponseEntry[];
}

export function ForYouList({ candidateId }: { candidateId: number }) {
  const [data, setData] = useState<ForYouApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<FeedTab>("all");
  const [includeStale, setIncludeStale] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [minScore, setMinScore] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (includeStale) params.set("includeStale", "true");
      if (activeTab !== "all") params.set("bucket", activeTab);
      if (searchQuery.trim()) params.set("search", searchQuery.trim());
      if (minScore) params.set("minScore", minScore);

      const res = await fetch(`/api/candidates/${candidateId}/for-you?${params.toString()}`);
      const body = await res.json();
      setData(res.ok ? body : null);
    } finally {
      setLoading(false);
    }
  }, [candidateId, includeStale, activeTab, searchQuery, minScore]);

  useEffect(() => {
    // Intentional: fetch-on-mount/filter-change with loading flag, not a render loop
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  function removeEntry(jobId: number) {
    setData((prev) => (prev ? { ...prev, entries: prev.entries.filter((e) => e.job.id !== jobId) } : prev));
  }

  const hasPreferences =
    Boolean(data?.preferences.primaryTargetRole) || (data?.preferences.secondaryTargetRoles.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      {!hasPreferences && (
        <div className="rounded-lg border border-dashed border-zinc-300 p-3 text-xs text-zinc-500 dark:border-zinc-700">
          No target role set yet — jobs are ranked by fit/freshness only.{" "}
          <Link href={`/candidates/${candidateId}/settings`} className="underline">
            Set your target roles
          </Link>{" "}
          to prioritize matching jobs first.
        </div>
      )}

      {/* Actionable Bucket Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-200 pb-2 dark:border-zinc-800">
        {TABS.map((tab) => {
          const count = data?.bucketCounts?.[tab.countKey] ?? 0;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
              }`}
            >
              <span>{tab.label}</span>
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] font-semibold ${
                  isActive
                    ? "bg-zinc-800 text-zinc-200 dark:bg-zinc-200 dark:text-zinc-800"
                    : "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Search and Secondary Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            placeholder="Filter title, company, skills…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-56 rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />

          <select
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
            className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <option value="">Any Score</option>
            <option value="90">90+ Score</option>
            <option value="85">85+ Score</option>
            <option value="80">80+ Score</option>
            <option value="70">70+ Score</option>
          </select>

          <label className="flex items-center gap-1.5 text-zinc-500">
            <input
              type="checkbox"
              checked={includeStale}
              onChange={(e) => setIncludeStale(e.target.checked)}
            />
            Include stale postings (&gt;20 days)
          </label>
        </div>

        <div className="text-zinc-400">
          Showing {data?.entries.length ?? 0} jobs
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : !data || data.entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No jobs found in this view.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Title / Company</th>
                <th className="px-3 py-2 font-medium">Bucket / Stage</th>
                <th className="px-3 py-2 font-medium">Location</th>
                <th className="px-3 py-2 font-medium">Posted</th>
                <th className="px-3 py-2 font-medium">H1B</th>
                <th className="px-3 py-2 font-medium">Match Fit</th>
                <th className="px-3 py-2 font-medium">Pipeline Status</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {data.entries.map(({ job, ranking }) => (
                <tr key={job.id} className={job.is_active ? "" : "opacity-50"}>
                  <td className="px-3 py-2">
                    <Link href={`/jobs/${job.id}`} className="font-medium hover:underline">
                      {job.title}
                    </Link>
                    <RoleFamilyBadge tier={ranking.roleFamilyTier} />
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {job.company_name} · {job.source_type}
                      {!job.is_active && " · closed"}
                    </div>
                  </td>

                  <td className="px-3 py-2">
                    <PrimaryBucketBadge bucket={ranking.primaryBucket} />
                  </td>

                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{job.location ?? "—"}</td>

                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                    <div>{formatDate(job.posted_at)}</div>
                    <FreshnessBadge tier={ranking.freshnessTier} />
                  </td>

                  <td className="px-3 py-2">
                    <H1bBadge confidence={job.h1b_combined_confidence} />
                  </td>

                  <td className="px-3 py-2">
                    <MatchFitCell ranking={ranking} />
                  </td>

                  <td className="px-3 py-2">
                    <PipelineStatusSelect jobId={job.id} value={job.pipeline_status} candidateId={candidateId} />
                  </td>

                  <td className="px-3 py-2 text-right">
                    <div className="flex flex-col items-end gap-1.5">
                      {ranking.primaryBucket === "READY_TO_APPLY" && (
                        <Link
                          href={`/jobs/${job.id}`}
                          className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
                        >
                          Inspect Resume →
                        </Link>
                      )}

                      {ranking.primaryBucket === "READY_FOR_TAILORING" && (
                        <Link
                          href={`/jobs/${job.id}`}
                          className="rounded bg-purple-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-purple-700 dark:bg-purple-500 dark:hover:bg-purple-600"
                        >
                          Tailor Resume →
                        </Link>
                      )}

                      <div className="flex items-center gap-2">
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
                          initialNotInterested={false}
                          onChanged={(notInterested) => notInterested && removeEntry(job.id)}
                        />
                      </div>
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
