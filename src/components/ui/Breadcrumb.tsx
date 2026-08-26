"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * UI-2 — one reusable breadcrumb primitive, for laptop/desktop contextual navigation on the routes
 * where hierarchy genuinely helps (the design direction's own examples: Jobs → a job, Applications
 * → an application, Profile → Reusable Answers, Admin → System Health). Not mechanically added to
 * every route — a route earns one when it sits two or more levels below a real list/section.
 *
 * NOT YET CONSUMED ANYWHERE. Both current candidate detail routes (`/jobs/[id]`, `/applications/[id]`)
 * are thin server-component shells over large client components (`JobWorkspace`, `ApplicationDetail`)
 * that fetch their own title data internally; giving the shell a real (non-placeholder) label here
 * would mean either a second, duplicate data fetch at the route level or editing one of those large
 * components — both are exactly the "no redesign" boundary this phase does not cross. Wiring this
 * in with a REAL label is left to whichever future phase already touches that component's data flow
 * (UI-J for Jobs, the Applications phase for Applications). The primitive itself is complete and
 * tested now so that phase does not have to build it from scratch.
 */
export interface BreadcrumbItem {
  label: string;
  /** Omit on the final (current) item — it renders as plain text with aria-current, never a link. */
  href?: string;
}

export function Breadcrumb({ items, className = "" }: { items: BreadcrumbItem[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={`min-w-0 ${className}`}>
      <ol className="flex min-w-0 list-none items-center gap-1.5 p-0 text-[13px]">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && (
                <span aria-hidden="true" className="shrink-0 text-tertiary">
                  /
                </span>
              )}
              <Crumb item={item} current={isLast} />
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Crumb({ item, current }: { item: BreadcrumbItem; current: boolean }): ReactNode {
  /* Truncates visually (long job/company titles) while the screen-reader label stays whole —
   * `title` carries the full text for a sighted mouse user who hovers a clipped label. */
  const labelClass = "block max-w-[28ch] truncate";

  if (current || !item.href) {
    return (
      <span aria-current={current ? "page" : undefined} title={item.label} className={`${labelClass} font-semibold text-primary`}>
        {item.label}
      </span>
    );
  }
  return (
    <Link href={item.href} title={item.label} className={`${labelClass} text-secondary underline-offset-2 hover:text-primary hover:underline`}>
      {item.label}
    </Link>
  );
}
