"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { MOTION_EMPHASIZED, MOTION_NORMAL_MS } from "@/lib/motion/tokens";

/**
 * UI-M — the one reusable bottom-sheet primitive. Not Jobs-specific: this will later power Jobs
 * filters, mobile Question Center secondary controls, and other focused mobile actions (design
 * direction) — none of those consumers are built in this phase.
 *
 * NATIVE DIALOG SEMANTICS, on purpose — the same `<dialog>` + `showModal()` idiom AppSidebar's own
 * admin mobile menu already uses, generalized into a reusable primitive rather than a second
 * hand-rolled implementation. `showModal()` gives focus trapping and body-scroll locking for free,
 * per the HTML spec; nothing here reimplements either.
 *
 * The dialog itself is a full-viewport, fully transparent canvas (no default border/margin/backdrop)
 * so the two things a user actually sees — an animated backdrop and the sheet surface — are plain
 * Motion children positioned within it. This is what lets a native, spec-compliant dialog also have
 * a real slide-up/fade transition: `dialog.close()` is only called from `AnimatePresence`'s
 * `onExitComplete`, once the exit animation has actually finished, so the dialog never just vanishes
 * mid-animation the way an unmanaged `close()` call would make it.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const reduced = useReducedMotion() ?? false;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // Captured here, not at close time — by the time we close, the trigger may no longer be
      // document.activeElement (the user could have clicked elsewhere inside the sheet first).
      restoreFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    // Closing is deliberately NOT handled here — see the AnimatePresence onExitComplete below,
    // which is what lets the exit animation actually play before the native dialog disappears.
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      className="m-0 h-dvh max-h-none w-full max-w-none border-0 bg-transparent p-0 backdrop:bg-transparent"
      onCancel={(e) => {
        // Escape's default behaviour closes the dialog instantly; prevented so the caller's own
        // onClose runs instead, and the exit animation below gets to play first.
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        queueMicrotask(() => restoreFocusTo.current?.focus());
      }}
    >
      <AnimatePresence onExitComplete={() => dialogRef.current?.close()}>
        {open && (
          <>
            <motion.div
              key="backdrop"
              aria-hidden="true"
              onClick={onClose}
              className="fixed inset-0 bg-black/40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduced ? 0 : MOTION_NORMAL_MS / 1000 }}
            />
            <motion.div
              key="sheet"
              className="plane plane-4 fixed inset-x-0 bottom-0 flex max-h-[85vh] flex-col overflow-hidden rounded-t-[var(--radius-modal)] pb-[env(safe-area-inset-bottom)]"
              initial={reduced ? { opacity: 0 } : { y: "100%" }}
              animate={reduced ? { opacity: 1 } : { y: 0 }}
              exit={reduced ? { opacity: 0 } : { y: "100%" }}
              transition={reduced ? { duration: 0.12 } : MOTION_EMPHASIZED}
            >
              <div className="flex items-center justify-between gap-3 border-b border-[var(--separator)] px-5 py-4">
                <h2 className="min-w-0 truncate text-[17px] font-bold text-primary">{title}</h2>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] text-[20px] text-tertiary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
              {description && <p className="px-5 pt-3 text-[13px] leading-relaxed text-tertiary">{description}</p>}
              <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
              {footer && <div className="border-t border-[var(--separator)] px-5 py-4">{footer}</div>}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </dialog>
  );
}
