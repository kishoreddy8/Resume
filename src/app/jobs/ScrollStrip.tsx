"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A horizontally scrolling strip that guarantees every child is reachable.
 *
 * The bucket tabs were already `overflow-x-auto`, and a fade was added at the right edge — but a
 * fade only says "there is more", it does not get you there. On a trackpad you can swipe; with a
 * mouse or a keyboard you could not reach "Ready to Apply" at all. So this adds real controls.
 *
 * Behaviour:
 *  - Arrows appear ONLY when there is actually something to scroll to, and each disables at its end,
 *    so they never sit there as dead chrome.
 *  - They are positioned OUTSIDE the scrolling track, not floating over it, so they can never cover
 *    a label — which was the failure mode the brief called out.
 *  - The selected child is scrolled fully into view whenever it changes, so switching buckets by any
 *    means (click, keyboard, programmatic) always leaves the active one visible.
 *  - Overflow state is recomputed from `scroll` and a ResizeObserver only. No polling, no rAF, no
 *    global listener; an idle strip costs nothing.
 *  - Native trackpad/wheel scrolling is untouched.
 */
export function ScrollStrip({
  children,
  activeSelector,
  label,
}: {
  children: ReactNode;
  /** CSS selector for the active child, scrolled into view when it changes. */
  activeSelector: string;
  label: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    // 1px tolerance: sub-pixel layout otherwise leaves a permanently "enabled" arrow at the end.
    setOverflow({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [measure]);

  // Keep the active bucket fully visible. `nearest` rather than `center` so an already-visible
  // bucket does not cause a pointless horizontal jump on every re-render.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const active = el.querySelector(activeSelector);
    if (!active) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    active.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest", inline: "nearest" });
  }, [activeSelector, children]);

  function page(direction: -1 | 1) {
    const el = trackRef.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Most of a screenful, keeping a sliver of context rather than a clean page break.
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.75), behavior: reduced ? "auto" : "smooth" });
  }

  /* Over the track's ends rather than beside them. In the flow they were 24px wide plus padding
   * even while disabled and invisible, so the first tab began 34px inside the page's gutter and the
   * strip sat visibly out of line with every other row on the page. Overlaying costs nothing when
   * there is nothing to scroll — disabled means transparent AND non-interactive — and when there is,
   * an arrow over a faded edge is what the fade is already saying. */
  const arrow =
    "absolute top-1/2 z-10 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md bg-[var(--z1-bg)] text-[13px] text-tertiary shadow-[0_0_10px_6px_var(--z1-bg)] transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.94] disabled:pointer-events-none disabled:opacity-0";

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        onClick={() => page(-1)}
        disabled={!overflow.left}
        aria-label={`Scroll ${label} left`}
        className={`${arrow} left-0`}
      >
        <span aria-hidden="true">‹</span>
      </button>

      <div
        ref={trackRef}
        // The fade stays, but only as a hint that the track continues — the arrows do the work.
        className={`flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-2 ${
          overflow.right ? "scroll-fade-x" : "scroll-fade-none"
        }`}
      >
        {children}
      </div>

      <button
        type="button"
        onClick={() => page(1)}
        disabled={!overflow.right}
        aria-label={`Scroll ${label} right`}
        className={`${arrow} right-0`}
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}
