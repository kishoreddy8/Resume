"use client";

import { motion, useReducedMotion } from "motion/react";
import { H1bBadge } from "@/components/H1bBadge";
import { getJobAgeBand, getJobAgeDays, type LifecycleThresholds } from "@/lib/jobLifecycle";
import type { ListMatchSummary } from "@/lib/rank/jobsList";
import { candidateStatus } from "@/lib/candidateStatus";
import type { JobWithCompany } from "@/types";

/**
 * UI-J — presentation pieces shared between the desktop list row (JobRow.tsx) and the mobile swipe
 * card (JobSwipeCard.tsx), so both render the same facts the same way. Nothing here fetches or
 * mutates; every value comes from what the caller already has (the same bulk /api/jobs / For You
 * payload, and the same batched match-decisions lookup JobList/ForYouList already run).
 */

export type CardJob = Pick<
  JobWithCompany,
  | "id"
  | "dedupe_key"
  | "title"
  | "company_name"
  | "location"
  | "is_active"
  | "h1b_combined_confidence"
  | "posted_at"
  | "first_seen_at"
  | "marked_for_tailoring"
  | "pipeline_status"
  | "pinned"
  | "seniority"
  | "employment_type_normalized"
  | "workplace_type_normalized"
  | "salary_min"
  | "salary_max"
  | "salary_currency"
  | "salary_period"
>;

export function companyMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "JB";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

/** Compact desktop-row treatment: a pill for the decision plus the raw score. Unchanged from the
 *  pre-UI-J JobRow — kept here so both the row and any other compact consumer read one definition. */
export function MatchFit({ summary }: { summary: ListMatchSummary | undefined }) {
  if (!summary) return <span className="text-[13px] font-medium text-tertiary">Not evaluated</span>;
  if (summary.insufficientJdSignal) {
    return (
      <span className="rounded-full bg-[var(--pill-amber-bg)] px-2.5 py-1 text-[13px] font-semibold text-[var(--pill-amber-fg)]">
        Insufficient data
      </span>
    );
  }
  const tone =
    summary.decision === "READY_FOR_TAILORING"
      ? "bg-[var(--pill-success-bg)] text-[var(--pill-success-fg)]"
      : summary.decision === "NEEDS_REVIEW"
        ? "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]"
        : "bg-[var(--pill-red-bg)] text-[var(--pill-red-fg)]";
  const label =
    summary.decision === "READY_FOR_TAILORING"
      ? candidateStatus("readyToTailor").label
      : summary.decision === "NEEDS_REVIEW"
        ? candidateStatus("needsReview").label
        : candidateStatus("blocked").label;
  return (
    <span className="flex items-center gap-2.5 whitespace-nowrap">
      <span className={`rounded-full px-2.5 py-1 text-[13px] font-semibold ${tone}`}>{label}</span>
      <span className="text-[18px] font-bold tabular-nums text-primary">{Math.round(summary.overallScore)}</span>
    </span>
  );
}

/** Mobile-card treatment: the same three facts (decision, trust, score) as MatchFit, drawn as a
 *  small luminous ring — the same visual language as the job detail page's ScoreRing, at card scale.
 *  Never implies more precision than the engine gives: an untrusted or absent score renders as a
 *  dashed, unfilled ring with an em dash, exactly as the detail page's ring does. */
export function MatchRing({ summary, size = 52 }: { summary: ListMatchSummary | undefined; size?: number }) {
  const reduced = useReducedMotion() ?? false;
  const trusted = summary !== undefined && !summary.insufficientJdSignal;
  const tone: "ready" | "review" | "blocked" | "neutral" =
    summary?.decision === "READY_FOR_TAILORING"
      ? "ready"
      : summary?.decision === "NEEDS_REVIEW"
        ? "review"
        : summary?.decision === "BLOCKED"
          ? "blocked"
          : "neutral";
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = trusted && summary ? Math.max(0, Math.min(100, summary.overallScore)) / 100 : 0;
  const strokeColor =
    tone === "ready" ? "var(--success)" : tone === "review" ? "var(--warning)" : tone === "blocked" ? "var(--error)" : "var(--text-tertiary)";

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title={trusted ? `${Math.round(summary!.overallScore)}% match` : "Not yet evaluated"}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--separator)" strokeWidth={stroke} strokeDasharray={trusted ? undefined : "3 4"} />
        {trusted && (
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={strokeColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            initial={reduced ? false : { strokeDashoffset: c }}
            animate={{ strokeDashoffset: c * (1 - pct) }}
            transition={reduced ? { duration: 0 } : { type: "spring", duration: 0.4, bounce: 0 }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[14px] font-bold leading-none tabular-nums text-primary">{trusted ? Math.round(summary!.overallScore) : "—"}</span>
      </div>
    </div>
  );
}

export function AgeLabel({ job, thresholds }: { job: Pick<CardJob, "posted_at" | "first_seen_at">; thresholds: LifecycleThresholds }) {
  const days = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at });
  const fresh = getJobAgeBand(days, thresholds) === "fresh";
  const label = days === 0 ? "Today" : days === 1 ? "1 day ago" : `${days} days ago`;
  return <span className={fresh ? "font-semibold text-[var(--accent)]" : "text-tertiary"}>{label}</span>;
}

/** Sponsorship, elevated: its own tinted row rather than one pill lost among others. Reuses the
 *  existing H1bBadge (dot + word, never colour alone) — only the surrounding weight changes. */
export function SponsorshipRow({ confidence }: { confidence: CardJob["h1b_combined_confidence"] }) {
  return (
    <div className="flex items-center gap-2 rounded-[10px] bg-[var(--z0-bg)] px-2.5 py-1.5">
      <H1bBadge confidence={confidence} />
    </div>
  );
}

/** salary_min/max are structured, already-parsed dollar figures (see src/lib/jobIntel/compensation.ts)
 *  — real data, not inferred. Returns null (render nothing) when neither bound is present; never a
 *  fabricated range. */
export function formatSalary(job: Pick<CardJob, "salary_min" | "salary_max" | "salary_currency" | "salary_period">): string | null {
  const { salary_min, salary_max, salary_currency, salary_period } = job;
  if (salary_min === null && salary_max === null) return null;
  const currency = salary_currency ?? "USD";
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n)));
  const amount =
    salary_min !== null && salary_max !== null && salary_min !== salary_max
      ? `${symbol}${fmt(salary_min)}–${symbol}${fmt(salary_max)}`
      : `${symbol}${fmt(salary_max ?? salary_min!)}`;
  return salary_period === "hourly" ? `${amount}/hr` : `${amount}/yr`;
}

/** Seniority/employment/workplace — real, already-fetched structured fields (see JOB_LIST_SELECT).
 *  "Unknown" is the engine's own honest value for an unresolved field; it is omitted here rather
 *  than rendered, the same way a null field would be — an explicit "Unknown" badge lost among real
 *  facts reads as a fact itself, when it is actually an absence of one. */
export function factChips(
  job: Pick<CardJob, "seniority" | "employment_type_normalized" | "workplace_type_normalized">
): string[] {
  const values: (string | null)[] = [job.seniority, job.employment_type_normalized, job.workplace_type_normalized];
  return values.filter((v): v is string => Boolean(v) && v !== "Unknown");
}
