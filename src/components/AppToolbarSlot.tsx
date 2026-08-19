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

export function AppToolbarSlot({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  const host = document.getElementById(APP_TOOLBAR_SLOT_ID);
  return host ? createPortal(children, host) : null;
}
