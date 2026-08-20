"use client";

/**
 * A tiny notification that a profile build has started.
 *
 * WHY THIS EXISTS. The status strip lives in the app chrome and has to notice a build that began
 * on some other page — that is its whole purpose. Polling for that was the obvious implementation
 * and the wrong one: it cost a request every four seconds on every page, forever, for a state that
 * changes a handful of times in an app's entire life. Measured at five requests per twenty idle
 * seconds on a profile with nothing running.
 *
 * A build only ever starts because someone in this app asked for one, so the page that asks can
 * simply say so. BroadcastChannel carries it to other tabs; a window event covers the current one.
 * The strip still does exactly one check on mount, to catch a build that began before it existed.
 *
 * Idle cost after this: zero requests.
 */

export const BUILD_STARTED = "career-ops:build-started";
const CHANNEL = "career-ops:builds";

export function announceBuildStarted(candidateId: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BUILD_STARTED, { detail: { candidateId } }));
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage({ candidateId });
    ch.close();
  } catch {
    // Not every browser has BroadcastChannel; the same-tab event still works.
  }
}

/** Calls `onStart` when a build begins here or in another tab. Returns an unsubscribe function. */
export function onBuildStarted(handler: (candidateId: number) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onEvent = (e: Event) => {
    const detail = (e as CustomEvent<{ candidateId: number }>).detail;
    if (detail && typeof detail.candidateId === "number") handler(detail.candidateId);
  };
  window.addEventListener(BUILD_STARTED, onEvent);

  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (m) => {
      if (typeof m.data?.candidateId === "number") handler(m.data.candidateId);
    };
  } catch {
    /* same-tab only */
  }

  return () => {
    window.removeEventListener(BUILD_STARTED, onEvent);
    ch?.close();
  };
}
