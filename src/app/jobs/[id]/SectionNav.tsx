"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Sticky section navigator for the command center.
 *
 * Active tracking is one IntersectionObserver over the section elements — no scroll listener, no
 * polling, no rAF. The observer fires only when a section boundary crosses the root margin, so an
 * idle pane costs nothing.
 *
 * Deliberately NOT a router: clicking scrolls within the pane. Changing the URL per section would
 * put six history entries between the user and the job they came from.
 *
 * `scroll-margin-top` on each target keeps the heading clear of this sticky bar, so a keyboard user
 * who tabs into a section never lands underneath it (WCAG 2.2 Focus Not Obscured).
 */

export interface SectionDef {
  id: string;
  label: string;
}

export function SectionNav({
  sections,
  scrollRoot,
}: {
  sections: SectionDef[];
  /** The scrolling ancestor — the pane in Workbench mode, the viewport on the standalone route. */
  scrollRoot?: HTMLElement | null;
}) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const els = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    // Top-biased root margin: a section counts as current once its heading reaches the upper
    // quarter, which matches how people read rather than when a section merely becomes visible.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { root: scrollRoot ?? null, rootMargin: "-72px 0px -65% 0px", threshold: 0 }
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sections, scrollRoot]);

  function go(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    setActive(id);
  }

  return (
    <nav
      ref={navRef}
      aria-label="Job sections"
      className="sticky top-0 z-10 -mx-5 border-b border-[var(--separator)] bg-[var(--z3-bg)]/92 px-5 backdrop-blur-sm"
    >
      <ul className="scroll-fade-x flex gap-0.5 overflow-x-auto py-1.5">
        {sections.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => go(s.id)}
              aria-current={active === s.id ? "true" : undefined}
              className={`whitespace-nowrap rounded-[7px] px-2 py-1 text-[11.5px] transition-colors duration-150 ease-out active:scale-[0.98] ${
                active === s.id
                  ? "bg-[var(--z0-bg)] font-semibold text-primary shadow-[inset_0_1px_2px_var(--edge-lo)]"
                  : "text-tertiary hover:text-primary"
              }`}
            >
              {s.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
