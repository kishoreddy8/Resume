/**
 * The visible job queue — one ordered list, shared by every way of moving through it.
 *
 * There are three ways to change the selected job (click a row, Previous/Next, arrow keys) and the
 * brief's hard requirement is that all three select from the SAME ordering. So neighbours are never
 * recomputed: whichever list is mounted reports the exact array it already rendered — the same
 * `renderedJobs` the keyboard handler indexes into, which is Stage 33's `compareJobsBestFirst`
 * order after filters and the render cap.
 *
 * That means Previous/Next inherits ranking, filter semantics and the Show More cap for free, and
 * cannot drift from the list. It also costs nothing: the array already exists, and titles are
 * already in list state, so the previews need no request and no payload change.
 */
export interface QueueItem {
  id: number;
  title: string;
}

export interface QueueNeighbours {
  index: number;
  total: number;
  previous: QueueItem | null;
  next: QueueItem | null;
}

/** Pure lookup. Returns an empty position when the selection is not in the visible queue —
 *  which happens legitimately while a new filter's results are still arriving. */
export function neighbours(queue: QueueItem[], selectedId: number | null): QueueNeighbours {
  const index = selectedId === null ? -1 : queue.findIndex((q) => q.id === selectedId);
  if (index < 0) return { index: -1, total: queue.length, previous: null, next: null };
  return {
    index,
    total: queue.length,
    previous: index > 0 ? queue[index - 1] : null,
    next: index < queue.length - 1 ? queue[index + 1] : null,
  };
}
