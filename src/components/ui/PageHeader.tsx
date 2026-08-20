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
 */
export function PageHeader({
  title,
  description,
  actions,
  className = "",
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex flex-wrap items-start justify-between gap-x-6 gap-y-3 ${className}`}>
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-[70ch] text-[12.5px] leading-relaxed text-tertiary">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
