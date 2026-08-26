"use client";

import { useState } from "react";
import { motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { LifecycleThresholds } from "@/lib/jobLifecycle";
import type { ListMatchSummary } from "@/lib/rank/jobsList";
import { MOTION_EMPHASIZED } from "@/lib/motion/tokens";
import { SaveJobButton } from "./SaveJobButton";
import { WhyThisMatch } from "./WhyThisMatch";
import { canApproveForTailoring } from "./jobActions";
import {
  AgeLabel,
  companyMonogram,
  factChips,
  formatSalary,
  MatchRing,
  SponsorshipRow,
  type CardJob,
} from "./JobCardPresentation";

/**
 * UI-J — the one focused mobile job card. Swipe is an accelerator over the SAME two actions the
 * visible buttons below the card call (approveForTailoring / setJobNotInterested via jobActions.ts)
 * — never separate business logic. Right = Approve & Tailor (indigo/cyan, never success-green,
 * because nothing has succeeded yet — tailoring is only just starting). Left = Not interested
 * (restrained neutral/warm — this is reversible, personal, and not destructive, so it gets none of
 * the alarming weight a real delete would warrant).
 */

const SWIPE_THRESHOLD = 120;
const MAX_ROTATE_DEG = 7;

export function JobSwipeCard({
  job,
  candidateId,
  thresholds,
  summary,
  interactive,
  onOpen,
  onApprove,
  onReject,
  onSavedChange,
}: {
  job: CardJob;
  candidateId: number;
  thresholds: LifecycleThresholds;
  summary: ListMatchSummary | undefined;
  /** False for the peeking card(s) behind the focused one — no drag, no buttons, just a hint of depth. */
  interactive: boolean;
  onOpen: (id: number) => void;
  /** Resolves once the underlying request finishes; the card only leaves after a real, successful mutation. */
  onApprove: () => Promise<boolean>;
  onReject: () => Promise<boolean>;
  onSavedChange?: (jobId: number, saved: boolean) => void;
}) {
  const reduced = useReducedMotion() ?? false;
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-300, 300], [-MAX_ROTATE_DEG, MAX_ROTATE_DEG]);
  // Always called (Rules of Hooks) — only used when interactive and motion isn't reduced.
  const approveHintOpacity = useTransform(x, [20, SWIPE_THRESHOLD], [0, 1]);
  const rejectHintOpacity = useTransform(x, [-SWIPE_THRESHOLD, -20], [1, 0]);
  const approvable = canApproveForTailoring(summary?.decision);
  const salary = formatSalary(job);
  const chips = factChips(job);

  async function commitApprove() {
    if (!approvable || busy) return;
    setBusy("approve");
    setError(null);
    const ok = await onApprove();
    if (!ok) {
      setError("Couldn't approve this job. Try again.");
      setBusy(null);
    }
    // On success the parent removes this card from the deck; no local state to reset.
  }

  async function commitReject() {
    if (busy) return;
    setBusy("reject");
    setError(null);
    const ok = await onReject();
    if (!ok) {
      setError("Couldn't update this job. Try again.");
      setBusy(null);
    }
  }

  function handleDragEnd(_: unknown, info: { offset: { x: number }; velocity: { x: number } }) {
    const past = Math.abs(info.offset.x) > SWIPE_THRESHOLD || Math.abs(info.velocity.x) > 700;
    if (!past) return;
    if (info.offset.x > 0) void commitApprove();
    else void commitReject();
  }

  return (
    <div className="flex flex-col gap-4">
      <motion.div
        drag={interactive && !busy ? "x" : false}
        style={interactive ? { x, rotate: reduced ? 0 : rotate } : undefined}
        onDragEnd={interactive ? handleDragEnd : undefined}
        animate={busy ? { x: busy === "approve" ? 400 : -400, opacity: 0 } : { x: 0, opacity: 1 }}
        transition={reduced ? { duration: busy ? 0.14 : 0 } : busy ? { duration: 0.22, ease: "easeIn" } : MOTION_EMPHASIZED}
        onClick={() => !busy && onOpen(job.id)}
        className={`plane plane-2 relative flex min-h-[320px] cursor-pointer flex-col rounded-[24px] p-5 ${
          interactive ? "" : "pointer-events-none"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              aria-hidden="true"
              className="grid h-14 w-14 shrink-0 place-items-center rounded-[16px] bg-[linear-gradient(145deg,var(--accent-soft),var(--z0-bg))] text-[16px] font-bold tracking-[0.04em] text-[var(--accent)] ring-1 ring-inset ring-[color-mix(in_oklab,var(--accent)_18%,transparent)]"
            >
              {companyMonogram(job.company_name)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold text-primary">{job.company_name}</p>
              <p className="truncate text-[13px] text-secondary">{job.location ?? "Location unavailable"}</p>
            </div>
          </div>
          <MatchRing summary={summary} />
        </div>

        <h2 className="mt-4 text-[22px] font-bold leading-tight tracking-[-0.02em] text-primary">{job.title}</h2>

        {(chips.length > 0 || salary) && (
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-secondary">
            {chips.map((c, i) => (
              <span key={c}>
                {i > 0 && <span aria-hidden="true" className="mr-2 text-tertiary">·</span>}
                {c}
              </span>
            ))}
            {salary && (
              <span className="font-semibold text-primary">
                {chips.length > 0 && <span aria-hidden="true" className="mr-2 text-tertiary">·</span>}
                {salary}
              </span>
            )}
          </p>
        )}

        <div className="mt-4">
          <SponsorshipRow confidence={job.h1b_combined_confidence} />
        </div>

        <div className="mt-auto flex items-center justify-between pt-5 text-[12.5px] text-tertiary">
          <AgeLabel job={job} thresholds={thresholds} />
          {interactive && (
            <WhyThisMatch
              jobId={job.id}
              jobTitle={job.title}
              candidateId={candidateId}
              trigger={(open) => (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    open();
                  }}
                  className="min-h-11 rounded-full px-3 font-semibold text-[var(--accent)] transition-colors duration-150 ease-out hover:bg-[var(--accent-soft)] active:scale-[0.97]"
                >
                  Why this match?
                </button>
              )}
            />
          )}
        </div>

        {/* Swipe-intent overlays — purely presentational, mirror the same threshold the release
         *  handler uses. Hidden from reduced-motion users since rotation/opacity-follow is disabled
         *  there anyway; the buttons below remain the equivalent path regardless. */}
        {interactive && !reduced && (
          <>
            <motion.div
              aria-hidden="true"
              style={{ opacity: approveHintOpacity }}
              className="pointer-events-none absolute right-5 top-5 rounded-[10px] border-2 border-[var(--accent)] px-3 py-1 text-[13px] font-bold uppercase tracking-[0.06em] text-[var(--accent)]"
            >
              Approve
            </motion.div>
            <motion.div
              aria-hidden="true"
              style={{ opacity: rejectHintOpacity }}
              className="pointer-events-none absolute left-5 top-5 rounded-[10px] border-2 border-[var(--border)] px-3 py-1 text-[13px] font-bold uppercase tracking-[0.06em] text-secondary"
            >
              Not interested
            </motion.div>
          </>
        )}
      </motion.div>

      {interactive && (
        <div className="flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={commitReject}
            disabled={busy !== null}
            aria-label="Not interested"
            title="Not interested"
            className="grid h-14 w-14 place-items-center rounded-full border border-[var(--border)] bg-surface text-secondary shadow-[var(--lift-1)] transition-transform duration-150 ease-out active:scale-[0.94] disabled:opacity-50"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>

          <SaveJobButton
            jobId={job.id}
            jobTitle={job.title}
            candidateId={candidateId}
            initialSaved={job.pinned === 1}
            onSavedChange={onSavedChange}
            className="h-14 w-14 border border-[var(--border)] bg-surface shadow-[var(--lift-1)]"
          />

          <button
            type="button"
            onClick={commitApprove}
            disabled={busy !== null || !approvable}
            aria-label="Approve & Tailor"
            title={approvable ? "Approve & Tailor" : "Open this job to evaluate its match first"}
            className="grid h-14 w-14 place-items-center rounded-full bg-[linear-gradient(145deg,var(--accent),var(--secondary))] text-white shadow-[var(--lift-2)] transition-transform duration-150 ease-out active:scale-[0.94] disabled:opacity-40"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 13l4 4L19 7" />
            </svg>
          </button>
        </div>
      )}

      {interactive && !approvable && (
        <p className="text-center text-[12px] text-tertiary">
          {summary === undefined ? "Open this job to evaluate its match before approving." : "Blocked — open this job to see why."}
        </p>
      )}
      {interactive && error && <p className="text-center text-[12px] text-[var(--error)]">{error}</p>}
    </div>
  );
}
