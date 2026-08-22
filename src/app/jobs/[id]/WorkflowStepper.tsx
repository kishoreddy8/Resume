"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheckCircle } from "@/components/icons";
import { isStepNavigable, type StepKey, type WorkflowStep } from "./workflowSteps";

/**
 * The workspace's five-step navigation.
 *
 * IT IS NAVIGATION, NOT A PROGRESS BAR. Each node is a real destination, and pressing one changes
 * which step's body is rendered — it never starts anything, and it never advances the workflow.
 * The engine advances the workflow; this only shows where it stands and lets you look around.
 *
 * A LOCKED STEP SAYS WHY. It is rendered disabled with its reason as the accessible description
 * rather than hidden, because a step you cannot see is indistinguishable from one that does not
 * exist — and the reason ("there is no resume to validate yet") is the most useful thing on the
 * screen for someone wondering what to do next.
 *
 * STATE IS NEVER COLOUR ALONE: every node carries a number or a tick, its label, and a spoken
 * state, so it reads identically in greyscale.
 *
 * DISCOVERABLE AT 390px. Below the point where five labels stop fitting, the track scrolls rather
 * than wrapping into five stacked boxes — but a bare `overflow-x-auto` only says "there is more" to
 * someone who happens to swipe it, so a mouse-only visitor at narrow widths could not reach
 * Validation or Application at all. This mirrors ScrollStrip's fix for the same failure mode on the
 * job bucket tabs (src/app/jobs/ScrollStrip.tsx): a fade edge that appears only when there is
 * genuinely more to see, plus real arrow controls outside the track. Kept local rather than reusing
 * ScrollStrip directly, since that component's track is a fixed-height `<div>` tuned for bucket
 * chips — this stepper needs its own `<ol>`/`<li>` structure and 60px row height.
 */

const STATE_WORD: Record<WorkflowStep["state"], string> = {
  done: "completed",
  current: "current step",
  available: "available",
  locked: "locked",
  blocked: "blocked",
};

export function WorkflowStepper({
  steps,
  active,
  onSelect,
}: {
  steps: WorkflowStep[];
  active: StepKey;
  onSelect: (key: StepKey) => void;
}) {
  const trackRef = useRef<HTMLOListElement>(null);
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

  // The active step is kept fully in view whenever it changes, so switching steps by any means
  // (click, keyboard, the engine advancing the workflow) always leaves the current one visible.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const current = el.querySelector<HTMLElement>("[data-step-active='true']");
    if (!current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    current.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest", inline: "nearest" });
  }, [active]);

  function page(direction: -1 | 1) {
    const el = trackRef.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.75), behavior: reduced ? "auto" : "smooth" });
  }

  const arrow =
    "group absolute top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center text-[13px] text-tertiary active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-0";
  const arrowVisual =
    "grid h-7 w-7 place-items-center rounded-md bg-[var(--z3-bg)] shadow-[0_0_10px_6px_var(--z3-bg)] transition-colors duration-150 ease-out group-hover:bg-[var(--surface-hover)] group-hover:text-primary";

  return (
    <nav
      aria-label="Job workflow"
      className="relative rounded-[20px] border border-[var(--border)] bg-[var(--z3-bg)] px-2.5 shadow-[var(--lift-1)]"
    >
      {/* Arrows overlay the track's ends rather than sitting beside it, so they cost nothing when
       *  there is nothing to scroll (disabled means transparent and non-interactive) and never push
       *  the first step out of line with the rest of the page. */}
      <button
        type="button"
        onClick={() => page(-1)}
        disabled={!overflow.left}
        aria-label="Scroll workflow steps left"
        className={`${arrow} left-1`}
      >
        <span aria-hidden="true" className={arrowVisual}>‹</span>
      </button>

      <ol
        ref={trackRef}
        className={`flex h-[72px] items-stretch gap-1.5 overflow-x-auto ${overflow.right ? "scroll-fade-x" : "scroll-fade-none"}`}
      >
        {steps.map((step, i) => {
          const navigable = isStepNavigable(step);
          const isActive = step.key === active;
          const done = step.state === "done";
          const blocked = step.state === "blocked";

          const tone = isActive
            ? "text-[var(--accent)]"
            : done
              ? "text-[var(--pill-success-fg)]"
              : blocked
                ? "text-[var(--error)]"
                : navigable
                  ? "text-secondary"
                  : "text-tertiary";

          return (
            <li key={step.key} className="flex min-w-0 shrink-0 items-center">
              {/* `relative` is load-bearing: the sr-only spans below are position:absolute, and
               *  without a positioned ancestor their containing block becomes the viewport rather
               *  than this button. They then escape the row's overflow-x clip, sit at the far end
               *  of the scrolled track, and drag the whole document into horizontal scroll — which
               *  is exactly what they did at 390px. */}
              <button
                type="button"
                onClick={() => navigable && onSelect(step.key)}
                disabled={!navigable}
                aria-current={isActive ? "step" : undefined}
                aria-describedby={step.lockedReason ? `step-reason-${step.key}` : undefined}
                title={step.lockedReason ?? undefined}
                data-step-active={isActive ? "true" : undefined}
                className={`relative my-2 flex min-h-11 items-center gap-2.5 rounded-[13px] border px-3.5 text-[14px] font-semibold transition-[background-color,border-color,box-shadow] duration-150 ease-out ${tone} ${
                  isActive ? "border-[color-mix(in_oklab,var(--accent)_26%,transparent)] bg-[var(--accent-tint)] shadow-[0_4px_14px_color-mix(in_oklab,var(--accent)_10%,transparent)]" : navigable ? "border-transparent hover:bg-[var(--surface-hover)]" : "cursor-not-allowed border-transparent"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-bold ${
                    done
                      ? "bg-[var(--pill-success-bg)] text-[var(--pill-success-fg)]"
                      : isActive
                        ? "bg-[var(--accent)] text-white"
                        : blocked
                          ? "bg-[color-mix(in_oklab,var(--error)_12%,transparent)] text-[var(--error)]"
                          : "bg-[var(--chip-bg)] text-[var(--chip-text)]"
                  }`}
                >
                  {done ? <IconCheckCircle size={15} /> : i + 1}
                </span>
                <span className="whitespace-nowrap">{step.label}</span>
                {/* The state in words, for anything that cannot see the colour or the fill. */}
                <span className="sr-only">{` — ${STATE_WORD[step.state]}`}</span>
                {step.lockedReason && (
                  <span id={`step-reason-${step.key}`} className="sr-only">
                    {step.lockedReason}
                  </span>
                )}
              </button>

              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`mx-0.5 h-px w-5 shrink-0 ${
                    steps[i + 1]!.state === "done" || done ? "bg-[var(--pill-success-fg)]/40" : "bg-[var(--border)]"
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        onClick={() => page(1)}
        disabled={!overflow.right}
        aria-label="Scroll workflow steps right"
        className={`${arrow} right-1`}
      >
        <span aria-hidden="true" className={arrowVisual}>›</span>
      </button>
    </nav>
  );
}
