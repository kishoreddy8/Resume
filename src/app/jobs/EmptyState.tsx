"use client";

import type { ReactNode } from "react";
import { Aperture } from "./Aperture";

/**
 * Empty states, in the same spatial language as the rest of the workspace.
 *
 * The graphic is the shared Aperture motif with nothing in focus. It is decoration
 * and says so: `aria-hidden`, no axes, no bars, no implied measurement. That
 * restriction is the point. A chart-shaped emptiness graphic would suggest data
 * exists at zero, when the truthful statement is that the query matched nothing.
 *
 * Every state names what would change the outcome, because an empty list whose
 * only message is "nothing here" leaves the user without a next move.
 */

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center px-8 py-12 text-center">
      <Aperture />
      <h3 className="mt-5 text-[15px] font-semibold tracking-[-0.01em] text-primary">{title}</h3>
      <p className="mt-1.5 max-w-[34ch] text-[12.5px] leading-relaxed text-tertiary">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
