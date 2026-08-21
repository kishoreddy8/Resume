"use client";

import Link from "next/link";
import type { JobMatchResult } from "@/lib/match/types";
import type { JobWithCompany } from "@/types";
import { combineH1bConfidence } from "@/lib/h1b/combineSignal";
import { IconArrowUpRight, IconPin } from "@/components/icons";

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

/** The board a person could recognise. `built_in` is an internal seed marker, not a place. */
function sourceLabel(source: string | null): string | null {
  if (!source || source === "built_in") return null;
  return source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
  primary,
}: {
  job: JobWithCompany;
  result: JobMatchResult | null;
  /** Exactly one primary action, chosen by the workspace from the workflow's real position. */
  primary: { label: string; onClick: () => void; disabled?: boolean } | null;
}) {
  const decision = decisionLabel(result?.decision ?? null);
  const score = typeof result?.overallScore === "number" ? Math.round(result.overallScore) : null;
  const ats = sourceLabel(job.source_type);
  const age = freshness(job);
  /* The authoritative sponsorship outcome: the company's history, overridden by this posting's own
   * words when it states them. Read from the shared helper, never recomputed here. */
  const h1b = combineH1bConfidence(job.company_h1b_confidence, job.sponsorship_polarity);

  const meta = [job.company_name, job.location, ats, age].filter(Boolean) as string[];

  const toneClass = {
    success: "bg-[var(--pill-success-bg)] text-[var(--pill-success-fg)]",
    warning: "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]",
    error: "bg-[color-mix(in_oklab,var(--error)_12%,transparent)] text-[var(--error)]",
  } as const;

  return (
    <header className="rounded-[14px] border border-[var(--border)] bg-[var(--z3-bg)] px-5 py-3.5 shadow-[var(--shadow-row)]">
      <Link
        href="/jobs"
        className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--accent)] underline-offset-2 hover:underline"
      >
        <span aria-hidden="true">←</span> Back to jobs
      </Link>

      <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-4">
          <CompanyMark name={job.company_name} />
          <div className="min-w-0">
            {/* The workspace's one h1. */}
            <h1 className="line-clamp-2 text-[22px] font-bold leading-[1.2] tracking-[-0.018em] text-primary">
              {job.title}
            </h1>

            {meta.length > 0 && (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-tertiary">
                {meta.map((m, i) => (
                  <span key={m + i} className="flex items-center gap-2">
                    {i > 0 && <span aria-hidden="true">·</span>}
                    {m}
                  </span>
                ))}
              </p>
            )}

            {/* Decision, score and sponsorship — the three facts that decide whether to pursue. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-2">
              {decision && (
                <span
                  className={`inline-flex h-[25px] items-center rounded-full px-2.5 text-[12px] font-medium ${toneClass[decision.tone]}`}
                >
                  {decision.text}
                </span>
              )}
              {score !== null && (
                <span className="text-[12.5px] tabular-nums text-secondary">Match {score}</span>
              )}
              <span className="flex items-center gap-1.5 text-[12.5px] text-tertiary" title={h1b.reason}>
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

        <div className="flex shrink-0 items-center gap-2">
          {job.url && (
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-[42px] items-center gap-1.5 rounded-[10px] border border-[var(--border-control)] px-4 text-[13px] font-medium text-primary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)]"
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
              className="flex h-[42px] items-center rounded-[10px] bg-[var(--accent)] px-5 text-[13px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {primary.label}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
