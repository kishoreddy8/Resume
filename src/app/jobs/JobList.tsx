"use client";

import Link from "next/link";
import { useState } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import { PipelineStatusSelect } from "@/components/PipelineStatusSelect";
import { getJobAgeBand, getJobAgeDays } from "@/lib/jobLifecycle";
import type { JobWithCompany } from "@/types";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Fresh (0-3 days old) is the age-based lifecycle policy's "highlight as high priority" band —
 *  computed live from posted_at/first_seen_at, never persisted. See src/lib/jobLifecycle.ts. */
function FreshBadge({ job }: { job: JobWithCompany }) {
  const ageDays = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at });
  if (getJobAgeBand(ageDays) !== "fresh") return null;
  return (
    <span
      className="ml-1.5 inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
      title={`Posted ${ageDays} day${ageDays === 1 ? "" : "s"} ago — high priority`}
    >
      Fresh
    </span>
  );
}

function TailoringCheckbox({ jobId, initial }: { jobId: number; initial: boolean }) {
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
        body: JSON.stringify({ markedForTailoring: next }),
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

export function JobList({ jobs }: { jobs: JobWithCompany[] }) {
  if (jobs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
        No jobs match these filters. Add companies and run a scan, or widen your filters.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            <th className="px-3 py-2 font-medium">Title / Company</th>
            <th className="px-3 py-2 font-medium">Location</th>
            <th className="px-3 py-2 font-medium">Posted</th>
            <th className="px-3 py-2 font-medium">H1B</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium text-center">Tailor</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {jobs.map((job) => (
            <tr key={job.id} className={job.is_active ? "" : "opacity-50"}>
              <td className="px-3 py-2">
                <Link href={`/jobs/${job.id}`} className="font-medium hover:underline">
                  {job.title}
                </Link>
                <FreshBadge job={job} />
                <div className="text-xs text-zinc-500">
                  {job.company_name} · {job.source_type}
                  {!job.is_active && " · closed"}
                </div>
              </td>
              <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{job.location ?? "—"}</td>
              <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                {formatDate(job.posted_at)}
              </td>
              <td className="px-3 py-2">
                <H1bBadge confidence={job.h1b_combined_confidence} />
              </td>
              <td className="px-3 py-2">
                <PipelineStatusSelect jobId={job.id} value={job.pipeline_status} />
              </td>
              <td className="px-3 py-2 text-center">
                <TailoringCheckbox jobId={job.id} initial={job.marked_for_tailoring === 1} />
              </td>
              <td className="px-3 py-2 text-right">
                <a
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                >
                  View ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
