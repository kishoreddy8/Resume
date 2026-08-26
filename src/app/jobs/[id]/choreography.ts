import type { Variants } from "motion/react";
import { MOTION_EMPHASIZED, MOTION_STAGGER_MS } from "@/lib/motion/tokens";

/**
 * The signature selection choreography.
 *
 * Selecting a job used to fire four unrelated animations. This turns them into
 * one spatial event by making them children of a single Motion variant tree: the
 * parent switches state once, and each region inherits its timing from the same
 * orchestration rather than owning a private transition.
 *
 * The phases, and why they are ordered this way:
 *
 *   A  0ms      selection itself — NOT animated. Row highlight and accent are
 *               instant, because arrow traversal is the highest-frequency action
 *               in the app and must never wait on a transition.
 *   B  ~40ms    identity (title, company) resolves — you learn WHAT you selected.
 *   C  ~90ms    verdict and ring — you learn the DECISION.
 *   D  ~150ms   tiles and dock — you learn the CONTEXT and the next action.
 *
 * Everything settles inside ~380ms with the ring finishing slightly later, which
 * is deliberate: the number is the one value worth watching arrive.
 *
 * Interruption is free. These are springs on transform/opacity keyed by job id —
 * pressing ArrowDown again remounts the tree and Motion retargets from wherever
 * the previous animation had reached. Nothing queues, nothing waits.
 */

/** Critically damped. Bounce stays at 0 everywhere except the dock, where a
 *  trace of overshoot reads as a physical control settling.
 *  UI-1 — re-exported from the shared `src/lib/motion/tokens.ts` rather than declared here; the
 *  value is unchanged, `SETTLE` is kept as the name this file's own consumers already import. */
export const SETTLE = MOTION_EMPHASIZED;

/** Parent: holds no visual state of its own, only the timeline its children read. */
export const heroStage: Variants = {
  enter: {},
  settled: {
    transition: {
      delayChildren: 0.04,
      staggerChildren: MOTION_STAGGER_MS / 1000,
    },
  },
};

/** Child regions. 6px is the whole travel budget — depth suggested, not performed. */
export const heroRegion: Variants = {
  enter: { opacity: 0, y: 6 },
  settled: { opacity: 1, y: 0, transition: SETTLE },
};

/** Reduced motion: the same tree, no travel, one short fade. */
export const heroStageReduced: Variants = {
  enter: {},
  settled: { transition: { delayChildren: 0, staggerChildren: 0 } },
};

export const heroRegionReduced: Variants = {
  enter: { opacity: 0 },
  settled: { opacity: 1, transition: { duration: 0.12 } },
};

/**
 * The studio's reflected light, keyed to the real decision.
 *
 * Light, never paint: these are the colours of an illumination behind the hero,
 * not a panel fill. An unevaluated job gets indigo — the app's neutral — rather
 * than a semantic colour it has not earned.
 */
export function verdictGlow(decision: string | null | undefined, trusted: boolean): string {
  if (!decision || !trusted) return "var(--accent-soft)";
  if (decision === "READY_FOR_TAILORING") return "color-mix(in oklab, var(--success) 16%, transparent)";
  if (decision === "NEEDS_REVIEW") return "color-mix(in oklab, var(--warning) 16%, transparent)";
  if (decision === "BLOCKED") return "color-mix(in oklab, var(--error) 15%, transparent)";
  return "var(--accent-soft)";
}
