"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { JobReview } from "./[id]/JobReview";

/**
 * WORKBENCH PHASE 1 — the Jobs workspace as a master/detail pair.
 *
 * The list stays mounted and keeps its scroll position while the pane beside it swaps to whichever
 * job is selected, so reviewing forty jobs is one continuous motion instead of forty navigations.
 *
 * Motion budget, deliberately small. The frequency rule says the interactions people repeat all day
 * must be instant, so row selection, arrow-key traversal, scrolling, filtering and the rows
 * themselves carry no animation at all. What does animate: the identity block when the selected job
 * changes, the narrow-screen sheet, and one shared accent bar in the list. That is the whole budget.
 *
 * The divider is direct manipulation — it tracks the pointer 1:1 with no spring and no easing,
 * because the width *is* the interaction and any smoothing would read as lag.
 */

/** Pane width as a percentage of the workspace. Kept inside a band that leaves both panes usable. */
const MIN_DETAIL_PCT = 32;
const MAX_DETAIL_PCT = 58;
const DEFAULT_DETAIL_PCT = 42;

function useIsWide() {
  // Derived boolean rather than a raw width subscription, so a resize only re-renders when the
  // layout actually changes category.
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1100px)");
    const apply = () => setWide(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return wide;
}

/**
 * The detail pane body. Keyed by job id so a new selection mounts fresh — which also guarantees the
 * previous job's pollers and in-flight requests are torn down rather than racing the new ones.
 */
function ReviewPane({
  jobId,
  reduced,
  onClose,
}: {
  jobId: number;
  reduced: boolean;
  onClose?: () => void;
}) {
  return (
    <motion.div
      key={jobId}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      // Near-critically damped and short. The user can select another job mid-flight; Motion
      // retargets from the current value rather than restarting.
      transition={reduced ? { duration: 0.1 } : { type: "spring", duration: 0.22, bounce: 0 }}
    >
      <JobReview jobId={jobId} layout="pane" onClose={onClose} />
    </motion.div>
  );
}

export function Workbench({
  list,
  selectedJobId,
}: {
  /** The master list for this view. All Jobs and For You each supply their own; everything to the
   *  right of it — pane, divider, sheet, motion, request debounce — is shared. */
  list: ReactNode;
  selectedJobId: number | null;
}) {
  const wide = useIsWide();
  const reduced = useReducedMotion() ?? false;
  const [detailPct, setDetailPct] = useState(DEFAULT_DETAIL_PCT);
  const [dragging, setDragging] = useState(false);
  // Narrow screens show the list first. The sheet opens only when a person actually picks a row —
  // never from the list's programmatic "keep a selection in view" fallback, which would otherwise
  // cover the list with a job nobody asked for the moment the page loaded.
  const [sheetOpen, setSheetOpen] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);

  /**
   * Selection is applied immediately so the row highlights with zero delay; only the *detail load*
   * is deferred, and only long enough to skip the jobs you fly past while holding an arrow key.
   * This is a 12-line guard, not a cache: no store, no eviction, no request bookkeeping.
   */
  const [committedId, setCommittedId] = useState<number | null>(selectedJobId);
  useEffect(() => {
    if (selectedJobId === committedId) return;
    const t = setTimeout(() => setCommittedId(selectedJobId), 140);
    return () => clearTimeout(t);
  }, [selectedJobId, committedId]);

  const onDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onDividerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging || !frameRef.current) return;
      const r = frameRef.current.getBoundingClientRect();
      const pct = ((r.right - e.clientX) / r.width) * 100;
      setDetailPct(Math.min(MAX_DETAIL_PCT, Math.max(MIN_DETAIL_PCT, pct)));
    },
    [dragging]
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).hasPointerCapture?.(e.pointerId)) {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  }, []);

  /** Keyboard equivalent for the divider, so resizing is not pointer-only. */
  function onDividerKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setDetailPct((p) =>
      Math.min(MAX_DETAIL_PCT, Math.max(MIN_DETAIL_PCT, p + (e.key === "ArrowLeft" ? 2 : -2)))
    );
  }

  // Escape closes the narrow-screen sheet. Always available alongside the visible Close button.
  useEffect(() => {
    if (wide || !sheetOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSheetOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide, sheetOpen]);

  const openSheetOnRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[role="option"]')) setSheetOpen(true);
  };

  const closeSheet = useCallback(() => setSheetOpen(false), []);

  // ---- Narrow: list first, selected job as a spring-settled sheet over it ----
  if (!wide) {
    return (
      <div
        onClick={openSheetOnRowClick}
        className="h-[calc(100dvh-10rem)] min-h-[420px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface"
      >
        {list}
        <AnimatePresence>
          {sheetOpen && selectedJobId !== null && (
            <>
              <motion.div
                className="fixed inset-0 z-40 bg-black/25"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
                onClick={closeSheet}
              />
              <motion.aside
                role="dialog"
                aria-modal="true"
                aria-label="Job review"
                className="fixed inset-y-0 right-0 z-50 w-full max-w-[min(560px,92vw)] overflow-y-auto border-l border-[var(--border)] bg-surface shadow-[var(--shadow-md)]"
                initial={reduced ? { opacity: 0 } : { x: "100%" }}
                animate={reduced ? { opacity: 1 } : { x: 0 }}
                exit={reduced ? { opacity: 0 } : { x: "100%" }}
                transition={
                  reduced
                    ? { duration: 0.12 }
                    : { type: "spring", duration: 0.42, bounce: 0.12 }
                }
                // Drag-to-close is an optional accelerator; Close and Escape remain the primary
                // ways out. Velocity is honoured so a flick dismisses without a long drag.
                drag={reduced ? false : "x"}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={{ left: 0, right: 0.5 }}
                onDragEnd={(_, info) => {
                  if (info.offset.x > 120 || info.velocity.x > 500) closeSheet();
                }}
              >
                <ReviewPane jobId={selectedJobId} reduced={reduced} onClose={closeSheet} />
              </motion.aside>
            </>
          )}
        </AnimatePresence>
      </div>
    );
  }

  // ---- Wide: three panes (the app rail is the shell's; these are list | divider | detail) ----
  return (
    <div
      ref={frameRef}
      className="flex h-[calc(100dvh-10rem)] min-h-[480px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface"
      style={dragging ? { cursor: "col-resize", userSelect: "none" } : undefined}
    >
      <div className="min-w-0 flex-1">{list}</div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize job review pane"
        aria-valuenow={Math.round(detailPct)}
        aria-valuemin={MIN_DETAIL_PCT}
        aria-valuemax={MAX_DETAIL_PCT}
        tabIndex={0}
        onPointerDown={onDividerDown}
        onPointerMove={onDividerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onDividerKey}
        className={`group relative w-px shrink-0 cursor-col-resize bg-[var(--separator)] ${
          dragging ? "bg-[var(--accent)]" : "hover:bg-[var(--accent)]"
        }`}
      >
        {/* Widened invisible hit area — the visible line stays 1px, the grab target is 11px. */}
        <span aria-hidden="true" className="absolute inset-y-0 -left-[5px] -right-[5px]" />
      </div>

      <div
        className="min-w-0 shrink-0 overflow-y-auto [scroll-padding-block:1rem]"
        style={{ width: `${detailPct}%` }}
      >
        {committedId === null ? (
          <p className="p-6 text-[13px] text-tertiary">Select a job to review it here.</p>
        ) : (
          <ReviewPane jobId={committedId} reduced={reduced} />
        )}
      </div>
    </div>
  );
}
