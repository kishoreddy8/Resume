"use client";

import type { ReactNode } from "react";

/**
 * Stage 2 — a plain <details>/<summary> disclosure.
 *
 * Native on purpose. The element is already keyboard operable, already exposes expanded/collapsed
 * state to assistive technology, works with the browser's own find-in-page, and needs no JavaScript,
 * no dependency and no gesture handling. A hand-rolled equivalent would only re-implement those
 * things worse.
 *
 * Nothing decision-critical is ever placed inside one of these: the verdict, its blocking reasons,
 * the sponsorship state and the critical gaps all render unconditionally. Disclosures hold
 * supporting depth, and `defaultOpen` keeps content visible by default wherever hiding it would
 * cost the reader something.
 */
export function Disclosure({
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Short right-aligned context (a count, a state) shown on the summary row. */
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-[13px] font-medium text-secondary transition-colors duration-150 ease-out hover:text-primary [&::-webkit-details-marker]:hidden">
        {/* Rotation is a 150ms transform on a 8px glyph — the global reduced-motion rule in
         *  globals.css collapses it to an instant state change. */}
        <span
          aria-hidden="true"
          className="inline-block text-[10px] leading-none text-tertiary transition-transform duration-150 ease-out group-open:rotate-90"
        >
          ▶
        </span>
        <span>{title}</span>
        {hint && <span className="ml-auto text-[11px] font-normal text-tertiary">{hint}</span>}
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}
