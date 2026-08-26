"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  INPUT,
  LoadingRegion,
  PageHeader,
  Panel,
  PanelEmpty,
  Pill,
  SkeletonRows,
} from "@/components/ui";
import {
  IconArrowUpRight,
  IconDocument,
  IconInbox,
  IconSearch,
  IconShield,
  IconStar,
  IconTrend,
} from "@/components/icons";
import { sourceLabel } from "@/app/jobs/sourceLabel";
import { presentStatus } from "./runStatus";
import {
  APPLICATION_GROUPS,
  applicationContext,
  groupForStatus,
  primaryActionLabel,
  type ApplicationGroupId,
} from "./grouping";

interface RunRow {
  id: number;
  jobId: number;
  title: string;
  company: string | null;
  location: string | null;
  ats: string | null;
  status: string;
  prompt: string | null;
  question: string | null;
  resumeFile: string | null;
  submittedAt: string | null;
  updatedAt: string;
}

const EMPTY_COPY: Record<ApplicationGroupId | "all", string> = {
  all: "No applications yet",
  "needs-you": "Nothing needs you right now.",
  "in-progress": "No applications are in progress.",
  "ready-for-review": "Nothing is ready for review yet.",
  submitted: "No confirmed submissions yet.",
  "needs-attention": "Nothing needs attention.",
};

const SUMMARY_ICON: Record<ApplicationGroupId, ReactNode> = {
  "needs-you": <IconStar size={22} />,
  "in-progress": <IconTrend size={22} />,
  "ready-for-review": <IconDocument size={22} />,
  submitted: <IconInbox size={22} />,
  "needs-attention": <IconShield size={22} />,
};

function initials(name: string | null): string {
  if (!name) return "?";
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function statusTone(marker: string, needsUser: boolean): "success" | "warning" | "info" | "neutral" {
  if (marker === "done") return "success";
  if (marker === "unknown" || needsUser) return "warning";
  if (marker === "stopped") return "neutral";
  return "info";
}

export default function ApplicationsPage() {
  const candidateId = useResolvedCandidateId();
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<ApplicationGroupId | "all">("all");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (candidateId === null) return;
    setError(false);
    try {
      const response = await fetch(`/api/candidates/${candidateId}/application-runs?scope=all&limit=100`);
      if (!response.ok) return setError(true);
      const body = await response.json();
      setRuns(body.runs ?? []);
    } catch {
      setError(true);
    }
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const grouped = useMemo(() => {
    const next: Record<ApplicationGroupId, RunRow[]> = {
      "needs-you": [],
      "in-progress": [],
      "ready-for-review": [],
      submitted: [],
      "needs-attention": [],
    };
    for (const run of runs ?? []) next[groupForStatus(run.status)].push(run);
    for (const group of APPLICATION_GROUPS) {
      next[group.id].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return next;
  }, [runs]);

  const counts = useMemo(() => {
    const next: Record<ApplicationGroupId | "all", number> = {
      all: runs?.length ?? 0,
      "needs-you": 0,
      "in-progress": 0,
      "ready-for-review": 0,
      submitted: 0,
      "needs-attention": 0,
    };
    /* The fallback also keeps Fast Refresh safe when this presentation table and the grouping
     * module update in adjacent frames; production data still always has all five buckets. */
    for (const group of APPLICATION_GROUPS) next[group.id] = grouped[group.id]?.length ?? 0;
    return next;
  }, [grouped, runs]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const source = tab === "all" ? (runs ?? []) : grouped[tab];
    return source.filter((run) => !query || `${run.title} ${run.company ?? ""}`.toLowerCase().includes(query));
  }, [grouped, runs, search, tab]);

  if (error) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-6">
        <PageHeader size="lg" title="Applications" />
        <Panel><PanelEmpty action={<button type="button" onClick={load} className={`${BTN_SECONDARY} min-h-11`}>Retry</button>}>We couldn&apos;t load your applications.</PanelEmpty></Panel>
      </div>
    );
  }

  if (candidateId === null || runs === null) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-5">
        <PageHeader size="lg" title="Applications" description="Track applications and complete anything that needs your attention." />
        <LoadingRegion label="Loading applications" />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">{[0, 1, 2, 3].map((index) => <Panel key={index} compact><SkeletonRows rows={2} /></Panel>)}</div>
        <Panel><SkeletonRows rows={4} /></Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-6 pb-12">
      <PageHeader
        size="lg"
        title="Applications"
        description="Track applications and complete anything that needs your attention."
        actions={runs.length > 0 ? <Link href="/jobs" className={`${BTN_PRIMARY} min-h-11`}>Browse jobs</Link> : undefined}
      />

      <section aria-label="Application overview" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {APPLICATION_GROUPS.map((group) => (
          <SummaryTile
            key={group.id}
            icon={SUMMARY_ICON[group.id]}
            group={group.id}
            label={group.cardLabel}
            value={counts[group.id]}
            hint={group.cardHint}
            onClick={() => setTab(group.id)}
          />
        ))}
      </section>

      {runs.length === 0 ? (
        <section className="premium-gradient-surface flex min-h-[360px] flex-col items-center justify-center rounded-[18px] border border-[var(--border)] px-6 py-16 text-center shadow-[var(--lift-1)]">
          <span aria-hidden="true" className="mx-auto grid h-14 w-14 place-items-center rounded-[17px] bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]"><IconDocument size={25} /></span>
          <h2 className="mt-4 text-[19px] font-bold tracking-[-0.01em] text-primary">No applications yet</h2>
          <p className="mx-auto mt-2 max-w-[52ch] text-[15px] leading-6 text-secondary">When a resume is ready, you can start an application from the Job Workspace. Nothing is submitted without your approval.</p>
          <Link href="/jobs" className={`${BTN_PRIMARY} mt-5 min-h-11`}>Browse jobs</Link>
        </section>
      ) : (
        <section aria-labelledby="application-runs-title" className="overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--z3-bg)] shadow-[var(--lift-1)]">
          <div className="flex flex-col gap-5 border-b border-[var(--separator)] px-4 py-5 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-7">
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--accent)]">Application lifecycle</p>
              <h2 id="application-runs-title" className="mt-1 text-[22px] font-bold tracking-[-0.02em] text-primary">Your applications</h2>
              <p className="mt-1 text-[14px] leading-6 text-secondary">One place for every active run, required action, and confirmed submission.</p>
            </div>
            <label className="relative block w-full lg:w-[320px]">
              <span className="sr-only">Search applications by company or role</span>
              <span aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-tertiary"><IconSearch size={18} /></span>
              <input type="search" className={`${INPUT} min-h-11 pl-11 text-[14px]`} placeholder="Search role or company" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>

          <div className="border-b border-[var(--separator)] px-2 sm:px-4">
            <div role="tablist" aria-label="Application status" className="flex min-w-max gap-1 overflow-x-auto py-2">
              {[{ id: "all" as const, label: "All" }, ...APPLICATION_GROUPS.map((group) => ({ id: group.id, label: group.cardLabel }))].map((item) => (
                <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)} className={`premium-active-tab inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[11px] px-4 text-[14px] font-semibold transition-colors duration-150 ${tab === item.id ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "text-secondary hover:bg-[var(--surface-hover)] hover:text-primary"}`}>
                  {item.label}<span className={`tabular-nums ${tab === item.id ? "opacity-80" : "text-tertiary"}`}>{counts[item.id]}</span>
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="px-6 py-14 text-center"><h3 className="text-[17px] font-bold text-primary">{search.trim() ? `No application matches “${search.trim()}”.` : EMPTY_COPY[tab]}</h3><p className="mt-2 text-[14px] text-secondary">Application statuses update here as real runs progress.</p></div>
          ) : (
            <ul className="grid gap-3 bg-[var(--surface-muted)] p-3 sm:p-4 lg:p-5">
              {visible.map((run) => <ApplicationCard key={run.id} run={run} />)}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function SummaryTile({ icon, group, label, value, hint, onClick }: { icon: ReactNode; group: ApplicationGroupId; label: string; value: number; hint: string; onClick: () => void }) {
  const tone = {
    "needs-you": "bg-[var(--tile-amber-bg)] text-[var(--tile-amber-fg)]",
    "in-progress": "bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]",
    "ready-for-review": "bg-[var(--tile-amber-bg)] text-[var(--tile-amber-fg)]",
    submitted: "bg-[var(--tile-blue-bg)] text-[var(--tile-blue-fg)]",
    "needs-attention": "bg-[var(--tile-amber-bg)] text-[var(--tile-amber-fg)]",
  }[group];
  return (
    <article className="premium-hover-lift flex min-h-[166px] flex-col rounded-[16px] border border-[var(--border)] bg-[var(--z3-bg)] p-4 shadow-[var(--lift-1)] sm:rounded-[18px] sm:p-5">
      <span aria-hidden="true" className={`grid h-10 w-10 place-items-center rounded-[12px] sm:h-11 sm:w-11 ${tone}`}>{icon}</span>
      <h2 className="mt-3 text-[14px] font-semibold leading-5 text-secondary sm:text-[15px]">{label}</h2>
      <div className="mt-1 text-[25px] font-bold tracking-[-0.02em] text-primary">{value}</div>
      <p className="mt-1 text-[13px] leading-5 text-tertiary sm:text-[14px]">{hint}</p>
      <button type="button" onClick={onClick} className="mt-auto inline-flex min-h-11 w-fit items-center gap-1.5 pt-2 text-[14px] font-semibold text-[var(--accent)] transition-colors hover:text-[var(--accent-hover)]">View {label.toLowerCase()}<IconArrowUpRight size={14} /></button>
    </article>
  );
}

function ApplicationCard({ run }: { run: RunRow }) {
  const presentation = presentStatus(run.status);
  const ats = sourceLabel(run.ats);
  return (
    <li className={`premium-hover-lift rounded-[16px] border bg-[var(--z3-bg)] p-4 shadow-[var(--lift-1)] sm:p-5 lg:p-6 ${presentation.needsUser ? "border-[color-mix(in_srgb,var(--warning)_28%,var(--border))]" : "border-[var(--border)]"}`}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(210px,.8fr)_auto] lg:items-center lg:gap-6">
        <div className="flex min-w-0 items-start gap-3.5 sm:gap-4">
          <span aria-hidden="true" className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-[var(--tile-lav-bg)] text-[14px] font-bold text-[var(--tile-lav-fg)] sm:h-14 sm:w-14">{initials(run.company)}</span>
          <div className="min-w-0">
            <h3 className="text-[17px] font-bold leading-[1.35] tracking-[-0.01em] text-primary sm:text-[18px]">{run.title}</h3>
            <p className="mt-1 text-[14px] font-medium text-secondary">{run.company ?? "Company unknown"}{run.location ? ` · ${run.location}` : ""}</p>
            <p className="mt-1 text-[13px] leading-5 text-tertiary">Updated {formatDate(run.updatedAt)}{ats ? ` · ${ats}` : ""}</p>
          </div>
        </div>
        <div className="min-w-0">
          <Pill tone={statusTone(presentation.marker, presentation.needsUser)}>{presentation.label}</Pill>
          <p className="mt-2 text-[14px] leading-6 text-secondary">{applicationContext(run.status, run.prompt)}</p>
          {run.question && <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-tertiary">“{run.question}”</p>}
        </div>
        <Link href={`/applications/${run.id}`} className={`${presentation.needsUser ? BTN_PRIMARY : BTN_SECONDARY} min-h-11 w-full text-[14px] lg:w-auto`}>
          {primaryActionLabel(run.status)}<IconArrowUpRight size={15} />
        </Link>
      </div>
    </li>
  );
}
