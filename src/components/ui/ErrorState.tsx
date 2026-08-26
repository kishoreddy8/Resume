"use client";

import type { ReactNode } from "react";
import { Disclosure } from "./Disclosure";
import { BTN_PRIMARY } from "./Panel";

/**
 * UI-2 — the one shared error-state contract (design audit: "no error.tsx, so a render throw drops
 * the user to an unstyled default with no landmark structure" — this is what fills that gap).
 *
 * The contract is fixed, not optional: what happened, what it affects (when actually known), what's
 * safe (only ever stated when genuinely known — never invented), and one honest next action.
 * Nothing here infers retryability, cause, or data safety on the caller's behalf — every field below
 * is opt-in and defaults to omitted, not to a guess.
 */
export function ErrorState({
  title,
  whatHappened,
  whatItAffects,
  whatIsSafe,
  onRetry,
  retryLabel = "Try again",
  secondaryAction,
  technicalDetails,
}: {
  title: string;
  whatHappened: ReactNode;
  /** Only rendered when the caller actually knows the scope of impact. */
  whatItAffects?: ReactNode;
  /** Only rendered when the caller can genuinely vouch for it — never assumed. */
  whatIsSafe?: ReactNode;
  /** Omit entirely when retrying is not known to be safe. */
  onRetry?: () => void;
  retryLabel?: string;
  secondaryAction?: ReactNode;
  /** Raw technical detail (error message, digest id) — always behind a disclosure, never shown by
   *  default, never a full stack trace. */
  technicalDetails?: ReactNode;
}) {
  return (
    <div role="alert" className="mx-auto flex max-w-[52ch] flex-col items-start gap-3 py-10">
      <h2 className="text-[19px] font-bold leading-snug text-primary">{title}</h2>
      <p className="text-[14px] leading-relaxed text-secondary">{whatHappened}</p>
      {whatItAffects && (
        <p className="text-[13px] leading-relaxed text-tertiary">
          <span className="font-semibold text-secondary">Affects: </span>
          {whatItAffects}
        </p>
      )}
      {whatIsSafe && (
        <p className="text-[13px] leading-relaxed text-tertiary">
          <span className="font-semibold text-secondary">Safe: </span>
          {whatIsSafe}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {onRetry && (
          <button type="button" onClick={onRetry} className={BTN_PRIMARY}>
            {retryLabel}
          </button>
        )}
        {secondaryAction}
      </div>
      {technicalDetails && (
        <Disclosure title="Technical details">
          <pre className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-tertiary">{technicalDetails}</pre>
        </Disclosure>
      )}
    </div>
  );
}
