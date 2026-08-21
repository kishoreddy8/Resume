"use client";

import type { ReactNode } from "react";

/**
 * The Job Workspace's card language.
 *
 * DELIBERATELY FLATTER AND TIGHTER THAN THE HOME SCREEN. Home has four numbers and a hero; this
 * page has up to five columns of evidence that a person reads across. So the border is lighter, the
 * shadow is close to nothing, the padding is 16-18px rather than 20-28, and the type sits a step
 * down. Reusing the home card here made a workflow page look like a dashboard.
 *
 * Everything below is presentation only — no component in this file reads state, fetches, or
 * decides anything.
 */

export const WS_CARD =
  "rounded-[12px] border border-[#E8EAF0] bg-[var(--z3-bg)] shadow-[0_2px_8px_rgba(40,43,75,0.035)] dark:border-[var(--border)]";

/** A column in a step's horizontal grid. `stretch` keeps a row of cards visually aligned. */
export function WsCard({
  title,
  hint,
  children,
  tone = "plain",
  className = "",
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
  /** `warm` is the emphasis card the reference gives a cream ground. */
  tone?: "plain" | "warm";
  className?: string;
}) {
  const ground =
    tone === "warm"
      ? "rounded-[12px] border border-[#F0E6D2] bg-[#FFF9EE] shadow-[0_2px_8px_rgba(40,43,75,0.035)] dark:border-[var(--border)] dark:bg-[color-mix(in_oklab,var(--warning)_8%,var(--z3-bg))]"
      : WS_CARD;
  return (
    <section className={`${ground} flex min-w-0 flex-col p-4 ${className}`}>
      {title && <h3 className="text-[13px] font-bold leading-snug text-primary">{title}</h3>}
      {hint && <p className="mt-1 text-[11.5px] leading-relaxed text-tertiary">{hint}</p>}
      <div className={title || hint ? "mt-3" : ""}>{children}</div>
    </section>
  );
}

/** The small uppercase label above a step's grid. Not a page heading. */
export function StepSectionHeading({ title, blurb }: { title: string; blurb?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-[13.5px] font-bold tracking-[-0.005em] text-primary">{title}</h2>
      {blurb && <p className="mt-0.5 text-[12px] leading-relaxed text-tertiary">{blurb}</p>}
    </div>
  );
}

export type ChipTone = "evidence" | "neutral" | "brand" | "warn";

const CHIP_TONE: Record<ChipTone, string> = {
  evidence: "bg-[var(--pill-success-bg)] text-[var(--pill-success-fg)]",
  neutral: "bg-[#F3F4F7] text-[var(--chip-text)] dark:bg-[var(--chip-bg)]",
  brand: "bg-[var(--accent-tint)] text-[var(--accent)]",
  warn: "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]",
};

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: ChipTone }) {
  return (
    <span
      className={`inline-flex h-[23px] max-w-full items-center truncate rounded-full px-2 text-[11px] font-medium ${CHIP_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * One evidence row: what it is on the left, how well it is supported on the right.
 *
 * The strength word is always present — the dot repeats it, it never replaces it — so the row reads
 * the same in greyscale and to a screen reader.
 */
export function EvidenceRow({
  label,
  strength,
  tone,
}: {
  label: string;
  strength: string;
  tone: "strong" | "partial" | "none";
}) {
  const dot =
    tone === "strong"
      ? "bg-[var(--pill-success-fg)]"
      : tone === "partial"
        ? "bg-[var(--pill-amber-fg)]"
        : "bg-[var(--border-control)]";
  const text =
    tone === "strong"
      ? "text-[var(--pill-success-fg)]"
      : tone === "partial"
        ? "text-[var(--pill-amber-fg)]"
        : "text-tertiary";
  return (
    <li className="flex items-center justify-between gap-2 py-[5px]">
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="truncate text-[12.5px] text-primary">{label}</span>
      </span>
      <span className={`shrink-0 text-[11px] font-medium ${text}`}>{strength}</span>
    </li>
  );
}

/** A fact with a value on the right — the Application Info pattern. */
export function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-[5px]">
      <span className="shrink-0 text-[12px] text-tertiary">{label}</span>
      <span className="min-w-0 truncate text-right text-[12.5px] font-medium text-primary">{value}</span>
    </li>
  );
}

/** A short bulleted fact. Used by Key Strengths and Reason for Changes. */
export function BulletRow({ children, tick = false }: { children: ReactNode; tick?: boolean }) {
  return (
    <li className="flex items-start gap-2 py-[5px]">
      <span
        aria-hidden="true"
        className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${tick ? "bg-[var(--pill-success-fg)]" : "bg-[var(--accent)]"}`}
      />
      <span className="text-[12.5px] leading-relaxed text-secondary">{children}</span>
    </li>
  );
}

/** Said when a card genuinely has nothing to show. Never padded with an example. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-[12px] leading-relaxed text-tertiary">{children}</p>;
}
