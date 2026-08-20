"use client";

import type { QueueNeighbours } from "../queue";

/**
 * Previous / Next through the visible queue.
 *
 * It moves the SAME selection state a row click moves, using the SAME array the arrow keys index —
 * see queue.ts. There is no second ordering, no neighbour request, and no payload change: the
 * titles shown in the previews are already in list state.
 *
 * Not a carousel. Selecting a neighbour is an instant state change; nothing slides, and the pane
 * resolves through the existing selection choreography exactly as a click would. Position is
 * printed as "12 of 200" so the control also answers "where am I in the queue?".
 */
export function JobQueueNav({
  nav,
  onSelect,
}: {
  nav: QueueNeighbours;
  onSelect: (id: number) => void;
}) {
  if (nav.index < 0) return null;

  const prev = nav.previous;
  const next = nav.next;

  return (
    <nav aria-label="Job queue navigation" className="flex items-center gap-2">
      <button
        type="button"
        disabled={!prev}
        onClick={() => prev && onSelect(prev.id)}
        aria-label={prev ? `Previous job: ${prev.title}` : "Previous job (none — this is the first)"}
        title={prev?.title}
        className="group flex min-w-0 max-w-[13rem] items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98] disabled:pointer-events-none disabled:opacity-35"
      >
        <span aria-hidden="true" className="shrink-0 text-tertiary group-hover:text-primary">
          ‹
        </span>
        <span className="truncate">{prev ? prev.title : "First"}</span>
      </button>

      {/* Position is text, never a dot strip — 200 dots is not a control. */}
      <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-tertiary">
        {nav.index + 1} of {nav.total}
      </span>

      <button
        type="button"
        disabled={!next}
        onClick={() => next && onSelect(next.id)}
        aria-label={next ? `Next job: ${next.title}` : "Next job (none — this is the last)"}
        title={next?.title}
        className="group flex min-w-0 max-w-[13rem] items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98] disabled:pointer-events-none disabled:opacity-35"
      >
        <span className="truncate">{next ? next.title : "Last"}</span>
        <span aria-hidden="true" className="shrink-0 text-tertiary group-hover:text-primary">
          ›
        </span>
      </button>
    </nav>
  );
}
