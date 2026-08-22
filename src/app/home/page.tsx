"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import type { ResumeLibraryEntry } from "@/app/api/candidates/[candidateId]/resume-library/route";
import type { ForYouApiResponse, ForYouResponseEntry } from "@/app/api/candidates/[candidateId]/for-you/route";
import { sourceLabel } from "@/app/jobs/sourceLabel";
import { SaveJobButton } from "@/app/jobs/SaveJobButton";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { LoadingRegion, SkeletonRows } from "@/components/ui";
import {
  IconArrowUpRight,
  IconCheckCircle,
  IconChevronRight,
  IconDocument,
  IconInbox,
  IconSearch,
  IconTrend,
} from "@/components/icons";
import {
  boundedRecommendations,
  chooseHomeAction,
  homeAttention,
  homeCounts,
  presentHomeResumes,
  type HomePresentationInput,
  type WaitingApplication,
} from "./homePresentation";

interface HomeSummary {
  firstName: string | null;
  jobs: { newOpportunities: number; newOpportunitiesRecent: number };
  applications: {
    waitingOnYou: number;
    waiting: WaitingApplication[];
    first: { id: number; status: string; question: string | null } | null;
  };
  profile: { status: string };
  activity: { at: string; type: string; text: string }[];
}

const CARD = "rounded-[18px] border border-[var(--border)] bg-[var(--z3-bg)] shadow-[var(--shadow-card)]";
const STATUS_TONE: Record<string, string> = {
  ready: "bg-[var(--pill-success-bg)] text-[var(--pill-success-fg)]",
  tailoring: "bg-[var(--pill-blue-bg)] text-[var(--pill-blue-fg)]",
  attention: "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]",
};

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function initials(name: string | null): string {
  const parts = (name ?? "?").trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : parts[0]?.slice(0, 2) ?? "?").toUpperCase();
}

function freshness(job: ForYouResponseEntry["job"]): string | null {
  const date = job.posted_at ?? job.first_seen_at;
  const time = new Date(date).getTime();
  if (!Number.isFinite(time)) return null;
  const days = Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
  const verb = job.posted_at ? "Posted" : "Seen";
  return days === 0 ? `${verb} today` : days === 1 ? `${verb} yesterday` : `${verb} ${days} days ago`;
}

function presentActivityAge(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "Recently";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function SectionHeading({ title, href, linkLabel }: { title: string; href?: string; linkLabel?: string }) {
  return (
    <div className="mb-3 flex min-h-11 items-center justify-between gap-4">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.065em] text-secondary">{title}</h2>
      {href && linkLabel ? (
        <Link href={href} className="flex min-h-11 items-center gap-1 text-[14px] font-semibold text-[var(--accent)] hover:text-[var(--accent-hover)]">
          {linkLabel}<IconChevronRight size={15} />
        </Link>
      ) : null}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[92px] items-center gap-3 rounded-[14px] border border-dashed border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--tile-green-bg)] text-[var(--tile-green-fg)]"><IconCheckCircle size={19} /></span>
      <p className="text-[14px] leading-relaxed text-secondary">{children}</p>
    </div>
  );
}

export default function HomePage() {
  const candidateId = useResolvedCandidateId();
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [resumes, setResumes] = useState<ResumeLibraryEntry[]>([]);
  const [recommendations, setRecommendations] = useState<ForYouResponseEntry[]>([]);
  const [failed, setFailed] = useState(false);
  const reduced = useReducedMotion() ?? false;

  const load = useCallback(async () => {
    if (candidateId === null) return;
    try {
      const [homeResponse, resumeResponse, jobsResponse] = await Promise.all([
        fetch(`/api/candidates/${candidateId}/home`),
        fetch(`/api/candidates/${candidateId}/resume-library`),
        fetch(`/api/candidates/${candidateId}/for-you?limit=5&roleFamily=PRIMARY,SECONDARY`),
      ]);
      if (!homeResponse.ok || !resumeResponse.ok || !jobsResponse.ok) throw new Error("Home data unavailable");
      const [home, library, forYou] = await Promise.all([
        homeResponse.json() as Promise<HomeSummary>,
        resumeResponse.json() as Promise<{ entries: ResumeLibraryEntry[] }>,
        jobsResponse.json() as Promise<ForYouApiResponse>,
      ]);
      setSummary(home);
      setResumes(library.entries);
      setRecommendations(forYou.entries);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const view = useMemo<HomePresentationInput | null>(() => {
    if (!summary) return null;
    const first = summary.applications.first;
    const waiting = summary.applications.waiting.map((run) => ({
      ...run,
      question: run.id === first?.id ? first.question : null,
    }));
    return { profileStatus: summary.profile.status, applications: waiting, resumes, recommendations };
  }, [recommendations, resumes, summary]);

  if (candidateId === null || (!summary && !failed)) {
    return <div className="mx-auto w-full max-w-[var(--home-max-w)] pt-2"><LoadingRegion label="Loading your job search" /><div className={`${CARD} mt-6 p-6`}><SkeletonRows rows={5} /></div></div>;
  }
  if (!summary || !view) {
    return <div className="mx-auto w-full max-w-[var(--home-max-w)] pt-2"><h1 className="text-[28px] font-bold text-primary">JobHunt</h1><p className="mt-2 text-[14px] text-secondary">Your dashboard could not be loaded right now.</p><button type="button" onClick={() => void load()} className="mt-5 min-h-11 rounded-[10px] bg-[var(--accent)] px-5 text-[14px] font-semibold text-[var(--accent-fg)]">Try again</button></div>;
  }

  const action = chooseHomeAction(view);
  const counts = homeCounts(view);
  const attention = homeAttention(view);
  const resumeRows = presentHomeResumes(resumes);
  const tailoring = resumeRows.filter((row) => row.presentation.bucket === "tailoring").slice(0, 3);
  const ready = resumeRows.filter((row) => row.presentation.bucket === "ready").slice(0, 3);
  const jobs = boundedRecommendations(recommendations);
  const tiles = [
    { label: "New matches", value: summary.jobs.newOpportunities, detail: summary.jobs.newOpportunitiesRecent ? `${summary.jobs.newOpportunitiesRecent} found in the last 10 days` : "No recent matches", href: "/jobs", icon: <IconSearch size={20} />, tone: "bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]" },
    { label: "Tailoring in progress", value: counts.tailoring, detail: counts.tailoring ? "Resume work underway" : "Nothing running now", href: "/resume", icon: <IconDocument size={20} />, tone: "bg-[var(--tile-blue-bg)] text-[var(--tile-blue-fg)]" },
    { label: "Needs attention", value: counts.needsAttention, detail: counts.needsAttention ? "Candidate action required" : "You're all caught up", href: counts.needsAttention ? action.href : "/applications", icon: <IconInbox size={20} />, tone: "bg-[var(--tile-amber-bg)] text-[var(--tile-amber-fg)]" },
    { label: "Ready to use", value: counts.ready, detail: counts.ready ? "Approved resume packages" : "No approved resumes yet", href: "/resume", icon: <IconCheckCircle size={20} />, tone: "bg-[var(--tile-green-bg)] text-[var(--tile-green-fg)]" },
  ];
  const rise = (delay: number) => ({ initial: reduced ? { opacity: 0 } : { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: reduced ? 0 : 0.28, delay: reduced ? 0 : delay } });

  return (
    <div className="mx-auto w-full max-w-[var(--home-max-w)] pb-10 pt-1">
      <motion.header {...rise(0)} className="relative overflow-hidden rounded-[20px] bg-[linear-gradient(125deg,color-mix(in_oklab,var(--accent)_8%,transparent),transparent_62%)] px-1 py-5 sm:px-6 sm:py-7">
        <div aria-hidden="true" className="absolute -right-10 -top-16 h-52 w-52 rounded-full bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] blur-3xl" />
        <h1 className="relative text-[30px] font-bold leading-tight tracking-[-0.03em] text-primary sm:text-[36px]">{greeting()}{summary.firstName ? `, ${summary.firstName}` : ""}! <span aria-hidden="true">👋</span></h1>
        <p className="relative mt-2 text-[15px] leading-relaxed text-secondary">One clear next step, backed by the latest state of your search.</p>
      </motion.header>

      <motion.section {...rise(0.03)} aria-labelledby="next-action" className={`${CARD} mt-5 overflow-hidden shadow-[var(--shadow-hero)]`}>
        <div className="h-1 bg-[linear-gradient(90deg,var(--accent),color-mix(in_oklab,var(--accent)_18%,transparent))]" />
        <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-center">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold uppercase tracking-[0.075em] text-[var(--accent)]">{action.eyebrow}</p>
            <h2 id="next-action" className="mt-3 text-[22px] font-bold leading-tight tracking-[-0.02em] text-primary sm:text-[25px]">{action.title}</h2>
            <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-secondary">{action.detail}</p>
          </div>
          <div className="flex flex-col gap-2.5">
            <Link href={action.href} className="flex min-h-12 items-center justify-center gap-2 rounded-[11px] bg-[var(--accent)] px-5 text-center text-[15px] font-semibold text-[var(--accent-fg)] transition hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2">{action.cta}<IconArrowUpRight size={17} /></Link>
            {action.secondaryHref ? <Link href={action.secondaryHref} className="flex min-h-11 items-center justify-center rounded-[10px] border border-[var(--border-control)] px-4 text-[14px] font-medium text-primary hover:bg-[var(--surface-hover)]">View all</Link> : null}
          </div>
        </div>
      </motion.section>

      <section aria-label="Your job search overview" className="mt-7">
        <SectionHeading title="Your job search overview" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((tile) => <Link key={tile.label} href={tile.href} className={`${CARD} min-h-[150px] p-4 transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 sm:p-5`}><span className={`grid h-10 w-10 place-items-center rounded-xl ${tile.tone}`}>{tile.icon}</span><strong className="mt-4 block text-[28px] font-bold tabular-nums tracking-[-0.03em] text-primary">{tile.value}</strong><span className="mt-1 block text-[14px] font-semibold leading-snug text-primary">{tile.label}</span><span className="mt-1 block text-[13px] leading-snug text-tertiary">{tile.detail}</span></Link>)}
        </div>
      </section>

      <div className="mt-8 grid gap-7 xl:grid-cols-[minmax(0,1fr)_360px]">
        <main className="min-w-0 space-y-8">
          <section aria-label="Recommended for you"><SectionHeading title="Recommended for you" href="/jobs" linkLabel="View all jobs" />
            {jobs.length === 0 ? <EmptyState>No evaluated matches yet. New recommendations will appear after jobs are scanned.</EmptyState> : <ul className="space-y-3">{jobs.map(({ job, ranking }) => <li key={job.id} className={`${CARD} flex min-h-[116px] items-center gap-3 p-4 sm:gap-4 sm:p-5`}><span aria-hidden="true" className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[var(--tile-lav-bg)] text-[14px] font-bold text-[var(--tile-lav-fg)]">{initials(job.company_name)}</span><div className="min-w-0 flex-1"><Link href={`/jobs/${job.id}`} className="line-clamp-2 text-[17px] font-bold leading-snug text-primary hover:underline">{job.title}</Link><p className="mt-1 flex flex-wrap gap-x-2 text-[13px] text-secondary"><span className="font-medium">{job.company_name}</span>{job.location ? <span>· {job.location}</span> : null}{freshness(job) ? <span>· {freshness(job)}</span> : null}</p><div className="mt-2 flex flex-wrap items-center gap-2">{ranking.overallScore !== null && !ranking.insufficientJdSignal ? <span className="rounded-full bg-[var(--pill-success-bg)] px-2.5 py-1 text-[13px] font-semibold text-[var(--pill-success-fg)]">Match {Math.round(ranking.overallScore)}</span> : <span className="rounded-full bg-[var(--chip-bg)] px-2.5 py-1 text-[13px] text-[var(--chip-text)]">Match data pending</span>}{sourceLabel(job.source_type) ? <span className="text-[13px] text-tertiary">{sourceLabel(job.source_type)}</span> : null}</div></div><SaveJobButton jobId={job.id} jobTitle={job.title} candidateId={candidateId} initialSaved={job.pinned === 1} /><Link href={`/jobs/${job.id}`} aria-label={`View ${job.title}`} className="hidden min-h-11 items-center rounded-[10px] border border-[var(--border-control)] px-4 text-[14px] font-semibold text-primary hover:bg-[var(--surface-hover)] sm:flex">View job</Link></li>)}</ul>}
          </section>

          {tailoring.length > 0 ? <section aria-label="Tailoring in progress"><SectionHeading title="Tailoring in progress" href="/resume" linkLabel="Resume Studio" /><ul className="grid gap-3 md:grid-cols-2">{tailoring.map((row) => <li key={row.entry.workflowId}><Link href={row.href ?? "/resume"} className={`${CARD} flex min-h-[116px] items-center gap-4 p-5`}><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--tile-blue-bg)] text-[var(--tile-blue-fg)]"><IconTrend size={20} /></span><span className="min-w-0"><strong className="line-clamp-2 text-[16px] font-semibold text-primary">{row.entry.title ?? "Tailored resume"}</strong><span className="mt-1 block text-[13px] text-secondary">{row.entry.company ?? "Company unavailable"}</span><span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-[13px] font-medium ${STATUS_TONE.tailoring}`}>{row.presentation.status.label}</span></span></Link></li>)}</ul></section> : null}

          {ready.length > 0 ? <section aria-label="Ready to use"><SectionHeading title="Ready to use" href="/resume" linkLabel="View resumes" /><ul className="grid gap-3 md:grid-cols-2">{ready.map((row) => <li key={row.entry.workflowId}><Link href={row.href ?? "/resume"} className={`${CARD} flex min-h-[116px] items-center gap-4 p-5`}><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--tile-green-bg)] text-[var(--tile-green-fg)]"><IconCheckCircle size={20} /></span><span className="min-w-0"><strong className="line-clamp-2 text-[16px] font-semibold text-primary">{row.entry.title ?? "Tailored resume"}</strong><span className="mt-1 block text-[13px] text-secondary">{row.entry.company ?? "Company unavailable"}</span><span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-[13px] font-medium ${STATUS_TONE.ready}`}>Ready to use</span></span></Link></li>)}</ul></section> : null}
        </main>

        <aside className="min-w-0 space-y-4">
          <section aria-label="Needs attention" className={`${CARD} p-5`}><SectionHeading title="Needs attention" href="/applications" linkLabel="View all" />{attention.length === 0 ? <EmptyState>Nothing needs your attention right now.</EmptyState> : <ul className="divide-y divide-[var(--separator)]">{attention.map((item) => <li key={item.key}><Link href={item.href} className="-mx-2 flex min-h-[76px] items-center gap-3 rounded-xl px-2 py-3 hover:bg-[var(--surface-hover)]"><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${item.tone === "danger" ? "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]" : "bg-[var(--tile-amber-bg)] text-[var(--tile-amber-fg)]"}`}><IconInbox size={17} /></span><span className="min-w-0 flex-1"><strong className="line-clamp-2 block text-[14px] font-semibold leading-snug text-primary">{item.title}</strong><span className="mt-1 line-clamp-2 block text-[13px] leading-snug text-tertiary">{item.detail}</span><span className="mt-1.5 inline-flex rounded-full bg-[var(--pill-amber-bg)] px-2 py-0.5 text-[13px] font-medium text-[var(--pill-amber-fg)]">{item.label}</span></span><IconChevronRight size={16} /></Link></li>)}</ul>}</section>

          <section aria-label="Recent activity" className={`${CARD} p-5`}><SectionHeading title="Recent activity" />{summary.activity.length === 0 ? <EmptyState>Activity appears as you review jobs, tailor resumes and track applications.</EmptyState> : <ol className="space-y-1">{summary.activity.slice(0, 6).map((event) => <li key={`${event.at}-${event.text}`} className="flex gap-3 py-3"><span aria-hidden="true" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--accent)]" /><span className="min-w-0"><span className="line-clamp-2 block text-[14px] font-medium leading-snug text-primary">{event.text}</span><span className="mt-1 block text-[13px] text-tertiary">{presentActivityAge(event.at)}</span></span></li>)}</ol>}</section>
        </aside>
      </div>
    </div>
  );
}
