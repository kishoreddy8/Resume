import type { Transition } from "motion/react";

/**
 * UI-1 — the shared motion foundation every screen draws from.
 *
 * These values are NOT new. They are the exact numbers `jobs/[id]/choreography.ts` already shipped
 * — the best-reasoned motion in the product, per the design audit: critically-damped springs, a
 * documented reduced-motion variant tree, timing chosen so state changes read as one spatial event
 * rather than four unrelated animations. `choreography.ts` now imports from here instead of owning
 * a private copy, so a future screen (application/resume stage rails, per the design direction) has
 * one place to import the same timing from, rather than re-deriving it.
 *
 * `--motion-fast` / `--motion-normal` / `--motion-emphasized` / `--motion-stagger` in globals.css
 * are the CSS-transition equivalents of the constants below — one timing system, two runtimes (CSS
 * transitions for plain DOM state changes, Motion/Framer springs for anything orchestrated). Keep
 * the two in sync if either changes.
 */

/** Hover, press, colour change. Matches `--motion-fast` in globals.css. */
export const MOTION_FAST_MS = 120;

/** Disclosure, tab switch, toast. Matches `--motion-normal` in globals.css. */
export const MOTION_NORMAL_MS = 200;

/** Sibling regions only — never list rows. Matches `--motion-stagger` in globals.css. */
export const MOTION_STAGGER_MS = 55;

/**
 * Stage change, entry, sheet open. Critically damped — no bounce. The one spring this system uses
 * for "something changed". Its duration (0.32s = 320ms) matches `--motion-emphasized` in
 * globals.css; kept as its own exported constant, rather than only inline in choreography.ts,
 * because a future screen orchestrating its own Motion variants (application/resume stage rails)
 * needs the same `Transition` object, not just the number.
 */
export const MOTION_EMPHASIZED: Transition = { type: "spring", duration: 0.32, bounce: 0 };

/**
 * UI-M — nav selection (a `layoutId`-driven indicator sliding between destinations), matching
 * `--motion-normal` (200ms) rather than the emphasized 320ms — a tab switch is a smaller event than
 * a stage change. Same critically-damped shape as `MOTION_EMPHASIZED`, scaled to the shorter
 * duration; not a new motion system, the one other spring this app's timing scale implies.
 */
export const MOTION_NORMAL: Transition = { type: "spring", duration: MOTION_NORMAL_MS / 1000, bounce: 0 };
