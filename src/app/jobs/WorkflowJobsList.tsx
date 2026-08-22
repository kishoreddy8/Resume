"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { EmptyState } from "./EmptyState";
import { JobListSkeleton, LoadingRegion } from "./Skeletons";
import { jobWorkspaceUrl } from "./[id]/workspaceRoute";
import type { ResumeLibraryEntry } from "@/app/api/candidates/[candidateId]/resume-library/route";

type WorkflowView = "tailoring" | "needsReview";

const ACTIVE_WORKFLOW_STATUSES = new Set([
  "CREATED",
  "WRITER_RUNNING",
  "WRITER_COMPLETED",
  "REVIEW_RUNNING",
  "REVIEW_COMPLETED",
  "IMPROVEMENT_RUNNING",
]);

function initials(company: string | null): string {
  const words = (company ?? "Job").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0]?.slice(0, 2) ?? "JB").toUpperCase();
}

function friendlyStatus(entry: ResumeLibraryEntry): string {
  if (entry.isLegacyMissingAnalysis && entry.canRevalidate) return "Validation update available";
  if (entry.workflowStatus === "FAILED") return "Needs your review";
  if (entry.workflowStatus === "READY") return entry.humanMaySend ? "Ready to use" : "Human review required";
  if (entry.workflowStatus.includes("REVIEW")) return "Reviewing quality";
  if (entry.workflowStatus.includes("WRITER")) return "Drafting your resume";
  if (entry.workflowStatus === "IMPROVEMENT_RUNNING") return "Improving draft";
  return "Preparing workspace";
}

function workflowAction(entry: ResumeLibraryEntry): { label: string; href: string } {
  if (entry.jobId === null) return { label: "Open resumes", href: "/resume" };
  if (entry.isLegacyMissingAnalysis && entry.canRevalidate) {
    return { label: "Re-run validation", href: jobWorkspaceUrl(entry.jobId, { step: "validation", focus: "revalidate" }) };
  }
  if (entry.workflowStatus === "FAILED" || entry.readiness === "BLOCKED" || entry.humanMaySend === false) {
    return { label: "Review issues", href: jobWorkspaceUrl(entry.jobId, { step: "validation", focus: "issues" }) };
  }
  if (entry.workflowStatus === "READY") {
    return { label: "Open resume", href: jobWorkspaceUrl(entry.jobId, { step: "results", focus: "progress" }) };
  }
  return { label: "View progress", href: jobWorkspaceUrl(entry.jobId, { step: "results", focus: "progress" }) };
}

function relativeUpdated(value: string | null): string {
  if (!value) return "Recently updated";
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated yesterday";
  return `Updated ${days} days ago`;
}

export function WorkflowJobsList({ candidateId, view }: { candidateId: number; view: WorkflowView }) {
  const [entries, setEntries] = useState<ResumeLibraryEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/candidates/${candidateId}/resume-library`)
      .then((response) => response.json().then((body) => (response.ok ? body.entries ?? [] : [])))
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  const visible = useMemo(() => {
    if (!entries) return [];
    return entries.filter((entry) => {
      if (view === "tailoring") return ACTIVE_WORKFLOW_STATUSES.has(entry.workflowStatus);
      return (
        entry.workflowStatus === "FAILED" ||
        entry.readiness === "BLOCKED" ||
        entry.humanMaySend === false ||
        (entry.isLegacyMissingAnalysis && entry.canRevalidate)
      );
    });
  }, [entries, view]);

  const title = view === "tailoring" ? "Tailoring in progress" : "Resume decisions waiting for you";
  const description =
    view === "tailoring"
      ? "Track active resume work without opening every job."
      : "Only authoritative blocked, legacy-validation, and human-review states appear here.";

  return (
    <section className="rounded-[22px] border border-[var(--border)] bg-[color-mix(in_oklab,var(--surface)_88%,transparent)] p-3 shadow-[var(--lift-1)] md:p-5">
      <div className="mb-5 flex items-start justify-between gap-4 border-b border-[var(--separator)] pb-4">
        <div>
          <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-primary">{title}</h2>
          <p className="mt-1 text-[13.5px] text-secondary">{description}</p>
        </div>
        {entries !== null ? <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1.5 text-[13px] font-semibold text-[var(--accent)]">{visible.length}</span> : null}
      </div>

      {entries === null ? (
        <><LoadingRegion label="Loading resume workflows" /><JobListSkeleton /></>
      ) : visible.length === 0 ? (
        <EmptyState
          title={view === "tailoring" ? "No active tailoring right now" : "Nothing needs your review"}
          body={view === "tailoring" ? "Start from a strong match when you are ready. Active resume work will appear here." : "Blocked and human-review resume states will appear here with their safest next action."}
          action={<Link href="/jobs" className="rounded-[10px] bg-[var(--accent)] px-4 py-2 text-[13.5px] font-semibold text-[var(--accent-fg)]">Explore jobs</Link>}
        />
      ) : (
        <div className="space-y-3">
          {visible.map((entry) => {
            const action = workflowAction(entry);
            return (
              <article key={entry.workflowId} className="rounded-[18px] border border-[var(--border)] bg-surface p-4 shadow-[var(--lift-1)] md:p-5">
                <div className="flex flex-col items-stretch gap-3.5 sm:flex-row sm:items-start md:gap-4">
                  <div aria-hidden="true" className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-[linear-gradient(145deg,var(--accent-soft),var(--z0-bg))] text-[14px] font-bold text-[var(--accent)] md:h-14 md:w-14">
                    {initials(entry.company)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[17px] font-semibold tracking-[-0.015em] text-primary md:text-[18px]">{entry.title ?? "Tailored resume"}</h3>
                    <p className="mt-1 text-[13.5px] text-secondary">{entry.company ?? "Company unavailable"}{entry.location ? ` · ${entry.location}` : ""}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
                      <span className={`rounded-full px-2.5 py-1 font-semibold ${view === "needsReview" ? "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]" : "bg-[var(--accent-soft)] text-[var(--accent)]"}`}>{friendlyStatus(entry)}</span>
                      <span className="rounded-full bg-[var(--z0-bg)] px-2.5 py-1 text-secondary">Iteration {Math.max(entry.iteration, 1)}</span>
                      <span className="text-tertiary">{relativeUpdated(entry.updatedAt)}</span>
                    </div>
                    {entry.blockingReason && view === "needsReview" ? <p className="mt-3 line-clamp-2 text-[13px] leading-relaxed text-secondary">{entry.blockingReason}</p> : null}
                  </div>
                  <Link href={action.href} className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-[11px] bg-[var(--accent)] px-4 text-[13.5px] font-semibold text-[var(--accent-fg)] shadow-[var(--lift-1)] transition-transform duration-150 hover:-translate-y-px">
                    {action.label}
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
