"use client";

/**
 * UI-2 — the one global skip-to-content mechanism.
 *
 * Rendered exactly once, as the first thing in <body> (see layout.tsx), so it is the very first
 * keyboard-focusable control on every route. Invisible until it receives focus (`sr-only` /
 * `focus:not-sr-only`, Tailwind's own utilities — no new CSS system), then uses the same tokens
 * every other primitive does: `--accent`/`--accent-fg` for the pill, `--focus-ring` for the ring,
 * `--lift-3` for the elevation a floating control at this z-order already uses elsewhere.
 *
 * No animation. A skip link is read by exactly one kind of visitor — someone tabbing from browser
 * chrome — and for them an entrance transition is pure delay, not polish.
 *
 * Targets `#main-content`, the one stable id AppShell's <main> carries in both the chromeless and
 * normal render paths (see AppShell.tsx) — the same element regardless of which route is open.
 */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-[10px] focus:bg-[var(--accent)] focus:px-4 focus:py-2.5 focus:text-[14px] focus:font-semibold focus:text-[var(--accent-fg)] focus:shadow-[var(--lift-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2"
    >
      Skip to main content
    </a>
  );
}
