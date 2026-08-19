"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import { PipelineStatusSelect } from "@/components/PipelineStatusSelect";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import type { JobWithCompany, PipelineStatus } from "@/types";

const COLUMNS: PipelineStatus[] = [
  "New",
  "Interested",
  "Applied",
  "Interviewing",
  "Offer",
  "Employer Rejected",
];

export default function PipelinePage() {
  const candidateId = useActiveCandidateId();
  const [jobs, setJobs] = useState<JobWithCompany[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs?activeOnly=true&candidateId=${candidateId}`);
      const data = await res.json();
      setJobs(data.jobs ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Intentional: fetch-on-mount/candidate-change with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId]);

  if (loading) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="page-title">Pipeline</h1>
      <div className="grid grid-cols-1 gap-4 overflow-x-auto md:grid-cols-3 xl:grid-cols-6">
        {COLUMNS.map((status) => {
          const columnJobs = jobs.filter((j) => j.pipeline_status === status);
          return (
            <div key={status} className="flex min-w-[220px] flex-col gap-2">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {status}
                </h2>
                <span className="text-xs text-zinc-400">{columnJobs.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {columnJobs.map((job) => (
                  <div
                    key={job.id}
                    className="rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <Link href={`/jobs/${job.id}`} className="font-medium hover:underline">
                      {job.title}
                    </Link>
                    <div className="mt-0.5 text-xs text-zinc-500">{job.company_name}</div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <H1bBadge confidence={job.h1b_combined_confidence} />
                      <PipelineStatusSelect
                        jobId={job.id}
                        value={job.pipeline_status}
                        candidateId={candidateId}
                        onChanged={() => load()}
                      />
                    </div>
                  </div>
                ))}
                {columnJobs.length === 0 && (
                  <div className="rounded border border-dashed border-zinc-200 p-3 text-center text-xs text-zinc-400 dark:border-zinc-800">
                    Empty
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
