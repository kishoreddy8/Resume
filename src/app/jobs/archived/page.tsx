"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import type { JobWithCompany } from "@/types";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function RestoreButton({ jobId, onRestored }: { jobId: number; onRestored: () => void }) {
  const [busy, setBusy] = useState(false);

  async function restore() {
    setBusy(true);
    try {
      await fetch(`/api/jobs/${jobId}/restore`, { method: "POST" });
      onRestored();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={restore}
      className="rounded border border-zinc-300 px-2 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      {busy ? "Restoring…" : "Restore"}
    </button>
  );
}

export default function ArchivedJobsPage() {
  const [jobs, setJobs] = useState<JobWithCompany[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/jobs?archived=true");
      const data = await res.json();
      setJobs(data.jobs ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Intentional: fetch-on-mount with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Archived jobs</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          Jobs auto-archive after going unseen across several consecutive scans of a live ATS board
          (never while marked Applied or Interview), or can be archived manually from a job&apos;s
          detail page. Archiving never deletes anything — notes, tags, pipeline stage, and any
          generated resume files are preserved and restored exactly as they were.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : jobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No archived jobs.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Title / Company</th>
                <th className="px-3 py-2 font-medium">H1B</th>
                <th className="px-3 py-2 font-medium">Pipeline stage</th>
                <th className="px-3 py-2 font-medium">Archived</th>
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td className="px-3 py-2">
                    <Link href={`/jobs/${job.id}`} className="font-medium hover:underline">
                      {job.title}
                    </Link>
                    <div className="text-xs text-zinc-500">
                      {job.company_name} · {job.source_type}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <H1bBadge confidence={job.h1b_combined_confidence} />
                  </td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{job.pipeline_status}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                    {formatDate(job.archived_at)}
                  </td>
                  <td className="px-3 py-2 max-w-xs text-xs text-zinc-500">
                    {job.archived_reason ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <RestoreButton jobId={job.id} onRestored={load} />
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
