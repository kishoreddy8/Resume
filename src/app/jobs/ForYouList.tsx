"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FreshnessBadge } from "@/components/FreshnessBadge";
import { H1bBadge } from "@/components/H1bBadge";
import { MatchDecisionBadge, type MatchDecision } from "@/components/MatchDecisionBadge";
import { NotInterestedToggle } from "@/components/NotInterestedToggle";
import { PipelineStatusSelect } from "@/components/PipelineStatusSelect";
import type { RoleFamilyTier } from "@/lib/rank/forYou";
import type { CandidateRankingPreferences } from "@/db/queries/candidateSettings";
import type { JobWithCompany } from "@/types";
import type { ForYouResponseEntry } from "@/app/api/candidates/[candidateId]/for-you/route";

/**
 * Renders the ranked output of GET /api/candidates/[candidateId]/for-you — see
 * CAREER_OPS_PHASE_2_5_CHECKPOINT.md §6 stage 1. Ordering is entirely server-side (rankForYou); this
 * component never re-sorts, so the approved key order is never silently overridden by a client-side
 * sort.
 */

function RoleFamilyBadge({ tier }: { tier: RoleFamilyTier }) {
  if (tier === "NONE") return null;
  const label = tier === "PRIMARY" ? "Primary role match" : "Secondary role match";
  const style =
    tier === "PRIMARY"
      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
      : "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300";
  return <span className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style}`}>{label}</span>;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface ForYouApiResponse {
  candidateId: number;
  preferences: CandidateRankingPreferences;
  entries: ForYouResponseEntry[];
}

export function ForYouList({ candidateId }: { candidateId: number }) {
  const [data, setData] = useState<ForYouApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [includeStale, setIncludeStale] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/for-you?includeStale=${includeStale}`);
      const body = await res.json();
      setData(res.ok ? body : null);
    } finally {
      setLoading(false);
    }
  }, [candidateId, includeStale]);

  useEffect(() => {
    // Intentional: fetch-on-mount/candidate-or-toggle-change with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Marking a job Not Interested here always removes it from view immediately — For You excludes
  // not-interested jobs for this candidate, so it would be gone on the next fetch anyway (see
  // rankForYou's notInterested gate).
  function removeEntry(jobId: number) {
    setData((prev) => (prev ? { ...prev, entries: prev.entries.filter((e) => e.job.id !== jobId) } : prev));
  }

  if (loading || !data) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  const hasPreferences = Boolean(data.preferences.primaryTargetRole) || data.preferences.secondaryTargetRoles.length > 0;

  return (
    <div className="space-y-2">
      {!hasPreferences && (
        <div className="rounded-lg border border-dashed border-zinc-300 p-3 text-xs text-zinc-500 dark:border-zinc-700">
          No target role set yet — jobs are ranked by fit/freshness only.{" "}
          <Link href={`/candidates/${candidateId}/settings`} className="underline">
            Set your target roles
          </Link>{" "}
          to prioritize matching jobs first.
        </div>
      )}

      <div className="flex items-center gap-2 text-xs">
        <label className="flex items-center gap-1.5 text-zinc-500">
          <input type="checkbox" checked={includeStale} onChange={(e) => setIncludeStale(e.target.checked)} />
          Include stale postings (&gt;20 days old)
        </label>
      </div>

      {data.entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No jobs to show yet. Add companies and run a scan.
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
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {data.entries.map(({ job, ranking }: { job: JobWithCompany; ranking: ForYouResponseEntry["ranking"] }) => (
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
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{job.location ?? "—"}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                    <div>{formatDate(job.posted_at)}</div>
                    <FreshnessBadge tier={ranking.freshnessTier} />
                  </td>
                  <td className="px-3 py-2">
                    <H1bBadge confidence={job.h1b_combined_confidence} />
                  </td>
                  <td className="px-3 py-2">
                    {ranking.decision ? (
                      <MatchDecisionBadge decision={ranking.decision as MatchDecision} />
                    ) : (
                      <span className="text-xs text-zinc-400">Not evaluated</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <PipelineStatusSelect jobId={job.id} value={job.pipeline_status} candidateId={candidateId} />
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
                        initialNotInterested={false}
                        onChanged={(notInterested) => notInterested && removeEntry(job.id)}
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
