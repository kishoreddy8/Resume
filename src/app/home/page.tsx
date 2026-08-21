"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { LoadingRegion, SkeletonRows } from "@/components/ui";
import { presentStatus } from "@/app/applications/runStatus";
import { NOTIFICATION_PRESENTATION, notificationTitle } from "@/lib/notifications/presentation";
import {
  IconArrowUpRight,
  IconCheckCircle,
  IconChevronRight,
  IconCircle,
  IconDocument,
  IconInbox,
  IconPin,
  IconSearch,
  IconStar,
  IconTrend,
  IconUser,
} from "@/components/icons";

/**
 * JobHunt home.
 *
 * IT ANSWERS ONE QUESTION: what should I do next. Not "here is everything we know" — that is what
 * the rest of the app is for, and a home screen opening with eleven metrics has answered nothing.
 * One greeting, one primary action, the numbers that are true, a few opportunities, and a rail for
 * what is waiting.
 *
 * ONE ACTION, ALWAYS. The primary card is chosen from real state and there is exactly one, because
 * two equally-weighted "next steps" is the same as none. An application waiting on a person beats a
 * job worth tailoring; a missing profile beats both, since nothing else works without it.
 *
 * NO INVENTED NUMBERS. No profile strength, no readiness score, no market signal, no confidence.
 * The app does not know those, and home is where a fabricated number would be most believed. The
 * match score shown on a card is the engine's own weighted average, rounded exactly as the jobs
 * list rounds it — the same number, in a nicer frame, never a second opinion about the same job.
 *
 * EVERY SECTION CAN BE EMPTY. A brand-new account has no recommendations, no applications and no
 * activity, so those sections say what would put something there rather than rendering an empty
 * frame around a zero.
 */

interface RecommendedJob {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  source: string | null;
  score: number;
  postedAt: string | null;
  firstSeenAt: string;
  evidence: string[];
  evidenced: number;
  requirements: number;
}

interface WaitingRun {
  id: number;
  status: string;
  title: string | null;
  company: string | null;
}

interface HomeSummary {
  firstName: string | null;
  jobs: {
    newOpportunities: number;
    newOpportunitiesRecent: number;
    readyForTailoring: number;
    needsReview: number;
    evaluated: number;
  };
  applications: {
    waitingOnYou: number;
    total: number;
    tracking: number;
    submitted: number;
    reasons: string[];
    first: { id: number; status: string; question: string | null } | null;
    waiting: WaitingRun[];
  };
  profile: { status: string; skills: number; employers: number };
  resumesCreated: number;
  resumesThisWeek: number;
  recommended: RecommendedJob[];
  activity: { at: string; type: string; text: string }[];
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** One sentence about where the search stands. Adapts to state; never generic. */
function subtitle(s: HomeSummary): string {
  /* The approved design's register — warm, second person, forward-looking — applied to the state
   * that is actually true. The selection below is unchanged; only the wording is. A single fixed
   * line would read as encouragement the app cannot back up on a morning when something is
   * genuinely waiting. */
  if (s.profile.status !== "ok") return "Let's finish your profile so we can start matching roles.";
  if (s.applications.waitingOnYou > 0)
    return "Let's clear the applications that are waiting on you.";
  if (s.jobs.readyForTailoring > 0) return "Let's make today a step closer to your next role.";
  if (s.jobs.evaluated > 0) return "Nothing needs you right now — new matches land here as they're found.";
  return "As soon as jobs are scanned, your strongest matches appear here.";
}

interface PrimaryAction {
  eyebrow: string;
  title: string;
  detail: string;
  href: string;
  cta: string;
  secondary?: { href: string; label: string };
}

/** The single most important thing to do, from real state. Ordered by what blocks what. */
function primaryAction(s: HomeSummary): PrimaryAction {
  if (s.profile.status !== "ok") {
    return {
      eyebrow: "Start here",
      title: "Build your profile",
      detail:
        "Your resume and skills inventory are what every job is matched against. Nothing can be recommended until they are read.",
      href: "/onboarding",
      cta: "Complete setup",
    };
  }

  if (s.applications.first) {
    const a = s.applications.first;
    return {
      eyebrow: "Waiting on you",
      title: a.question ? "An application asked you something" : "An application needs you",
      detail: a.question ?? a.status.replace(/_/g, " ").toLowerCase(),
      href: `/applications/${a.id}`,
      cta: "Continue application",
      secondary: { href: "/applications", label: "All applications" },
    };
  }

  const top = s.recommended[0];
  if (top) {
    return {
      eyebrow: "Ready to tailor",
      title: top.title,
      detail: [top.company, top.location].filter(Boolean).join(" · ") || "Strong evidence alignment",
      href: `/jobs/${top.id}`,
      cta: "Review & tailor resume",
      secondary: { href: `/jobs/${top.id}`, label: "View job details" },
    };
  }

  return {
    eyebrow: "Next step",
    title: s.jobs.evaluated > 0 ? "Review your matches" : "Find jobs to match",
    detail:
      s.jobs.evaluated > 0
        ? `${s.jobs.needsReview.toLocaleString()} jobs are worth a look.`
        : "Once jobs are scanned and evaluated, your strongest matches appear here.",
    href: "/jobs",
    cta: "Open jobs",
  };
}

/* The journey strip that used to live here has been folded into the overview tiles above.
 * It reported the same four numbers — evaluated, ready, resumes, applications — that the tiles now
 * report with a real hierarchy, so rendering both put every figure on the screen twice. The
 * selection is unchanged; it is stated once instead of twice. */

type PriorityKind = "profile" | "question" | "tailor";

interface Priority {
  text: string;
  /** The line under it. Always a fact about the same thing, never a restatement of the text. */
  context: string;
  href: string;
  kind: PriorityKind;
}

/** Today's priorities. Derived from state, never a to-do list the app invented. */
function priorities(s: HomeSummary): Priority[] {
  const out: Priority[] = [];
  if (s.profile.status !== "ok")
    out.push({
      text: "Finish building your profile",
      context: "Matching cannot run until it is read",
      href: "/onboarding",
      kind: "profile",
    });
  if (s.applications.first)
    out.push({
      text: "Answer an application question",
      context: presentStatus(s.applications.first.status).label,
      href: `/applications/${s.applications.first.id}`,
      kind: "question",
    });
  /* Named by ROLE, not by company. Two openings at the same employer produced two identical lines
   * pointing at different jobs — indistinguishable to read and colliding as React keys. The title
   * is what actually differs. */
  for (const job of s.recommended.slice(0, 2)) {
    out.push({
      text: `Tailor resume for ${job.title}`,
      context: [job.company, `Match ${job.score}`].filter(Boolean).join(" · "),
      href: `/jobs/${job.id}`,
      kind: "tailor",
    });
  }
  /* Deduped on destination, so the same job can never appear twice however it was added. */
  const seen = new Set<string>();
  return out.filter((item) => (seen.has(item.href) ? false : (seen.add(item.href), true)));
}

/**
 * A recorded event, said in a candidate's words.
 *
 * TITLED FROM THE TYPE, NOT THE PROSE. Notifications carry a `type` enum alongside their written
 * title, so the row's heading comes from that rather than from pattern-matching English. An
 * unrecognised type falls through to the recorded title verbatim — a new event kind will read
 * plainly rather than being mislabelled by a guess.
 *
 * NOTHING IS HIDDEN. A failure still says it needs attention, and the full recorded text is kept
 * on the row's `title` so the exact event is always one hover (or one screen reader) away.
 */
function presentActivity(a: { type: string; text: string }): { title: string; context: string | null } {
  /* Most titles are "<what happened> — <employer> <role>"; the subject is the half worth keeping. */
  const dash = a.text.indexOf(" — ");
  const subject = dash >= 0 ? a.text.slice(dash + 3) : a.text;
  /* Titles come from the shared notification map, so Settings and this rail cannot drift into
   * calling the same event two different things. The context half stays local: only this rail
   * splits the recorded text, and only a match keeps the whole line. */
  if (!(a.type in NOTIFICATION_PRESENTATION)) return { title: a.text, context: null };
  const title = notificationTitle(a.type);
  return { title, context: a.type === "HIGH_VALUE_JOB_MATCH" ? a.text : subject };
}

/* ── presentation helpers ──────────────────────────────────────────────────────────────────── */

/** Whole days between two instants, floored. Used only for wording, never for a decision. */
function daysSince(iso: string): number | null {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

/**
 * "Posted 3 days ago" — or "Seen 3 days ago" when the board never stated a date.
 *
 * The two are different claims and are never merged: `first_seen_at` is when JobHunt found the
 * posting, which can be long after it went up. Saying "posted" over that would be inventing a fact
 * about the employer.
 */
function freshness(job: { postedAt: string | null; firstSeenAt: string }): string | null {
  const iso = job.postedAt ?? job.firstSeenAt;
  const verb = job.postedAt ? "Posted" : "Seen";
  const days = daysSince(iso);
  if (days === null || days < 0) return null;
  if (days === 0) return `${verb} today`;
  if (days === 1) return `${verb} yesterday`;
  return `${verb} ${days} days ago`;
}

/** Compact relative age for the activity timeline. */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/**
 * The board a job came from, in a person's words — or nothing.
 *
 * `built_in` is an internal seed-list marker, not a place anyone applies. Printing it raw put a
 * developer's token on a candidate's home screen, so a source is shown only when it names something
 * a person could recognise.
 */
function sourceLabel(source: string | null): string | null {
  if (!source || source === "built_in") return null;
  return source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * A company mark built from the company's own name.
 *
 * NO LOGOS ARE FETCHED. JobHunt does not store one, and pulling favicons from each employer's
 * domain would mean a third-party request per card — for decoration — on the first screen of the
 * app. Initials on a tinted tile give a card the same shape and scannability with nothing on the
 * wire. The tint is derived from the name, so a company keeps the same colour everywhere.
 */
const MARK_TINTS = [
  "bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]",
  "bg-[var(--tile-green-bg)] text-[var(--tile-green-fg)]",
  "bg-[var(--tile-blue-bg)] text-[var(--tile-blue-fg)]",
  "bg-[var(--tile-amber-bg)] text-[var(--tile-amber-fg)]",
];

function Monogram({ name, size = "md" }: { name: string | null; size?: "sm" | "md" | "lg" }) {
  const label = (name ?? "?").trim();
  const words = label.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  /* Two letters, always. One word gives its first two ("JPMorganChase" reads as JP, not J) — a
   * single character is not a mark, it is a placeholder, and most employers here are one word. */
  const initials =
    (words.length > 1
      ? words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("")
      : (words[0] ?? "").slice(0, 2).toUpperCase()) || "?";
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  const tint = MARK_TINTS[hash % MARK_TINTS.length]!;
  const box =
    size === "lg"
      ? "h-16 w-16 rounded-[12px] text-[19px]"
      : size === "sm"
        ? "h-8 w-8 rounded-[8px] text-[11px]"
        : "h-12 w-12 rounded-[10px] text-[14px]";
  return (
    <span aria-hidden="true" className={`grid shrink-0 place-items-center font-semibold tracking-[-0.01em] ${box} ${tint}`}>
      {initials}
    </span>
  );
}

/** The shared card shell: white plane, one hairline, one very soft lift. */
/** The shared card shell: white plane, one hairline, one restrained shadow. */
/* The home API returns six activity entries and the rail was rendering four of them, so the column
 * ran out of content while the main column kept going and the page ended on a band of empty rail.
 * Six is what there is; nothing is invented to fill the space. */
const ACTIVITY_SHOWN = 6;

const CARD = "rounded-[14px] border border-[var(--border)] bg-[var(--z3-bg)] shadow-[var(--shadow-card)]";
/** A recommendation row sits one step lighter than a card — smaller radius, softer lift. */
const ROW = "rounded-[12px] border border-[#E7E9F0] bg-[var(--z3-bg)] shadow-[var(--shadow-row)] dark:border-[var(--border)]";

function RailHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-bold uppercase tracking-[0.07em] text-[#70768A] dark:text-tertiary">
      {children}
    </h2>
  );
}

/** A soft tinted tile behind a line icon. Decorative — the row's text carries the meaning. */
function IconTile({
  tone,
  size = "md",
  children,
}: {
  tone: "accent" | "success" | "warning" | "info";
  size?: "md" | "lg";
  children: React.ReactNode;
}) {
  const tint = {
    accent: "bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]",
    success: "bg-[var(--tile-green-bg)] text-[var(--tile-green-fg)]",
    warning: "bg-[var(--tile-amber-bg)] text-[var(--tile-amber-fg)]",
    info: "bg-[var(--tile-blue-bg)] text-[var(--tile-blue-fg)]",
  }[tone];
  const box = size === "lg" ? "h-10 w-10 rounded-[12px]" : "h-9 w-9 rounded-[10px]";
  return <span className={`grid shrink-0 place-items-center ${box} ${tint}`}>{children}</span>;
}

/**
 * One presentation for every empty rail section.
 *
 * A single grey sentence measured 109px tall between a 271px card and a 436px one, so the middle of
 * the rail read as a rendering failure rather than as the good news it is. The height comes from
 * the same icon tile the populated rows use — an empty section is recognisably the same kind of
 * thing as a full one, not a collapsed version of it. Nothing is padded with invented content.
 */
function RailEmpty({
  tone,
  icon,
  children,
}: {
  tone: "accent" | "success" | "warning" | "info";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 flex min-h-[76px] items-center gap-3">
      <IconTile tone={tone}>{icon}</IconTile>
      <p className="min-w-0 text-[12.5px] leading-relaxed text-tertiary">{children}</p>
    </div>
  );
}

/**
 * The match, as a word and a number.
 *
 * The word is the engine's decision, the number is its score. They are kept as two marks rather
 * than one pill because they are two different facts — and the word carries the meaning on its own,
 * so nothing here depends on the green being seen.
 */
function MatchMark({ score, size = "md" }: { score: number; size?: "md" | "lg" }) {
  const pill = size === "lg" ? "h-[27px] px-3 text-[12.5px]" : "h-[25px] px-2.5 text-[12px]";
  return (
    <span className="flex items-center gap-2.5">
      <span
        className={`inline-flex items-center rounded-full bg-[var(--pill-success-bg)] font-medium text-[var(--pill-success-fg)] ${pill}`}
      >
        Ready to tailor
      </span>
      <span className="text-[13px] tabular-nums text-[#666D7E] dark:text-tertiary">Match {score}</span>
    </span>
  );
}

/**
 * The four overview tiles.
 *
 * FIXED CONCEPTS, FIXED ORDER, FIXED COLOUR. New opportunities, resumes, applications waiting,
 * applications tracked — always those four, always in that sequence, always lavender/green/amber/
 * blue. Nothing here is chosen by what happens to be non-zero: a tile that reads 0 is telling the
 * candidate something true, and a row whose colours move around cannot be learned.
 *
 * The internal tallies these replaced — ready-for-tailoring, needs-review, jobs-evaluated — were
 * the matching engine's bookkeeping, not a person's view of their search. They are still on the
 * payload and still used elsewhere on the page; they are simply no longer the headline.
 *
 * EVERY VALUE AND EVERY SUPPORTING LINE IS REAL, and a supporting line is omitted rather than
 * padded when there is nothing additional that is true.
 */
function overviewTiles(s: HomeSummary) {
  return [
    {
      key: "opportunities",
      value: s.jobs.newOpportunities,
      label: "New opportunities",
      sub:
        s.jobs.newOpportunitiesRecent > 0
          ? `${s.jobs.newOpportunitiesRecent.toLocaleString()} posted in the last 10 days`
          : null,
      tone: "accent" as const,
      icon: <IconSearch size={19} />,
      href: "/jobs",
    },
    {
      key: "resumes",
      value: s.resumesCreated,
      label: "Resumes ready",
      sub: s.resumesThisWeek > 0 ? `${s.resumesThisWeek} tailored this week` : null,
      tone: "success" as const,
      icon: <IconDocument size={19} />,
      href: "/resume",
    },
    {
      key: "needsAction",
      value: s.applications.waitingOnYou,
      label: "Applications need your action",
      sub:
        s.applications.waitingOnYou === 0
          ? "You're all caught up"
          : s.applications.first
            ? presentStatus(s.applications.first.status).label.toLowerCase()
            : null,
      tone: "warning" as const,
      icon: <IconInbox size={19} />,
      href: "/applications",
    },
    {
      key: "tracking",
      value: s.applications.tracking,
      label: "Applications tracking",
      sub:
        s.applications.tracking === 0
          ? "No applications being tracked"
          : s.applications.submitted > 0
            ? `${s.applications.submitted} submitted`
            : null,
      tone: "info" as const,
      icon: <IconTrend size={19} />,
      href: "/applications",
    },
  ];
}

export default function HomePage() {
  const candidateId = useResolvedCandidateId();
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const reduced = useReducedMotion() ?? false;

  const load = useCallback(async () => {
    if (candidateId === null) return;
    try {
      const res = await fetch(`/api/candidates/${candidateId}/home`);
      if (!res.ok) return setFailed(true);
      setSummary((await res.json()) as HomeSummary);
    } catch {
      setFailed(true);
    }
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (candidateId === null || (!summary && !failed)) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--home-max-w)] flex-col gap-6 pt-2">
        <LoadingRegion label="Loading your job search" />
        <div className={`${CARD} p-6`}>
          <SkeletonRows rows={4} />
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="mx-auto w-full max-w-[var(--home-max-w)] pt-2">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-primary">JobHunt</h1>
        <p className="mt-2 text-[13px] text-tertiary">Your job search could not be loaded right now.</p>
      </div>
    );
  }

  const action = primaryAction(summary);
  const todo = priorities(summary);
  const tiles = overviewTiles(summary);
  const top = summary.recommended[0];
  /* The hero card describes a specific job only when the action IS that job. When an application is
   * waiting, the card is about the application and must not wear a job's badges — it wears the
   * run's own state instead, taken from the same run the action points at. */
  const heroJob = action.eyebrow === "Ready to tailor" ? top : undefined;
  const heroRun = action.eyebrow === "Waiting on you" ? summary.applications.waiting[0] : undefined;
  const heroMark = heroJob?.company ?? heroRun?.company ?? null;

  const rise = (delay: number) => ({
    initial: reduced ? { opacity: 0 } : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: reduced
      ? { duration: 0.14 }
      : ({ type: "spring", duration: 0.44, bounce: 0, delay } as const),
  });

  return (
    /* Main column then aside. On a narrow screen this stacks in exactly the required reading order:
     * greeting, primary action, overview, recommendations, priorities, applications, activity. */
    <div className="mx-auto grid w-full max-w-[var(--home-max-w)] gap-7 pb-8 pt-2 xl:grid-cols-[minmax(0,1fr)_var(--home-rail-w)] xl:gap-[var(--home-rail-gap)]">
      <div className="flex min-w-0 flex-col gap-9">
        {/* ── greeting ─────────────────────────────────────────────────────────────────────── */}
        <motion.header
          {...rise(0)}
          /* The floor is what the artwork stands on: without it the block is only as tall as two
           *  lines of text and the horizon is clipped away entirely. */
          className="relative flex flex-col justify-center overflow-hidden pb-1 lg:min-h-[112px]"
        >
          {/* Purely decorative: a soft indigo horizon behind the greeting. Two gradients and four
           *  paths, inline — no image request, no layout cost, and gone below `md`. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 340 110"
            preserveAspectRatio="xMaxYMax meet"
            className="pointer-events-none absolute bottom-0 right-0 hidden h-[110px] w-[340px] opacity-[0.72] lg:block"
          >
            <defs>
              {/* The approved lavender ramp, back to front. */}
              <linearGradient id="jh-far" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#CFC8FF" />
                <stop offset="100%" stopColor="#DDD9FF" />
              </linearGradient>
              <linearGradient id="jh-near" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#BEB5FF" />
                <stop offset="100%" stopColor="#CFC8FF" />
              </linearGradient>
              <radialGradient id="jh-sun" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0%" stopColor="#F1B5B0" stopOpacity="0.55" />
                <stop offset="100%" stopColor="#F1B5B0" stopOpacity="0" />
              </radialGradient>
              {/* Fades out to the left so the horizon sits BEHIND the greeting rather than beside
               *  it, and can never compete with the heading for legibility. */}
              <linearGradient id="jh-fade" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#fff" stopOpacity="0" />
                <stop offset="42%" stopColor="#fff" stopOpacity="1" />
              </linearGradient>
              <mask id="jh-mask">
                <rect x="0" y="0" width="340" height="110" fill="url(#jh-fade)" />
              </mask>
            </defs>
            <g mask="url(#jh-mask)">
              <circle cx="214" cy="58" r="30" fill="url(#jh-sun)" />
              <path d="M8 102 L74 44 L118 78 L148 54 L196 96 L228 70 L292 102 Z" fill="url(#jh-far)" />
              <path d="M118 102 L178 52 L214 82 L240 62 L296 102 Z" fill="url(#jh-far)" opacity="0.85" />
              <path d="M44 102 L104 60 L150 102 Z" fill="url(#jh-near)" />
              <path d="M188 102 L246 62 L292 102 Z" fill="url(#jh-near)" />
              <path d="M0 102 H340" stroke="#CFC8FF" strokeWidth="1" />
            </g>
          </svg>

          <h1 className="relative text-[26px] font-bold leading-[1.15] tracking-[-0.024em] text-primary sm:text-[33px]">
            {greeting()}
            {summary.firstName ? `, ${summary.firstName}` : ""}!{" "}
            <span aria-hidden="true">👋</span>
          </h1>
          <p className="relative mt-2 text-[15px] leading-[1.5] text-secondary">{subtitle(summary)}</p>
        </motion.header>

        {/* ── the one thing to do ──────────────────────────────────────────────────────────── */}
        <motion.section {...rise(0.05)} aria-label="Your next step">
          <div className={`${CARD} rounded-[16px] px-6 py-6 shadow-[var(--shadow-hero)] sm:min-h-[220px] sm:px-[29px] sm:py-[28px]`}>
            {/* One constant label. The card's job is to be the one thing to do, and re-labelling
             *  it per state made the most stable element on the page the least recognisable. Which
             *  state produced it is carried by the title, the badge and the button. */}
            <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--accent)]">
              Your next best action
            </span>

            <div className="mt-5 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-[18px]">
                {heroMark ? <Monogram name={heroMark} size="lg" /> : null}
                <div className="min-w-0">
                  <h2 className="text-[19px] font-bold leading-[1.25] tracking-[-0.016em] text-primary sm:text-[21px]">
                    {action.title}
                  </h2>
                  <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-tertiary">
                    <span className="text-secondary">{action.detail}</span>
                    {heroJob && freshness(heroJob) && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{freshness(heroJob)}</span>
                      </>
                    )}
                  </p>
                  {heroRun && (
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                      {/* The engine's own word for the run's state — the same word the applications
                       *  page uses, never a second vocabulary invented for home. */}
                      <span className="rounded-full bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--warning)]">
                        {presentStatus(heroRun.status).label}
                      </span>
                      {heroRun.title && (
                        <span className="text-[11.5px] text-tertiary">{heroRun.title}</span>
                      )}
                    </div>
                  )}
                  {heroJob && (
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <MatchMark score={heroJob.score} size="lg" />
                      {sourceLabel(heroJob.source) && (
                        <span className="flex items-center gap-1.5 text-[11.5px] text-tertiary">
                          <IconPin size={13} />
                          {sourceLabel(heroJob.source)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* The primary action is the only filled control on the page above the fold. */}
              <div className="flex shrink-0 flex-col sm:w-[205px]">
                <Link
                  href={action.href}
                  className="flex h-[47px] items-center justify-center gap-2 rounded-[10px] bg-[var(--accent)] px-4 text-[14px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
                >
                  {action.cta}
                  <IconArrowUpRight size={16} />
                </Link>
                {action.secondary && (
                  <Link
                    href={action.secondary.href}
                    className="mt-2.5 flex h-[45px] items-center justify-center rounded-[10px] border border-[var(--border-control)] px-4 text-[14px] font-medium text-primary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:scale-[0.98]"
                  >
                    {action.secondary.label}
                  </Link>
                )}
              </div>
            </div>

            {/* The evidence line. Real counts, or the row is not drawn. */}
            {heroJob && heroJob.requirements > 0 && (
              <p className="mt-5 flex items-start gap-2.5 border-t border-[var(--separator)] pt-4 text-[13px] leading-relaxed text-[#444A59] dark:text-secondary">
                <span className="mt-px text-[var(--accent)]">
                  <IconStar size={16} />
                </span>
                <span>
                  You have employer-backed evidence for{" "}
                  <span className="font-semibold text-primary">
                    {heroJob.evidenced} of {heroJob.requirements}
                  </span>{" "}
                  requirements in this description.
                </span>
              </p>
            )}
          </div>
        </motion.section>

        {/* ── overview ─────────────────────────────────────────────────────────────────────── */}
        <motion.section {...rise(0.1)} aria-label="Your job search overview" className="space-y-[15px]">
            <RailHeading>Your job search overview</RailHeading>
            {/* Always four columns, because there are always four concepts. A zero is a real
             *  answer here, so no tile is ever dropped for being empty. */}
            <div
              className="grid gap-[13px] [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))] xl:[grid-template-columns:repeat(var(--tile-cols),minmax(0,1fr))]"
              style={{ ["--tile-cols" as string]: "4" }}
            >
              {tiles.map((t) => (
                <Link
                  key={t.key}
                  href={t.href}
                  className="block rounded-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2"
                >
                  <div
                    className={`${CARD} flex h-full min-h-[172px] flex-col p-5 transition-[box-shadow,border-color] duration-150 ease-out hover:border-[#D8DBE6] hover:shadow-[var(--shadow-card)] dark:hover:border-[var(--border-control)]`}
                  >
                    <IconTile tone={t.tone} size="lg">
                      {t.icon}
                    </IconTile>
                    {/* A FIXED offset from the icon, never mt-auto. Bottom-anchoring put the
                     *  numeral of a tile with no supporting line 22px below its neighbours', which
                     *  is exactly the misalignment a row of metrics must not have. */}
                    <div className="pt-[14px]">
                      <div className="text-[30px] font-bold leading-none tabular-nums tracking-[-0.022em] text-primary">
                        {t.value.toLocaleString()}
                      </div>
                      <div className="mt-2.5 text-[13px] font-semibold leading-snug text-primary">{t.label}</div>
                      {t.sub && <div className="mt-1.5 text-[12px] leading-snug text-tertiary">{t.sub}</div>}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
        </motion.section>

        {/* ── opportunities ────────────────────────────────────────────────────────────────── */}
        <motion.section {...rise(0.15)} aria-label="Recommended opportunities" className="space-y-[15px]">
          <div className="flex items-center justify-between gap-3">
            <RailHeading>Recommended for you</RailHeading>
            <Link
              href="/jobs"
              className="text-[12px] font-semibold text-[var(--accent)] underline-offset-2 hover:underline"
            >
              View all jobs
            </Link>
          </div>

          {summary.recommended.length === 0 ? (
            <div className={`${ROW} px-[18px] py-6`}>
              <p className="text-[13px] leading-relaxed text-tertiary">
                {summary.profile.status === "ok"
                  ? "No job has cleared the evidence bar yet. Matches appear here as new roles are scanned."
                  : "Recommendations appear once your profile is built."}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {summary.recommended.map((job) => (
                <li key={job.id}>
                  <div className={`${ROW} flex min-h-[106px] items-center px-[18px] py-3 transition-[box-shadow,border-color] duration-150 ease-out hover:border-[#D5D9E4] hover:shadow-[var(--shadow-card)] dark:hover:border-[var(--border-control)]`}>
                    <div className="flex w-full items-center gap-[14px]">
                      <Monogram name={job.company} />
                      <div className="min-w-0 flex-1">
                        <h3 className="min-w-0 text-[15.5px] font-bold leading-snug tracking-[-0.012em] text-primary">
                          <Link href={`/jobs/${job.id}`} className="hover:underline">
                            {job.title}
                          </Link>
                        </h3>
                        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-tertiary">
                          {job.company && <span className="font-medium text-secondary">{job.company}</span>}
                          {job.location && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{job.location}</span>
                            </>
                          )}
                          {freshness(job) && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{freshness(job)}</span>
                            </>
                          )}
                        </p>

                        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                          <MatchMark score={job.score} />
                          {/* Where you would actually apply. Real board only — see sourceLabel. */}
                          {sourceLabel(job.source) && (
                            <span className="flex items-center gap-1.5 text-[12px] text-tertiary">
                              <IconPin size={13} />
                              {sourceLabel(job.source)}
                            </span>
                          )}
                          {/* Skills the engine attributed to a named employer — not keywords. */}
                          {job.evidence.map((e) => (
                            <span
                              key={e}
                              className="inline-flex h-6 items-center rounded-full bg-[var(--chip-bg)] px-2.5 text-[11.5px] text-[var(--chip-text)]"
                            >
                              {e}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="hidden shrink-0 items-center pl-3 sm:flex">
                        <Link
                          href={`/jobs/${job.id}`}
                          className="grid h-9 w-[88px] place-items-center rounded-[8px] border border-[var(--border-control)] text-[12px] font-medium text-primary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:scale-[0.98]"
                        >
                          View job
                        </Link>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </motion.section>

      </div>

      {/* ── context rail ───────────────────────────────────────────────────────────────────── */}
      {/* PRIORITIES, then APPLICATIONS NEEDING ACTION, then RECENT ACTIVITY. The order is fixed and
       *  every section is always rendered, because a rail that reshuffles itself according to which
       *  data happens to exist cannot be learned. An empty section says so in one line. */}
      <motion.aside {...rise(0.2)} className="flex min-w-0 flex-col gap-4">
        {/* 1 — priorities */}
        <section aria-label="Priorities" className={`${CARD} flex min-h-[168px] flex-col px-5 py-[19px]`}>
          <RailHeading>Priorities</RailHeading>
          {todo.length === 0 ? (
            <RailEmpty tone="success" icon={<IconCheckCircle size={17} />}>
              Nothing needs you right now.
            </RailEmpty>
          ) : (
            <ul className="mt-3 flex flex-col divide-y divide-[#F0F1F5] dark:divide-[var(--separator)]">
              {todo.map((t) => (
                <li key={t.href}>
                  <Link
                    href={t.href}
                    className="-mx-2 grid min-h-[76px] grid-cols-[40px_minmax(0,1fr)_16px] items-center gap-x-1.5 rounded-[10px] px-2 py-3 transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)]"
                  >
                    <IconTile tone={t.kind === "question" ? "warning" : t.kind === "profile" ? "info" : "success"}>
                      {t.kind === "question" ? (
                        <IconInbox size={17} />
                      ) : t.kind === "profile" ? (
                        <IconUser size={17} />
                      ) : (
                        <IconDocument size={17} />
                      )}
                    </IconTile>
                    <span className="min-w-0">
                      <span className="line-clamp-2 block text-[13.5px] font-semibold leading-[1.35] text-primary">
                        {t.text}
                      </span>
                      <span className="mt-1 block truncate text-[12px] text-tertiary">{t.context}</span>
                    </span>
                    <span aria-hidden="true" className="shrink-0 text-[#969BA8]">
                      <IconChevronRight size={16} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {/* No "view all priorities" link: priorities are drawn from jobs AND applications, and no
           *  single page holds both. A link that landed on only half of them would be a lie about
           *  where the rest went. */}
        </section>

        {/* 2 — applications that stopped for a person */}
        <section aria-label="Applications needing action" className={`${CARD} flex min-h-[168px] flex-col px-5 py-[19px]`}>
          <RailHeading>Applications needing action</RailHeading>
          {summary.applications.waiting.length === 0 ? (
            <>
              <RailEmpty tone="success" icon={<IconCheckCircle size={17} />}>
                You&apos;re all caught up — no application needs your action.
              </RailEmpty>
              {/* The one section whose empty state has somewhere to send you: unlike priorities,
               *  which are drawn from two places, every application lives on one page. */}
              <Link
                href="/applications"
                className="mt-auto flex items-center gap-1 pt-3 text-[12.5px] font-medium text-[var(--accent)] transition-colors duration-150 ease-out hover:text-[var(--accent-hover)]"
              >
                View all applications
                <span aria-hidden="true">
                  <IconChevronRight size={14} />
                </span>
              </Link>
            </>
          ) : (
            <>
              <ul className="mt-3 flex flex-col divide-y divide-[#F0F1F5] dark:divide-[var(--separator)]">
                {summary.applications.waiting.map((run) => {
                  const present = presentStatus(run.status);
                  /* Two tones over the engine's OWN states — no new state model. A run that is
                   * finished and waiting to be looked at reads differently from one that is blocked
                   * on an answer, and the reference distinguishes them. The word is still the
                   * engine's, so the tone is never carrying the meaning by itself. */
                  const review =
                    run.status === "READY_FOR_REVIEW" || run.status === "WAITING_FOR_SUBMIT_APPROVAL";
                  const pillTone = review
                    ? "bg-[var(--pill-blue-bg)] text-[var(--pill-blue-fg)]"
                    : "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]";
                  return (
                    <li key={run.id}>
                      <Link
                        href={`/applications/${run.id}`}
                        className="-mx-2 grid min-h-[72px] grid-cols-[36px_minmax(0,1fr)] items-center gap-x-3 rounded-[10px] px-2 py-3 transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)]"
                      >
                        <Monogram name={run.company} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate text-[13.5px] font-semibold leading-snug text-primary">
                            {run.company ?? "Application"}
                          </span>
                          {run.title && (
                            <span className="mt-0.5 block truncate text-[12px] text-tertiary">{run.title}</span>
                          )}
                          <span
                            className={`mt-1.5 inline-flex h-[23px] items-center rounded-full px-2.5 text-[11.5px] font-medium ${pillTone}`}
                          >
                            {present.label}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <Link
                href="/applications"
                className="mt-3 block rounded-[8px] border-t border-[#F0F1F5] pt-3 text-center text-[12.5px] font-semibold text-[var(--accent)] transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] dark:border-[var(--separator)]"
              >
                View all applications
              </Link>
            </>
          )}
        </section>

        {/* 3 — what actually happened */}
        <section aria-label="Recent activity" className={`${CARD} flex min-h-[168px] flex-col px-5 py-[19px]`}>
          <RailHeading>Recent activity</RailHeading>
          {summary.activity.length === 0 ? (
            <RailEmpty tone="info" icon={<IconTrend size={17} />}>
              Activity appears here as you review jobs, build resumes and start applications.
            </RailEmpty>
          ) : (
            <ol className="mt-4 flex flex-col">
              {summary.activity.slice(0, ACTIVITY_SHOWN).map((a, i, arr) => {
                const shown = presentActivity(a);
                return (
                  /* The recorded text stays on the row, so the shortened heading never becomes the
                   * only version of the event that exists. */
                  <li key={`${a.at}-${a.text}`} className="flex gap-3" title={a.text}>
                    <span aria-hidden="true" className="flex w-6 shrink-0 flex-col items-center">
                      <span className="text-[var(--accent)]">
                        {i === 0 ? <IconCheckCircle size={18} /> : <IconCircle size={18} />}
                      </span>
                      {i < arr.length - 1 && (
                        <span className="w-px flex-1 bg-[#DFE3EA] dark:bg-[var(--separator)]" />
                      )}
                    </span>
                    <span className={`min-w-0 flex-1 ${i < arr.length - 1 ? "pb-[22px]" : ""}`}>
                      <span className="block text-[13.5px] font-semibold leading-[1.35] text-primary">
                        {shown.title}
                      </span>
                      {shown.context && (
                        <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-tertiary">
                          {shown.context}
                        </span>
                      )}
                      <span className="mt-1 block text-[11.5px] text-tertiary">{ago(a.at)}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </motion.aside>
    </div>
  );
}
