"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { LoadingRegion, PageHeader, SkeletonRows, Surface } from "@/components/ui";
import { MARKER_CLASS, MARKER_TEXT, presentStatus } from "./runStatus";

/**
 * The Application Command Center.
 *
 * SORTED BY WHAT NEEDS A PERSON, not by date. A run stopped on a CAPTCHA is the only thing on this
 * page with a pending action attached to it, and burying it under last week's submissions is how
 * an application sits unfinished for a week.
 *
 * EVERY STATE IS THE ENGINE'S OWN. Nothing here infers a status or merges two — see runStatus.ts.
 * A paused run is never described as failed: the system is working correctly and simply cannot
 * proceed without a person.
 *
 * BOUNDED. One row per job actually applied to, capped server-side, and no timeline or review is
 * loaded here — detail is a separate fetch on a separate page.
 */

interface RunRow {
  id: number;
  jobId: number;
  title: string;
  company: string | null;
  ats: string | null;
  status: string;
  prompt: string | null;
  question: string | null;
  resumeFile: string | null;
  submittedAt: string | null;
  updatedAt: string;
}

function RunCard({ run }: { run: RunRow }) {
  const p = presentStatus(run.status);
  return (
    <Surface level="z2" className="rounded-[var(--radius-lg)] px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <Link
          href={`/applications/${run.id}`}
          className="text-[13px] font-medium text-primary underline-offset-2 hover:underline"
        >
          {run.title}
        </Link>
        {run.company && <span className="text-[12px] text-tertiary">{run.company}</span>}
        {run.ats && <span className="text-[11px] text-tertiary">{run.ats}</span>}

        {/* Shape AND word — never colour alone. */}
        <span className="ml-auto flex items-center gap-1.5">
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${MARKER_CLASS[p.marker]}`} />
          <span className={`text-[11.5px] font-medium ${MARKER_TEXT[p.marker]}`}>{p.label}</span>
        </span>
      </div>

      {p.needsUser && run.prompt && <p className="mt-1 text-[12px] leading-relaxed text-secondary">{run.prompt}</p>}
      {run.question && <p className="mt-0.5 text-[11.5px] leading-relaxed text-tertiary">“{run.question}”</p>}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tertiary">
        {run.resumeFile ? <span>Resume attached</span> : <span>No resume attached</span>}
        <span className="tabular-nums">
          {run.submittedAt ? "Submitted " : "Updated "}
          {new Date(run.submittedAt ?? run.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </span>
        <Link
          href={`/applications/${run.id}`}
          className="ml-auto rounded px-1.5 py-0.5 text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
        >
          {p.needsUser ? "Continue" : "Open"}
        </Link>
      </div>
    </Surface>
  );
}

export default function ApplicationsPage() {
  const candidateId = useResolvedCandidateId();
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (candidateId === null) return;
    try {
      const res = await fetch(`/api/candidates/${candidateId}/application-runs?scope=all&limit=100`);
      if (!res.ok) return setError(true);
      const body = await res.json();
      setRuns(body.runs ?? []);
    } catch {
      setError(true);
    }
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (candidateId === null || (runs === null && !error)) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Applications" description="Every application Career-Ops has run for you." />
        <LoadingRegion label="Loading applications" />
        <Surface level="z3" className="rounded-[var(--radius-xl)] p-5">
          <SkeletonRows rows={4} />
        </Surface>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Applications" description="Every application Career-Ops has run for you." />
        <p className="text-[12.5px] text-tertiary">Applications could not be loaded.</p>
      </div>
    );
  }

  const all = runs ?? [];
  const needsYou = all.filter((r) => presentStatus(r.status).needsUser);
  const running = all.filter((r) => !presentStatus(r.status).needsUser && presentStatus(r.status).marker === "running");
  const finished = all.filter(
    (r) => !presentStatus(r.status).needsUser && presentStatus(r.status).marker !== "running"
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Applications"
        description="Every application Career-Ops has run for you. Nothing is submitted without your approval."
      />

      {all.length === 0 ? (
        <Surface level="z3" className="rounded-[var(--radius-xl)] px-6 py-12 text-center">
          <p className="text-[13px] font-medium text-primary">No applications yet</p>
          <p className="mx-auto mt-1 max-w-[52ch] text-[12px] leading-relaxed text-tertiary">
            Start one from a job that has a validated tailored resume. Career-Ops fills what it can
            evidence, stops for anything it cannot, and never submits without you approving it.
          </p>
          <Link
            href="/jobs"
            className="mt-4 inline-block rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
          >
            Open Jobs
          </Link>
        </Surface>
      ) : (
        <>
          {/* Anything waiting on a person comes first — it is the only part of this page with a
           *  pending action attached to it. */}
          {needsYou.length > 0 && (
            <section className="space-y-2">
              <h2 className="section-title">Needs you ({needsYou.length})</h2>
              <div className="flex flex-col gap-2">
                {needsYou.map((r) => (
                  <RunCard key={r.id} run={r} />
                ))}
              </div>
            </section>
          )}

          {running.length > 0 && (
            <section className="space-y-2">
              <h2 className="section-title">In progress</h2>
              <div className="flex flex-col gap-2">
                {running.map((r) => (
                  <RunCard key={r.id} run={r} />
                ))}
              </div>
            </section>
          )}

          {finished.length > 0 && (
            <section className="space-y-2">
              <h2 className="section-title">History</h2>
              <div className="flex flex-col gap-2">
                {finished.map((r) => (
                  <RunCard key={r.id} run={r} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
