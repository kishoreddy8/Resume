"use client";

import Link from "next/link";
import type { JobMatchResult } from "@/lib/match/types";
import type { JobWithCompany } from "@/types";
import { combineH1bConfidence } from "@/lib/h1b/combineSignal";
import { IconArrowUpRight, IconPin } from "@/components/icons";
import { sourceLabel } from "../sourceLabel";
import { SaveJobButton } from "../SaveJobButton";
import type { WorkspaceHeroPresentation } from "./workspacePresentation";

/**
 * Who this job is, in one compact band.
 *
 * IT IS NOT A HERO. The workspace's job is the workflow underneath it, so identity gets a fixed,
 * modest strip rather than a full screen of branding: mark, title, the meta that decides whether a
 * job is worth pursuing, and exactly one primary action.
 *
 * EVERY FIELD IS OMITTED WHEN UNKNOWN. There is no "—" and no placeholder. In particular the
 * freshness line never says "Posted" over a date the employer did not state — `posted_at` is the
 * only thing that earns that word, and `first_seen_at` is reported as when JobHunt found it, which
 * is a different claim.
 */

const MARK_TINTS = [
  "bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]",
  "bg-[var(--tile-green-bg)] text-[var(--tile-green-fg)]",
  "bg-[var(--tile-blue-bg)] text-[var(--tile-blue-fg)]",
  "bg-[var(--tile-amber-bg)] text-[var(--tile-amber-fg)]",
];

/** Initials on a name-derived tint. No logo is stored and none is fetched. */
function CompanyMark({ name }: { name: string | null }) {
  const label = (name ?? "?").trim();
  const words = label.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  const initials =
    (words.length > 1
      ? words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("")
      : (words[0] ?? "").slice(0, 2).toUpperCase()) || "?";
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return (
    <span
      aria-hidden="true"
      className={`grid h-14 w-14 shrink-0 place-items-center rounded-[12px] text-[17px] font-semibold ${MARK_TINTS[hash % MARK_TINTS.length]}`}
    >
      {initials}
    </span>
  );
}

/** "Posted 3 days ago", or "Seen 3 days ago" when the board never stated a date. */
function freshness(job: Pick<JobWithCompany, "posted_at" | "first_seen_at">): string | null {
  const iso = job.posted_at ?? job.first_seen_at;
  if (!iso) return null;
  const verb = job.posted_at ? "Posted" : "Seen";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days < 0) return null;
  if (days === 0) return `${verb} today`;
  if (days === 1) return `${verb} yesterday`;
  return `${verb} ${days} days ago`;
}

/** The engine's decision, in a candidate's words. Never an enum. */
export function decisionLabel(decision: string | null): { text: string; tone: "success" | "warning" | "error" } | null {
  if (decision === "READY_FOR_TAILORING") return { text: "Ready to tailor", tone: "success" };
  if (decision === "NEEDS_REVIEW") return { text: "Needs review", tone: "warning" };
  if (decision === "BLOCKED") return { text: "Blocked", tone: "error" };
  return null;
}

export function JobIdentityHeader({
  job,
  result,
  candidateId,
  status,
  primary,
}: {
  job: JobWithCompany;
  result: JobMatchResult | null;
  candidateId: number;
  status: WorkspaceHeroPresentation["status"];
  /** Exactly one primary action, chosen by the workspace from the workflow's real position. */
  primary: { label: string; onClick: () => void; disabled?: boolean } | null;
}) {
  const score = typeof result?.overallScore === "number" ? Math.round(result.overallScore) : null;
  const ats = sourceLabel(job.source_type);
  const age = freshness(job);
  /* The authoritative sponsorship outcome: the company's history, overridden by this posting's own
   * words when it states them. Read from the shared helper, never recomputed here. */
  const h1b = combineH1bConfidence(job.company_h1b_confidence, job.sponsorship_polarity);

  const meta = [job.company_name, job.location, ats, age].filter(Boolean) as string[];

  const statusTone = {
    success: "bg-[var(--pill-success-bg)] text-[var(--pill-success-fg)]",
    accent: "bg-[var(--accent-soft)] text-[var(--accent)]",
    warning: "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]",
    error: "bg-[color-mix(in_oklab,var(--error)_12%,transparent)] text-[var(--error)]",
    neutral: "bg-[var(--chip-bg)] text-[var(--chip-text)]",
  } as const;

  return (
    <header className="relative overflow-hidden rounded-[24px] border border-[color-mix(in_oklab,var(--accent)_14%,var(--border))] bg-[linear-gradient(135deg,var(--z3-bg)_0%,var(--z3-bg)_58%,color-mix(in_oklab,var(--accent-soft)_62%,var(--z3-bg))_100%)] px-5 py-5 shadow-[var(--lift-2)] md:px-7 md:py-6">
      <span aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-[color-mix(in_oklab,var(--accent)_8%,transparent)] blur-2xl" />
      <Link
        href="/jobs"
        className="relative inline-flex min-h-11 items-center gap-1.5 text-[13.5px] font-semibold text-[var(--accent)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <span aria-hidden="true">←</span> Back to jobs
      </Link>

      <div className="relative mt-2 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 gap-4 md:gap-5">
          <CompanyMark name={job.company_name} />
          <div className="min-w-0">
            {/* The workspace's one h1. */}
            <h1 className="line-clamp-2 text-[24px] font-bold leading-[1.16] tracking-[-0.025em] text-primary md:text-[28px]">
              {job.title}
            </h1>

            {meta.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-secondary md:text-[14px]">
                {meta.map((m, i) => (
                  <span key={m + i} className="flex items-center gap-2">
                    {i > 0 && <span aria-hidden="true">·</span>}
                    {m}
                  </span>
                ))}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <span className={`inline-flex min-h-8 items-center rounded-full px-3 text-[13px] font-semibold ${statusTone[status.tone]}`}>
                {status.label}
              </span>
              {score !== null && (
                <span className="inline-flex min-h-8 items-center rounded-full bg-[var(--accent-tint)] px-3 text-[13px] font-semibold tabular-nums text-[var(--accent)]">
                  Match {score}
                </span>
              )}
              <span className="flex min-h-8 items-center gap-1.5 text-[13px] text-secondary" title={h1b.reason}>
                <IconPin size={13} />
                {/* The confidence vocabulary verbatim. An unknown is never promoted to a positive. */}
                {h1b.confidence === "Not Sponsoring"
                  ? "No sponsorship stated"
                  : h1b.confidence === "Unknown"
                    ? "Sponsorship unknown"
                    : `Sponsorship ${h1b.confidence.toLowerCase()}`}
              </span>
            </div>
          </div>
        </div>

        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto lg:justify-end">
          <SaveJobButton
            jobId={job.id}
            jobTitle={job.title}
            candidateId={candidateId}
            initialSaved={job.pinned === 1}
            className="border border-[var(--border-control)] bg-[var(--z3-bg)] shadow-[var(--shadow-row)]"
          />
          {job.url && (
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-11 items-center gap-1.5 rounded-[12px] border border-[var(--border-control)] bg-[var(--z3-bg)] px-4 text-[13.5px] font-semibold text-primary shadow-[var(--shadow-row)] transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              View original
              <IconArrowUpRight size={14} />
            </a>
          )}
          {primary && (
            <button
              type="button"
              onClick={primary.onClick}
              disabled={primary.disabled}
              className="flex h-11 flex-1 items-center justify-center rounded-[12px] bg-[var(--accent)] px-5 text-[13.5px] font-semibold text-[var(--accent-fg)] shadow-[0_8px_20px_color-mix(in_oklab,var(--accent)_22%,transparent)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
            >
              {primary.label}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
