"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import type { ResumeLibraryEntry } from "@/app/api/candidates/[candidateId]/resume-library/route";
import type { ForYouApiResponse, ForYouResponseEntry } from "@/app/api/candidates/[candidateId]/for-you/route";
import { sourceLabel } from "@/app/jobs/sourceLabel";
import { SaveJobButton } from "@/app/jobs/SaveJobButton";
import { SponsorshipRow, formatSalary } from "@/app/jobs/JobCardPresentation";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { LoadingRegion, SkeletonRows, EmptyState as SharedEmptyState, ErrorState } from "@/components/ui";
import {
  IconArrowUpRight,
  IconCheckCircle,
  IconChevronRight,
} from "@/components/icons";
import {
  attentionOverflowCount,
  boundedRecommendations,
  chooseHomeAction,
  homeAttention,
  presentHomeResumes,
  type HomeAction,
  type HomePresentationInput,
  type WaitingApplication,
} from "./homePresentation";

/**
 * UI-H — Spatial Premium Home. Answers, in order: does anything need me; what is ready for me; what
 * good jobs should I look at; what has Career-Ops been doing; where should I go next. One dominant
 * next-action card, never a KPI dashboard — see homePresentation.ts for the state logic this page
 * only renders.
 */

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
/** Kinds where the dominant card is reporting something blocking the candidate, not merely
 *  suggesting a next step — drives the card's tone (amber vs. calm accent) per UI-H Part 10. */
const URGENT_KINDS = new Set<HomeAction["kind"]>(["application", "profile", "issues", "revalidate", "retry"]);

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
    return (
      <div className="mx-auto w-full max-w-[var(--home-max-w)] pt-2">
        <ErrorState
          title="Your home screen couldn't load"
          whatHappened="Career-Ops couldn't reach your job search summary just now."
          whatIsSafe="Nothing about your jobs, applications or resumes was changed."
          onRetry={() => void load()}
        />
      </div>
    );
  }

  const action = chooseHomeAction(view);
  const urgent = URGENT_KINDS.has(action.kind);
  const attention = homeAttention(view);
  const overflow = attentionOverflowCount(action, attention);
  const resumeRows = presentHomeResumes(resumes);
  const ready = resumeRows.filter((row) => row.presentation.bucket === "ready").slice(0, 3);
  const jobs = boundedRecommendations(recommendations);
  const readyForYouEmpty = ready.length === 0;
  const allEmpty = readyForYouEmpty && jobs.length === 0 && summary.activity.length === 0;
  const rise = (delay: number) => ({ initial: reduced ? { opacity: 0 } : { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: reduced ? 0 : 0.28, delay: reduced ? 0 : delay } });

  return (
    <div className="mx-auto w-full max-w-[var(--home-max-w)] pb-10 pt-1">
      <motion.header {...rise(0)} className="relative overflow-hidden rounded-[20px] bg-[linear-gradient(125deg,color-mix(in_oklab,var(--accent)_8%,transparent),transparent_62%)] px-1 py-4 sm:px-6 sm:py-6">
        <div aria-hidden="true" className="absolute -right-10 -top-16 h-52 w-52 rounded-full bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] blur-3xl" />
        <h1 className="relative text-[26px] font-bold leading-tight tracking-[-0.03em] text-primary sm:text-[32px]">{greeting()}{summary.firstName ? `, ${summary.firstName}` : ""}!</h1>
        <p className="relative mt-1.5 text-[14px] leading-relaxed text-secondary">One clear next step, backed by the latest state of your search.</p>
      </motion.header>

      <motion.section {...rise(0.03)} aria-labelledby="next-action" className={`${CARD} mt-5 overflow-hidden ${urgent ? "shadow-[var(--shadow-hero)]" : "shadow-[var(--shadow-card)]"}`}>
        <div className={`h-1 ${urgent ? "bg-[linear-gradient(90deg,var(--warning),color-mix(in_oklab,var(--warning)_18%,transparent))]" : "bg-[linear-gradient(90deg,var(--accent),color-mix(in_oklab,var(--accent)_18%,transparent))]"}`} />
        <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-center">
          <div className="min-w-0">
            {/* UI-H.1: the calm line only appears for "browse" — the one kind with no positive claim
             *  of its own to make. "ready"/"match"/"progress" already read as good news on their own
             *  eyebrow ("Ready to use", "Strongest match", "Tailoring in progress"); stacking "nothing
             *  needs your attention" in front of a card that then hands you an "Open resume" button
             *  reads as a contradiction — NEEDS ATTENTION (blocking) and READY FOR YOU (optional, good
             *  news) are different claims, and only the truly empty state needs the reassurance. */}
            {action.kind === "browse" && <p className="text-[13px] font-medium text-tertiary">Nothing needs your attention right now.</p>}
            <p className={`text-[13px] font-semibold uppercase tracking-[0.075em] ${urgent ? "text-[var(--pill-amber-fg)]" : "text-[var(--accent)]"}`}>{action.eyebrow}</p>
            <h2 id="next-action" className="mt-3 text-[22px] font-bold leading-tight tracking-[-0.02em] text-primary sm:text-[25px]">{action.title}</h2>
            <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-secondary">{action.detail}</p>
            {overflow > 0 && <p className="mt-3 text-[13px] font-semibold text-[var(--pill-amber-fg)]">+{overflow} more {overflow === 1 ? "item needs" : "items need"} you</p>}
          </div>
          <div className="flex flex-col gap-2.5">
            <Link href={action.href} className="flex min-h-12 items-center justify-center gap-2 rounded-[11px] bg-[var(--accent)] px-5 text-center text-[15px] font-semibold text-[var(--accent-fg)] transition hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2">{action.cta}<IconArrowUpRight size={17} /></Link>
            {action.secondaryHref ? <Link href={action.secondaryHref} className="flex min-h-11 items-center justify-center rounded-[10px] border border-[var(--border-control)] px-4 text-[14px] font-medium text-primary hover:bg-[var(--surface-hover)]">View all</Link> : null}
          </div>
        </div>
      </motion.section>

      {!allEmpty && (
        <div className="mt-8 flex flex-col gap-7 xl:flex-row xl:items-start">
          {/* UI-H.1: this wrapper is a real box only from xl up (grouping Ready-for-you + Recent
           *  activity into one independent-height column beside the Jobs rail) and `contents` below
           *  that — its children become direct flex items of the outer container, so mobile order
           *  (Ready, Jobs, Activity) comes from plain `order-*` with no row-sharing between columns.
           *  A CSS Grid row-span for the rail was tried first and rejected: spanning two row tracks
           *  forces those tracks to grow to fit the taller rail, which stretched an empty gap into
           *  the shorter main column between Ready-for-you and Recent activity — visible at 1280px
           *  with a short Ready-for-you and a 3-card rail. Flexbox with independent column heights
           *  has no such shared-track distortion. */}
          <div className="contents xl:flex xl:min-w-0 xl:flex-1 xl:flex-col xl:gap-7">
          <section aria-label="Ready for you" className="order-1">
            <SectionHeading title="Ready for you" />
            {/* UI-H.1: saved-answer-memory was reconsidered here and removed — it is a passive,
             *  always-available resource (nothing to "act on," no pending task tied to it), not a
             *  completed work product like a ready resume. Keeping it out of this list keeps "Ready
             *  for you" honestly scoped to things the candidate can act on right now. Answer Memory
             *  itself is untouched and still reachable from Settings navigation. */}
            {readyForYouEmpty ? (
              <div className={`${CARD} p-2`}>
                <SharedEmptyState title="Nothing ready yet" description="Approved resumes will appear here as your applications progress." icon={<IconCheckCircle size={20} />} />
              </div>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {ready.map((row) => (
                  <li key={row.entry.workflowId}>
                    <Link href={row.href ?? "/resume"} className={`${CARD} flex min-h-[116px] items-center gap-4 p-5 transition hover:-translate-y-0.5 hover:shadow-[var(--lift-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2`}>
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--tile-green-bg)] text-[var(--tile-green-fg)]"><IconCheckCircle size={20} /></span>
                      <span className="min-w-0">
                        <strong className="line-clamp-2 text-[16px] font-semibold text-primary">{row.entry.title ?? "Tailored resume"}</strong>
                        <span className="mt-1 block text-[13px] text-secondary">{row.entry.company ?? "Company unavailable"}</span>
                        <span className="mt-2 inline-flex rounded-full bg-[var(--pill-success-bg)] px-2.5 py-1 text-[13px] font-medium text-[var(--pill-success-fg)]">Ready to use</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Recent activity" className="order-3">
            {/* UI-H.1: named "Recent activity", not "Recent progress" — the underlying notifications
             *  mix genuine progress (RESUME_READY) with alerts (HUMAN_REVIEW_REQUIRED, QUALITY_FAILURE,
             *  application_needs_attention) and an outcome type that can itself be bad news
             *  (application_outcome covers rejections, not only submissions) — see
             *  src/lib/notifications/presentation.ts. Calling all of that "progress" would be false for
             *  roughly half of it; "activity" is the honest, neutral word for a mixed event feed. */}
            <SectionHeading title="Recent activity" href={summary.activity.length > 0 ? "/activity" : undefined} linkLabel={summary.activity.length > 0 ? "View activity" : undefined} />
            <div className={`${CARD} p-5`}>
              {summary.activity.length === 0 ? (
                <SharedEmptyState title="No activity yet" description="Activity appears as you review jobs, tailor resumes and track applications." />
              ) : (
                <ol className="space-y-1">
                  {summary.activity.slice(0, 5).map((event) => (
                    <li key={`${event.at}-${event.text}`} className="flex gap-3 py-3">
                      <span aria-hidden="true" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--accent)]" />
                      <span className="min-w-0">
                        <span className="line-clamp-2 block text-[14px] font-medium leading-snug text-primary">{event.text}</span>
                        <span className="mt-1 block text-[13px] text-tertiary">{presentActivityAge(event.at)}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
          </div>

          <section aria-label="Recommended for you" className="order-2 xl:w-[340px] xl:shrink-0">
            <SectionHeading title="Recommended for you" href="/jobs" linkLabel="View all jobs" />
            {summary.jobs.newOpportunities > jobs.length && (
              <p className="-mt-2 mb-3 text-[13px] text-tertiary">{summary.jobs.newOpportunities} matches evaluated in total</p>
            )}
            {jobs.length === 0 ? (
              <div className={`${CARD} p-2`}>
                <SharedEmptyState
                  title="No evaluated matches yet"
                  description="New recommendations appear once jobs are scanned and matched against your profile."
                  action={<Link href="/jobs" className="text-[13px] font-semibold text-[var(--accent)] hover:underline">Browse jobs</Link>}
                />
              </div>
            ) : (
              <ul className="space-y-3">
                {jobs.map(({ job, ranking }) => {
                  const salary = formatSalary(job);
                  return (
                    <li key={job.id} className={`${CARD} flex min-h-[128px] flex-col gap-3 p-4 sm:p-5`}>
                      <div className="flex items-center gap-3">
                        <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--tile-lav-bg)] text-[13px] font-bold text-[var(--tile-lav-fg)]">{initials(job.company_name)}</span>
                        <div className="min-w-0 flex-1">
                          <Link href={`/jobs/${job.id}`} className="line-clamp-2 text-[16px] font-bold leading-snug text-primary hover:underline">{job.title}</Link>
                          <p className="mt-1 flex flex-wrap gap-x-2 text-[13px] text-secondary">
                            <span className="font-medium">{job.company_name}</span>
                            {job.location ? <span>· {job.location}</span> : null}
                            {freshness(job) ? <span>· {freshness(job)}</span> : null}
                          </p>
                        </div>
                        <SaveJobButton jobId={job.id} jobTitle={job.title} candidateId={candidateId} initialSaved={job.pinned === 1} />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {ranking.overallScore !== null && !ranking.insufficientJdSignal ? <span className="rounded-full bg-[var(--pill-success-bg)] px-2.5 py-1 text-[13px] font-semibold text-[var(--pill-success-fg)]">Match {Math.round(ranking.overallScore)}</span> : <span className="rounded-full bg-[var(--chip-bg)] px-2.5 py-1 text-[13px] text-[var(--chip-text)]">Match data pending</span>}
                        {salary && <span className="rounded-full bg-[var(--z0-bg)] px-2.5 py-1 text-[13px] font-semibold text-primary">{salary}</span>}
                        {sourceLabel(job.source_type) ? <span className="text-[13px] text-tertiary">{sourceLabel(job.source_type)}</span> : null}
                      </div>
                      <SponsorshipRow confidence={job.h1b_combined_confidence} />
                      <Link href={`/jobs/${job.id}`} className="mt-auto flex min-h-11 items-center justify-center rounded-[10px] border border-[var(--border-control)] text-[14px] font-semibold text-primary hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2">View job</Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
