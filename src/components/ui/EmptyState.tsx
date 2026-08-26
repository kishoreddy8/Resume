"use client";

import type { ReactNode } from "react";

/**
 * UI-1 — one shared, generic empty-state pattern (design audit §AG: "hand-rolled on Home;
 * EmptyState.tsx on Jobs; PanelEmpty; .admin-state" — four answers to the same question).
 *
 * Deliberately has no illustration of its own. `jobs/[id]/EmptyState.tsx`'s Aperture motif is that
 * screen's own visual signature, not a generic empty-state graphic every consumer should inherit —
 * it stays as-is. This primitive is for every OTHER empty state (Resume Studio, Profile sections,
 * Admin health — the coverage gaps the audit names), and accepts an optional icon slot rather than
 * assuming one.
 *
 * Every state still answers the audit's own three questions: what this area is, why it matters, the
 * one thing to do next — `title` + `description` + optional `action`.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className = "",
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center gap-2.5 px-6 py-10 text-center ${className}`}>
      {icon && (
        <span aria-hidden="true" className="grid h-11 w-11 place-items-center rounded-full bg-[var(--z0-bg)] text-tertiary">
          {icon}
        </span>
      )}
      <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-primary">{title}</h3>
      {description && <p className="max-w-[42ch] text-[13px] leading-relaxed text-tertiary">{description}</p>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}
