"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { JobWithCompany } from "@/types";
import type { JobMatch } from "./useJobMatch";

/**
 * The contextual action dock.
 *
 * Every job used to offer the same thing — a "Marked for resume tailoring" checkbox and a copy
 * button — whether the engine had evaluated it, blocked it, or already produced a resume for it.
 * Tailoring was the loudest control on a BLOCKED posting, which is exactly where it should not be.
 *
 * The dock shows ONE primary action, chosen from state the page already has: the Phase 2 decision,
 * whether tailoring has been approved, and whether generated files exist. No new request, no new
 * backend state, and no reinterpretation — BLOCKED still means blocked, and an unevaluated job is
 * still unevaluated.
 *
 * The scheduled writer now runs automatically once a job is approved for tailoring — the dock's
 * "Tailoring in progress" phase (marked, no generated files yet) reflects that: the candidate has
 * nothing further to do until the writer's next scheduled pass produces the first iteration. See
 * ResumeQualityPipeline.tsx / JobWorkspace.tsx for the richer lifecycle detail (writer health,
 * SAFE_BEST_ATTEMPT, human approval) this single-action dock deliberately does not surface.
 */

export type DockPhase =
  | "unevaluated"
  | "checking"
  | "blocked"
  | "needs-review"
  | "ready-to-approve"
  | "approved-awaiting-resume"
  | "resume-ready";

export interface DockState {
  phase: DockPhase;
  label: string;
  /** One line under the dock explaining what the action does or why none is offered. */
  hint: string;
  /** Primary actions are filled; advisory phases are not actionable and render as a statement. */
  actionable: boolean;
}

/** Presentation mapping only. Reads existing state; decides nothing. */
export function resolveDockState(
  match: JobMatch,
  job: Pick<JobWithCompany, "marked_for_tailoring">,
  generatedFileCount: number
): DockState {
  if (match.state === "loading" || match.state === "idle") {
    return { phase: "checking", label: "Checking match…", hint: "Reading this posting's evaluation.", actionable: false };
  }
  if (match.state === "none" || !match.result) {
    return {
      phase: "unevaluated",
      label: "Evaluate Match",
      hint: "This posting has not been scored against your profile yet.",
      actionable: true,
    };
  }

  const marked = job.marked_for_tailoring === 1;

  if (generatedFileCount > 0) {
    return {
      phase: "resume-ready",
      label: "Review Resume",
      hint: `${generatedFileCount} generated file${generatedFileCount === 1 ? "" : "s"} — review before applying.`,
      actionable: true,
    };
  }

  if (match.result.decision === "BLOCKED") {
    return {
      phase: "blocked",
      label: "Blocked — review the reason above",
      hint: "Tailoring is not offered while a hard blocker stands.",
      actionable: false,
    };
  }

  if (match.result.decision === "NEEDS_REVIEW") {
    return {
      phase: "needs-review",
      label: "Review Issues",
      hint: "Read why this fell short of Ready for Tailoring before approving anything.",
      actionable: true,
    };
  }

  if (marked) {
    return {
      phase: "approved-awaiting-resume",
      label: "Tailoring in progress",
      hint: "Approved. The resume writer runs automatically on its next scheduled pass — nothing else to run.",
      actionable: false,
    };
  }

  return {
    phase: "ready-to-approve",
    label: "Approve Tailoring",
    hint: "Marks this job for tailoring. Nothing is written or submitted from here.",
    actionable: true,
  };
}

function Overflow({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reduced = useReducedMotion() ?? false;

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      // Escape returns focus to the trigger, same as the filter panel and the notification inbox.
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        className="rounded-md px-2 py-1.5 text-[13px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98]"
      >
        <span aria-hidden="true">…</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            // Origin-aware: the menu scales out of the trigger it belongs to, not the viewport.
            style={{ transformOrigin: "top right" }}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -2 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
            transition={reduced ? { duration: 0.1 } : { type: "spring", duration: 0.18, bounce: 0 }}
            className="plane plane-5 absolute right-0 z-30 mt-1 min-w-[13rem] p-1"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function DockMenuItem({ onSelect, children }: { onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:bg-[var(--surface-active)]"
    >
      {children}
    </button>
  );
}

export function JobActionDock({
  state,
  onPrimary,
  postingUrl,
  overflow,
}: {
  state: DockState;
  onPrimary: () => void;
  postingUrl: string;
  overflow: ReactNode;
}) {
  const reduced = useReducedMotion() ?? false;

  // Z4 — the dock floats over the review surface rather than sitting in the flow, so the primary
  // action stays visually available as the eye travels down the page.
  return (
    <div className="plane plane-4 sticky bottom-3 z-20 mt-4 px-3.5 py-3">
      <div className="flex items-center gap-2">
        {/* The primary slot is one element that CHANGES rather than a stack of buttons that appear
         *  and disappear — so advancing the workflow reads as the same control moving forward. */}
        <div className="min-w-0 flex-1">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={state.phase}
              layout={!reduced}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={reduced ? { duration: 0.1 } : { type: "spring", duration: 0.28, bounce: 0.05 }}
            >
              {state.actionable ? (
                <button
                  type="button"
                  onClick={onPrimary}
                  className="w-full rounded-md bg-[var(--accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--accent-fg)] transition-colors duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.985] sm:w-auto"
                >
                  {state.label}
                </button>
              ) : (
                <span
                  className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] font-medium ${
                    state.phase === "blocked"
                      ? "border-[var(--error)]/35 text-[var(--error)]"
                      : "border-[var(--border)] text-secondary"
                  }`}
                >
                  {state.label}
                </span>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <a
          href={postingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-md px-2.5 py-2 text-[13px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98]"
        >
          Open posting ↗
        </a>

        <Overflow>{overflow}</Overflow>
      </div>

      <p className="mt-2 text-[12px] leading-relaxed text-tertiary">{state.hint}</p>
    </div>
  );
}
