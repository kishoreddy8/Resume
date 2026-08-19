"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import { MatchDecisionBadge, type MatchDecision } from "@/components/MatchDecisionBadge";
import { getJobAgeBand, getJobAgeDays, type LifecycleThresholds } from "@/lib/jobLifecycle";
import type { JobWithCompany } from "@/types";
import type { JobMatch } from "./useJobMatch";

/**
 * Stage 2 — the decision header.
 *
 * The page used to open with a title and a link, and buried the verdict three cards down a narrow
 * rail. This block exists to answer, without scrolling: what job is this, is it a match, why, is
 * anything blocking it, and what happens next.
 *
 * It renders the Phase 2 result and nothing else. The decision, the eligibility status, every
 * reason string, the insufficient-signal flag and the sponsorship confidence are passed straight
 * through from the API — no state is derived, no score is recomputed, no sponsorship is inferred,
 * and no reason is re-worded. The caveat sentences below are the ones MatchCard already showed;
 * they travel with the verdict because a decision shown without them would read as more certain
 * than the engine actually is.
 */

const AGE_BAND_LABELS = {
  fresh: "Fresh",
  active: "Active",
  aging: "Aging",
  stale: "Stale",
} as const;

/** Age is metadata, so it is set in text rather than another coloured pill competing with the
 *  verdict. `aging`/`stale` keep a colour because they warn about automatic archival/deletion. */
const AGE_BAND_TEXT = {
  fresh: "text-secondary",
  active: "text-tertiary",
  aging: "text-[var(--warning)]",
  stale: "text-[var(--warning)]",
} as const;

function StateLine({ tone, children }: { tone: "warning" | "error" | "neutral"; children: ReactNode }) {
  const border =
    tone === "error"
      ? "border-l-[var(--error)]"
      : tone === "warning"
        ? "border-l-[var(--warning)]"
        : "border-l-[var(--border)]";
  return <div className={`border-l-2 ${border} py-0.5 pl-3 text-[13px] leading-relaxed text-secondary`}>{children}</div>;
}

export function JobDecisionHeader({
  job,
  match,
  thresholds,
  actions,
  showBackLink = true,
  onClose,
  headingLevel = "h1",
}: {
  job: JobWithCompany;
  match: JobMatch;
  thresholds: LifecycleThresholds;
  /** The page's existing tailoring controls. Rendered, never invoked from here. */
  actions: ReactNode;
  /** Hidden in the Workbench pane, where the list beside it already is the way back. */
  showBackLink?: boolean;
  /** Close affordance for the narrow-screen sheet. Keyboard reachable; never the only way out. */
  onClose?: () => void;
  /** The standalone route owns the page's h1. Inside the Workbench pane the toolbar does, so the
   *  job title steps down to h2 rather than giving the document two competing top-level headings. */
  headingLevel?: "h1" | "h2";
}) {
  const Heading = headingLevel;
  const { result, state } = match;
  const ageDays = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at });
  const ageBand = getJobAgeBand(ageDays, thresholds);

  const context = [job.location, job.employment_type, job.workplace_type, job.salary_text].filter(Boolean);
  const eligibility = result?.eligibility;
  const blockingReasons = result?.blockingReasons ?? [];
  // A score is shown only when the engine trusts it. When the JD signal is insufficient the number
  // is an unknown, not a low match, so it is replaced by that statement rather than printed with a
  // footnote the eye can skip.
  const showScore = result !== null && !result.insufficientJdSignal && typeof result.overallScore === "number";

  return (
    <header className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface">
      <div className="border-b border-[var(--separator)] px-5 py-4">
        {showBackLink && (
          <Link
            href="/jobs"
            className="text-[12px] text-tertiary transition-colors duration-150 ease-out hover:text-primary"
          >
            ← Back to jobs
          </Link>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-tertiary transition-colors duration-150 ease-out hover:text-primary active:scale-[0.98]"
          >
            ✕ Close
          </button>
        )}

        <div className="mt-2 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <Heading className="page-title">{job.title}</Heading>
            <p className="mt-1 text-[13px] text-secondary">
              {job.company_name} · {job.source_type}
              {job.is_archived === 1 ? " · archived" : !job.is_active && " · closed"}
              {job.is_archived === 0 && (
                <>
                  {" · "}
                  <span className={AGE_BAND_TEXT[ageBand]}>
                    {AGE_BAND_LABELS[ageBand]} · {ageDays}d
                  </span>
                </>
              )}
            </p>
            {context.length > 0 && (
              <p className="mt-1.5 text-[13px] text-tertiary">{context.join("  ·  ")}</p>
            )}
          </div>

          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-[var(--accent-fg)] transition-colors duration-150 ease-out hover:bg-[var(--accent-hover)]"
          >
            View posting ↗
          </a>
        </div>
      </div>

      {/* Verdict. Everything below is the engine's own output. */}
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {result && <MatchDecisionBadge decision={result.decision as MatchDecision} emphasis="strong" />}
          {state === "loading" && <span className="text-[13px] text-tertiary">Checking match…</span>}
          {state === "none" && <span className="text-[13px] text-tertiary">Not yet evaluated</span>}
          {state === "error" && (
            <span className="text-[13px] text-[var(--error)]">Failed to load match status.</span>
          )}

          {showScore && (
            <span className="text-[13px] text-secondary">
              Score{" "}
              <span className="text-[15px] font-semibold tabular-nums text-primary">
                {Math.round(result.overallScore)}
              </span>
              <span className="text-tertiary">/100</span>
            </span>
          )}

          <span className="flex items-center gap-1.5 text-[13px] text-secondary">
            <span className="text-tertiary">Sponsorship</span>
            <H1bBadge confidence={job.h1b_combined_confidence} />
          </span>
        </div>

        {/* The engine's own caveats, kept with the verdict rather than filed away below it. */}
        <div className="mt-3 space-y-2">
          {result?.insufficientJdSignal && (
            <StateLine tone="warning">
              <span className="font-medium text-primary">Insufficient structured JD data.</span> Fewer than
              the minimum number of requirements could be extracted from this posting, so the score is an
              unknown — it is neither a confident match nor a confident non-match, and lists rank this
              posting below every fully-evidenced one.
            </StateLine>
          )}

          {blockingReasons.length > 0 && (
            <StateLine tone="warning">
              <span className="font-medium text-primary">Why not Ready for Tailoring</span>
              <ul className="mt-1 space-y-0.5">
                {blockingReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </StateLine>
          )}

          {eligibility && (
            <StateLine tone={eligibility.status === "BLOCKED" ? "error" : eligibility.status === "UNKNOWN" ? "warning" : "neutral"}>
              <span className="font-medium text-primary">Eligibility: {eligibility.status ?? "Unknown"}</span>
              {eligibility.status === "PASS" && (
                <span className="text-tertiary"> (no known hard blocker — not a confirmation)</span>
              )}
              {eligibility.status === "UNKNOWN" && (
                <span className="text-tertiary">
                  {" "}
                  (advisory — an unknown sponsorship signal is not treated as a blocker, and is not read as
                  a &ldquo;no&rdquo;)
                </span>
              )}
              {(eligibility.reasons ?? []).length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {(eligibility.reasons ?? []).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </StateLine>
          )}
        </div>

        {/* Next action. These are the page's existing controls, moved here so they are findable —
         *  tailoring still runs in Claude Code and still requires you to start it. */}
        <div className="mt-4 border-t border-[var(--separator)] pt-3">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-tertiary">
            Next action
          </h2>
          {actions}
        </div>
      </div>
    </header>
  );
}
