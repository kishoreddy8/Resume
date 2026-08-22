"use client";

import type { ReactNode } from "react";

/**
 * The panel vocabulary shared by Profile, Resume Studio and Settings.
 *
 * These three routes each arrived at their own card: Profile had none at all (it was a redirect to
 * a form), Resume Studio inherited the Candidate Intelligence surfaces, and Settings used Surface
 * z3 with 9.5px uppercase headings. Three routes with three answers to "what is a section" is how a
 * product stops feeling like one product, so there is now one answer and the routes spend their
 * design budget on what is actually different about them.
 *
 * WHY NOT `Surface`. Surface models depth planes for the workspace — a row that lifts on selection,
 * a popover that emerges from its trigger. These routes are read-and-edit surfaces with no depth
 * story: one plane, one border, one radius. Using Surface here would import a z-index vocabulary
 * that none of these pages needs.
 *
 * Every value renderer below has a defined empty state. A panel that silently renders nothing for a
 * missing field produces a blank line the reader has to interpret, and "no value" and "value we
 * failed to load" look identical. `FieldRow` says "Not set" instead.
 */

export const PANEL_SURFACE =
  "candidate-panel rounded-[16px] border border-[var(--border)] bg-[var(--z3-bg)] shadow-[var(--lift-1)]";

export function Panel({
  title,
  description,
  actions,
  children,
  className = "",
  id,
  compact = false,
  icon,
  as: Tag = "section",
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  /** Denser padding and a smaller title, for a card in a four-across row. */
  compact?: boolean;
  icon?: ReactNode;
  as?: "section" | "div";
}) {
  return (
    <Tag id={id} className={`${PANEL_SURFACE} ${compact ? "candidate-panel-compact p-5" : "p-5 sm:p-6"} ${className}`}>
      {(title || actions) && (
        <div className={`flex items-start justify-between gap-x-3 ${compact ? "mb-3" : "mb-3.5"}`}>
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            {icon && (
              <span
                aria-hidden="true"
                className="mt-px grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[9px] bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]"
              >
                {icon}
              </span>
            )}
            <div className="min-w-0 flex-1">
            {title && (
              <h2
                className={`candidate-card-title font-bold leading-snug tracking-[-0.015em] text-primary ${compact ? "text-[17px]" : "text-[18px]"}`}
              >
                {title}
              </h2>
            )}
            {description && (
              <p className="candidate-body mt-1.5 max-w-[62ch] text-[14px] leading-6 text-tertiary">{description}</p>
            )}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}

/**
 * One label/value pair.
 *
 * `value` is deliberately `ReactNode | null | undefined` rather than `string`: a caller that has
 * nothing passes null and gets the empty treatment, instead of passing "" or "—" and inventing its
 * own. The label column is fixed so a stack of rows aligns without a table.
 */
export function FieldRow({
  label,
  value,
  hint,
  action,
}: {
  label: string;
  value: ReactNode | null | undefined;
  hint?: string;
  action?: ReactNode;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-[var(--separator)] py-2.5 last:border-b-0">
      <dt className="candidate-metadata w-[190px] shrink-0 text-[13px] font-semibold leading-snug text-secondary">{label}</dt>
      <dd className="candidate-body min-w-0 flex-1 text-[14px] leading-6 text-primary">
        {empty ? <span className="text-tertiary">Not set</span> : value}
        {hint && <p className="candidate-metadata mt-1 text-[13px] leading-5 text-tertiary">{hint}</p>}
      </dd>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A dl wrapper, so a run of FieldRows is a real description list rather than styled divs. */
export function FieldList({ children }: { children: ReactNode }) {
  return <dl className="flex flex-col">{children}</dl>;
}

/** What a panel says when it genuinely has nothing. Never a bare dash. */
export function PanelEmpty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2.5 rounded-[10px] bg-[var(--z0-bg)] px-4 py-3.5">
      <p className="candidate-body text-[14px] leading-6 text-tertiary">{children}</p>
      {action}
    </div>
  );
}

/** Neutral count/label pair for a summary strip. Renders the number even when it is zero — a zero
 *  is a fact, and hiding it would make the strip's shape depend on the data. */
export function StatTile({
  value,
  label,
  hint,
  tone = "neutral",
  icon,
}: {
  value: ReactNode;
  label: string;
  hint?: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "info";
  icon?: ReactNode;
}) {
  const tint = {
    neutral: "bg-[var(--z0-bg)] text-secondary",
    accent: "bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]",
    success: "bg-[var(--tile-green-bg)] text-[var(--tile-green-fg)]",
    warning: "bg-[var(--tile-amber-bg)] text-[var(--tile-amber-fg)]",
    info: "bg-[var(--tile-blue-bg)] text-[var(--tile-blue-fg)]",
  }[tone];
  return (
    <div className={`${PANEL_SURFACE} flex min-w-0 flex-col justify-between px-4 py-4`}>
      {icon && <span className={`mb-3 grid h-9 w-9 place-items-center rounded-[10px] ${tint}`}>{icon}</span>}
      <div className="text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums text-primary">{value}</div>
      <div className="candidate-metadata mt-2 text-[13px] font-semibold leading-snug text-primary">{label}</div>
      {hint && <div className="candidate-metadata mt-1 text-[11.5px] leading-relaxed text-tertiary">{hint}</div>}
    </div>
  );
}

export type PillTone = "success" | "warning" | "info" | "danger" | "neutral";

const PILL_TONE: Record<PillTone, string> = {
  success: "bg-[var(--pill-success-bg)] text-[var(--pill-success-fg)]",
  warning: "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]",
  info: "bg-[var(--pill-blue-bg)] text-[var(--pill-blue-fg)]",
  danger: "bg-[var(--pill-red-bg)] text-[var(--pill-red-fg)]",
  neutral: "bg-[var(--z0-bg)] text-secondary",
};

/** A state, as a word in a tint. The word is always present — the tint never carries it alone. */
export function Pill({ tone = "neutral", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span
      className={`candidate-badge inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/** Small square tag for a fact with no state attached — a technology, a platform. */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[24px] items-center rounded-[7px] bg-[var(--z0-bg)] px-2 text-[12px] text-secondary">
      {children}
    </span>
  );
}

export const BTN_PRIMARY =
  "candidate-control inline-flex h-[42px] items-center justify-center gap-1.5 rounded-[10px] bg-[var(--accent)] px-4 text-[13px] font-semibold text-[var(--accent-fg)] shadow-[var(--lift-1),inset_0_1px_0_rgba(255,255,255,0.22)] transition-[background-color,transform,box-shadow] duration-150 ease-out hover:bg-[var(--accent-hover)] hover:shadow-[var(--lift-2)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

export const BTN_SECONDARY =
  "candidate-control inline-flex h-[42px] items-center justify-center gap-1.5 rounded-[10px] border border-[var(--border-control)] bg-[var(--z3-bg)] px-4 text-[13px] font-semibold text-secondary transition-[background-color,color,transform] duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

export const BTN_QUIET =
  "candidate-control inline-flex h-[38px] items-center justify-center gap-1.5 rounded-[9px] px-3 text-[13px] font-medium text-secondary transition-[background-color,color,transform] duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98]";

export const INPUT =
  "candidate-input h-[42px] w-full rounded-[10px] border border-[var(--border-control)] bg-[var(--z3-bg)] px-3 text-[13.5px] text-primary outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-tertiary focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-soft)]";
