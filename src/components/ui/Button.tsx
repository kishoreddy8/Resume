"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { BTN_PRIMARY, BTN_SECONDARY, BTN_QUIET } from "./Panel";

/**
 * UI-1 — the one Button primitive, built on top of the class strings that already shipped
 * (`BTN_PRIMARY`/`BTN_SECONDARY`/`BTN_QUIET`) rather than replacing them. Existing consumers of
 * those raw strings are untouched; this is an ADDITIVE primitive for callers that want state
 * behaviour (loading/success) without hand-rolling it per page, which is the gap the design audit
 * found: "every async action does `setBusy(kind)` and swaps the label to 'Saving…' — no spinner, no
 * success confirmation."
 *
 * BRAND, NOT SUCCESS. Primary uses the indigo/brand family (`BTN_PRIMARY` already does — verified,
 * not changed here). Danger uses the semantic error role. Attention uses the semantic attention
 * role (Part 7's new, distinct-from-warning token). None of the four variants ever render in
 * `--success` green — green is reserved for the `success` STATE below, which is a different axis
 * (what the button currently reports), not a variant (what the button always means).
 *
 * NO FAKE SUCCESS. `state` is the caller's own async state, passed in — never inferred from a
 * timer, a mount effect, or any internal heuristic. A caller that never sets `state="success"`
 * never sees a checkmark.
 */

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "attention";
export type ButtonState = "idle" | "loading" | "success";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: BTN_PRIMARY,
  secondary: BTN_SECONDARY,
  quiet: BTN_QUIET,
  /* Same shape as BTN_SECONDARY (bordered, plane background) — a destructive action is not
   * automatically a solid-red button; the existing restraint (colour carries meaning, not alarm)
   * applies here too. Confirmation is the caller's responsibility, same as before this primitive
   * existed. */
  danger:
    "candidate-control inline-flex h-[42px] items-center justify-center gap-1.5 rounded-[10px] border border-[var(--error)] bg-[var(--z3-bg)] px-4 text-[13px] font-semibold text-[var(--error)] transition-[background-color,color,transform] duration-150 ease-out hover:bg-[var(--pill-red-bg)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
  attention:
    "candidate-control inline-flex h-[42px] items-center justify-center gap-1.5 rounded-[10px] border border-[var(--attention-border)] bg-[var(--attention-bg)] px-4 text-[13px] font-semibold text-[var(--attention-fg)] transition-[background-color,color,transform] duration-150 ease-out hover:brightness-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
};

/** A 14px ring that spins while genuinely loading. Respects the global reduced-motion rule in
 *  globals.css (which flattens all animation-duration to 0.01ms) automatically — nothing extra to
 *  wire here. */
function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-80"
    />
  );
}

function Check() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 fill-none stroke-current stroke-[2.25]">
      <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Button({
  variant = "primary",
  state = "idle",
  loadingLabel,
  successLabel,
  children,
  className = "",
  disabled,
  ...rest
}: {
  variant?: ButtonVariant;
  state?: ButtonState;
  /** Replaces the label while `state === "loading"`. Falls back to `children`. */
  loadingLabel?: ReactNode;
  /** Replaces the label while `state === "success"`. Falls back to `children`. */
  successLabel?: ReactNode;
  children: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  const label = state === "loading" ? (loadingLabel ?? children) : state === "success" ? (successLabel ?? children) : children;
  return (
    <button
      className={`${VARIANT_CLASS[variant]} ${className}`}
      disabled={disabled || state === "loading"}
      aria-busy={state === "loading" || undefined}
      {...rest}
    >
      {state === "loading" && <Spinner />}
      {state === "success" && <Check />}
      {label}
    </button>
  );
}
