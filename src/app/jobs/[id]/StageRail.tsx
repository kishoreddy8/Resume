"use client";

import { motion, useReducedMotion } from "motion/react";
import { MOTION_NORMAL } from "@/lib/motion/tokens";
import type { JourneyStage, JourneyStepState } from "./resumeJourneyPresentation";

/**
 * UI-5 — the resume-tailoring journey's stage rail. Purely presentational: it receives the stages
 * resumeJourneyPresentation.ts already computed and renders them, deciding nothing itself. A stage
 * already marked completed never reanimates on a later poll — Motion's animation is keyed off the
 * `state` value in the child's own `key`, and the parent only reports a new `stages` array when the
 * underlying status genuinely changes (ResumeQualityPipeline's onStageChange effect is itself keyed
 * on the real status/disposition fields, not on every poll tick), so a stage's key is stable across
 * re-renders that do not change its state.
 *
 * Never color-only: completed carries a check glyph, current a filled dot, upcoming a hollow ring,
 * attention an exclamation glyph — the word label is always present alongside all four. Below `sm`
 * this renders as the vertical checklist the mobile design calls for; at `sm` and up, as a horizontal
 * segmented bar with the label underneath each segment.
 */
export function StageRail({ stages, currentStageKey }: { stages: JourneyStage[]; currentStageKey: string | null }) {
  const reduced = useReducedMotion() ?? false;

  return (
    <ol aria-label="Resume tailoring progress" className="flex flex-col gap-2 sm:flex-row sm:gap-1.5">
      {stages.map((stage) => (
        <li
          key={stage.key}
          aria-current={stage.key === currentStageKey ? "step" : undefined}
          className="flex min-w-0 items-center gap-2.5 sm:flex-1 sm:flex-col sm:items-stretch sm:gap-1.5"
        >
          <StageMobileIcon state={stage.state} reduced={reduced} />
          <StageDesktopBar state={stage.state} reduced={reduced} />
          <span
            className={`min-w-0 truncate text-[12.5px] sm:text-[11.5px] ${
              stage.state === "current"
                ? "font-semibold text-primary"
                : stage.state === "attention"
                  ? "font-semibold text-[var(--attention-fg)]"
                  : stage.state === "completed"
                    ? "font-medium text-secondary"
                    : "text-tertiary"
            }`}
          >
            {stage.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Below `sm`: an icon-in-circle per row, matching the mobile checklist mockup. */
function StageMobileIcon({ state, reduced }: { state: JourneyStepState; reduced: boolean }) {
  return (
    <span className="sm:hidden">
      <CircleGlyph state={state} reduced={reduced} />
    </span>
  );
}

/** `sm` and up: a segmented bar, one per stage, label below — the existing (pre-UI-5) five-bar
 *  layout's shape, restyled onto the Spatial Premium token set instead of raw zinc/emerald/red. */
function StageDesktopBar({ state, reduced }: { state: JourneyStepState; reduced: boolean }) {
  const color =
    state === "completed" || state === "current"
      ? "bg-[var(--accent)]"
      : state === "attention"
        ? "bg-[var(--attention-fg)]"
        : "bg-[var(--separator)]";
  return (
    <motion.span
      key={state}
      aria-hidden="true"
      initial={reduced ? false : { scaleX: state === "completed" || state === "current" ? 0 : 1 }}
      animate={{ scaleX: 1 }}
      transition={reduced ? { duration: 0 } : MOTION_NORMAL}
      style={{ transformOrigin: "left" }}
      className={`hidden h-[3px] w-full rounded-full sm:block ${color}`}
    />
  );
}

function CircleGlyph({ state, reduced }: { state: JourneyStepState; reduced: boolean }) {
  if (state === "completed") {
    return (
      <motion.span
        key="completed"
        initial={reduced ? { opacity: 1 } : { scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={reduced ? { duration: 0 } : MOTION_NORMAL}
        aria-hidden="true"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)]"
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5 6.5 12 13 4.5" />
        </svg>
      </motion.span>
    );
  }
  if (state === "current") {
    return (
      <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-full ring-2 ring-[var(--accent)]">
        <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
      </span>
    );
  }
  if (state === "attention") {
    return (
      <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--attention-bg)] text-[var(--attention-fg)]">
        <span className="text-[12px] font-bold leading-none">!</span>
      </span>
    );
  }
  return <span aria-hidden="true" className="h-6 w-6 shrink-0 rounded-full ring-1 ring-inset ring-[var(--border-control)]" />;
}
