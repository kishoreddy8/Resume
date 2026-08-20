"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { LoadingRegion, SkeletonRows, Surface } from "@/components/ui";

/**
 * JobHunt home.
 *
 * IT ANSWERS ONE QUESTION: what should I do next. Not "here is everything we know" — that is what
 * the rest of the app is for, and a home screen that opens with eleven metrics has answered nothing.
 * Three lines about the search, then the actions that follow from them.
 *
 * EVERY NUMBER IS REAL AND ALREADY COMPUTED. Counts come from the match engine's own decision
 * tallies and from runs the user actually has. There is no profile strength, no readiness
 * percentage, no streak. A home screen is where an invented number would be most believed, so
 * there are none.
 *
 * THE LINES ADAPT TO THE STATE. Someone with no profile is told to build one; someone with three
 * applications waiting is told that instead. A fixed three-stat row would spend its best space
 * saying "0" to a new user.
 */

interface HomeSummary {
  firstName: string | null;
  jobs: { readyForTailoring: number; needsReview: number; evaluated: number };
  applications: { waitingOnYou: number; reasons: string[] };
  profile: { status: string; skills: number; employers: number };
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

interface Line {
  text: string;
  href: string;
  cta: string;
  emphasis: boolean;
}

/** The state of the search, as sentences. Ordered by what deserves attention first. */
function buildLines(s: HomeSummary): Line[] {
  const lines: Line[] = [];

  if (s.applications.waitingOnYou > 0) {
    lines.push({
      text:
        s.applications.waitingOnYou === 1
          ? "1 application is waiting on you"
          : `${s.applications.waitingOnYou} applications are waiting on you`,
      href: "/applications",
      cta: "Continue applications",
      emphasis: true,
    });
  }

  if (s.profile.status !== "ok") {
    lines.push({
      text:
        s.profile.status === "missing"
          ? "Your profile has not been built yet — jobs cannot be matched without it"
          : `Your profile needs attention (${s.profile.status})`,
      href: "/resume",
      cta: "Build your profile",
      emphasis: true,
    });
  }

  if (s.jobs.readyForTailoring > 0) {
    lines.push({
      text:
        s.jobs.readyForTailoring === 1
          ? "1 job is ready to tailor a resume for"
          : `${s.jobs.readyForTailoring} jobs are ready to tailor a resume for`,
      href: "/jobs",
      cta: "Find jobs",
      emphasis: false,
    });
  }

  if (s.jobs.needsReview > 0) {
    lines.push({
      text: `${s.jobs.needsReview.toLocaleString()} more jobs are worth a look`,
      href: "/jobs",
      cta: "Review jobs",
      emphasis: false,
    });
  }

  if (lines.length === 0) {
    lines.push({
      text:
        s.jobs.evaluated > 0
          ? "Nothing is waiting on you right now"
          : "No jobs have been matched against your profile yet",
      href: "/jobs",
      cta: "Find jobs",
      emphasis: false,
    });
  }

  return lines;
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
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-8">
        <LoadingRegion label="Loading your job search" />
        <Surface level="z3" className="rounded-[var(--radius-xl)] p-6">
          <SkeletonRows rows={4} />
        </Surface>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="mx-auto w-full max-w-3xl py-8">
        <h1 className="page-title">JobHunt</h1>
        <p className="mt-2 text-[13px] text-tertiary">Your job search could not be loaded right now.</p>
      </div>
    );
  }

  const lines = buildLines(summary);
  const primary = lines[0];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 py-8 sm:py-12">
      <motion.header
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduced ? { duration: 0.14 } : { type: "spring", duration: 0.4, bounce: 0 }}
      >
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-primary sm:text-[32px]">
          {greeting()}
          {summary.firstName ? `, ${summary.firstName}` : ""}
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-tertiary">
          Here is where your job search stands.
        </p>
      </motion.header>

      {/* The state of the search, as sentences rather than a grid of numbers. */}
      <motion.section
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduced ? { duration: 0.14 } : { type: "spring", duration: 0.44, bounce: 0, delay: 0.05 }}
        aria-label="Your job search"
      >
        <ul className="flex flex-col gap-2.5">
          {lines.map((line) => (
            <li key={line.text}>
              <Surface
                level="z3"
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-xl)] px-5 py-4"
              >
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    line.emphasis ? "bg-[var(--accent)]" : "bg-transparent ring-1 ring-inset ring-[var(--border)]"
                  }`}
                />
                <span
                  className={`min-w-0 flex-1 text-[14px] leading-snug ${
                    line.emphasis ? "font-medium text-primary" : "text-secondary"
                  }`}
                >
                  {line.text}
                </span>
                <Link
                  href={line.href}
                  className="shrink-0 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
                >
                  {line.cta} →
                </Link>
              </Surface>
            </li>
          ))}
        </ul>
      </motion.section>

      {/* One primary action, chosen from the state above rather than always the same button. */}
      <motion.section
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduced ? { duration: 0.14 } : { type: "spring", duration: 0.44, bounce: 0, delay: 0.1 }}
        className="flex flex-wrap gap-2"
      >
        <Link
          href={primary.href}
          className="rounded-md bg-[var(--accent)] px-4 py-2.5 text-[13.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
        >
          {primary.cta}
        </Link>
        <Link
          href="/resume"
          className="rounded-md border border-[var(--border)] px-4 py-2.5 text-[13.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
        >
          Improve resume
        </Link>
      </motion.section>

      {/* Facts about the profile, only when there is a profile to describe. */}
      {summary.profile.status === "ok" && (
        <section aria-label="Your profile" className="border-t border-[var(--separator)] pt-5">
          <p className="text-[12.5px] leading-relaxed text-tertiary">
            Your profile holds{" "}
            <span className="tabular-nums text-secondary">{summary.profile.skills}</span> evidenced skills across{" "}
            <span className="tabular-nums text-secondary">{summary.profile.employers}</span>{" "}
            {summary.profile.employers === 1 ? "employer" : "employers"}. Every job is matched against it —
            nothing is claimed that your documents do not support.
          </p>
        </section>
      )}
    </div>
  );
}
