"use client";

import type { ReactNode } from "react";

/**
 * A single number with its label — the atom every operations/dashboard surface needs.
 *
 * The rule that matters: a metric with no value renders an em dash, never 0. Across this codebase
 * "not measured" and "measured as zero" are different facts, and a dashboard that prints 0 for an
 * unmeasured counter is the most quietly misleading thing a status page can do.
 */
export function Metric({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  /** null/undefined renders an em dash. Pass a real 0 only when it is genuinely zero. */
  value: number | string | null | undefined;
  hint?: ReactNode;
  tone?: "default" | "success" | "attention" | "blocked" | "accent";
}) {
  const color =
    tone === "success"
      ? "text-[var(--success)]"
      : tone === "attention"
        ? "text-[var(--warning)]"
        : tone === "blocked"
          ? "text-[var(--error)]"
          : tone === "accent"
            ? "text-[var(--accent)]"
            : "text-primary";
  const shown = value === null || value === undefined ? "—" : typeof value === "number" ? value.toLocaleString() : value;
  return (
    <div className="min-w-0">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">{label}</div>
      <div className={`mt-1 truncate text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums ${color}`}>
        {shown}
      </div>
      {hint && <div className="mt-1 truncate text-[11px] text-tertiary">{hint}</div>}
    </div>
  );
}
