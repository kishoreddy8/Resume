"use client";

import type { ReactNode } from "react";

/**
 * One page header for every route.
 *
 * Pages were each inventing their own title treatment — different sizes, different weights,
 * different gaps, some with a description and some without — so moving between routes felt like
 * moving between products. This is the same typographic contract the Jobs toolbar established.
 *
 * `title` renders the page's single h1. Routes that put their title in the application toolbar
 * (Jobs does) should not also use this, or the document gets two competing top-level headings.
 *
 * `size="lg"` is the destination-page treatment — Applications, Resume Studio, Profile, Settings.
 * These are places you arrive at and read, not workspaces you operate, so the title carries more
 * weight than the workspace routes' 26px. It steps down at 390px, where 32px would take three lines
 * for "Applications" and push the first real content below the fold.
 */
export function PageHeader({
  title,
  description,
  actions,
  size = "md",
  className = "",
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  size?: "md" | "lg";
  className?: string;
}) {
  const lg = size === "lg";
  return (
    <header className={`flex flex-wrap items-start justify-between gap-x-6 gap-y-3 ${className}`}>
      <div className="min-w-0">
        <h1
          className={
            lg
              ? "candidate-page-title text-[27px] font-bold leading-[1.15] tracking-[-0.022em] text-primary sm:text-[32px]"
              : "candidate-page-title page-title"
          }
        >
          {title}
        </h1>
        {description && (
          <p
            className={`candidate-page-description mt-2 max-w-[70ch] leading-relaxed text-tertiary ${lg ? "text-[13.5px]" : "text-[12.5px]"}`}
          >
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
