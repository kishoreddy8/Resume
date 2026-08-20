"use client";

import type { ReactNode } from "react";

/**
 * Semantic status, expressed the way the whole application already expresses it in Jobs:
 * a glyph whose SHAPE carries meaning, plus the word. Never colour alone.
 *
 * `unknown` is deliberately a hollow dashed ring rather than a dim filled dot, because across this
 * codebase "we don't know" is a first-class state that must never be mistaken for a weak positive
 * or folded into a negative. Every page that shows status gets that distinction for free.
 */
export type StatusTone = "ready" | "attention" | "blocked" | "neutral" | "unknown" | "active";

const DOT: Record<StatusTone, string> = {
  ready: "bg-[var(--success)] shadow-[0_0_7px_var(--success)]",
  attention: "bg-[var(--warning)]",
  blocked: "bg-[var(--error)] shadow-[0_0_7px_var(--error)]",
  active: "bg-[var(--accent)] shadow-[0_0_8px_var(--accent)]",
  /* --separator is 7% alpha — as a 6px dot on a white plane it was invisible, which made every
   * inactive node in a flow rail disappear rather than read as "not reached yet". */
  neutral: "bg-[var(--text-tertiary)] opacity-45",
  unknown: "bg-transparent ring-1 ring-inset ring-[var(--border)]",
};

const TEXT: Record<StatusTone, string> = {
  ready: "text-[var(--success)]",
  attention: "text-[var(--warning)]",
  blocked: "text-[var(--error)]",
  active: "text-[var(--accent)]",
  neutral: "text-secondary",
  unknown: "text-tertiary",
};

export function StatusDot({ tone, className = "" }: { tone: StatusTone; className?: string }) {
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]} ${className}`} />;
}

export function Status({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <StatusDot tone={tone} />
      <span className={`text-[12px] font-medium ${TEXT[tone]}`}>{children}</span>
    </span>
  );
}
