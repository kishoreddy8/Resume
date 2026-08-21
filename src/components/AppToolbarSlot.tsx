"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Lets a page render its own title and primary actions into the application toolbar.
 *
 * The toolbar previously held only the notification bell, so every page stacked a second header row
 * underneath it — two bands of chrome doing one band's work, and a wide empty strip across the top.
 * This closes that gap without a context provider: the layout renders one anchor node, and a page
 * portals into it. Pages that opt out are unaffected; the toolbar simply stays as it was.
 */
export const APP_TOOLBAR_SLOT_ID = "app-toolbar-slot";
/**
 * The toolbar's second anchor, for a page's ACTIONS rather than its identity.
 *
 * One anchor was not enough. It sat absolutely at the left edge with a 26% cap, so a page that
 * portalled a full row into it — title, view switch, search, Filters, Scan now — ran straight
 * underneath the centred search field. Measured at 2000px the left anchor occupied 248..712 and
 * the search 554..1334: 158px of overlap, with "Scan now" and the page's own search field sitting
 * beneath it. Identity belongs on the left of the search and actions belong on its right, which is
 * where they are on every page that has both, so there are two anchors and neither is absolute.
 */
export const APP_TOOLBAR_ACTIONS_SLOT_ID = "app-toolbar-actions-slot";

/** Canonical "are we past hydration" read: the server snapshot is false, the client's is true, and
 *  nothing ever changes afterwards — so no subscription and no state update in an effect. */
const subscribe = () => () => {};
function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}

function Slot({ id, children }: { id: string; children: ReactNode }) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  const host = document.getElementById(id);
  return host ? createPortal(children, host) : null;
}

/** Left of the search: what this page IS. Keep it short — it shares a row with a search field. */
export function AppToolbarSlot({ children }: { children: ReactNode }) {
  return <Slot id={APP_TOOLBAR_SLOT_ID}>{children}</Slot>;
}

/** Right of the search, before the bell: what this page can DO. */
export function AppToolbarActions({ children }: { children: ReactNode }) {
  return <Slot id={APP_TOOLBAR_ACTIONS_SLOT_ID}>{children}</Slot>;
}
