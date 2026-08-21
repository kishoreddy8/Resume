"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { resolveActiveCandidateId } from "@/lib/useActiveCandidateId";

/**
 * A PIN prompt that appears wherever a locked profile is hit.
 *
 * WHY IT EXISTS. Guarding routes individually meant every page could become a dead end: the owner
 * set a PIN, the next request 401'd, and the settings page rendered the raw API string "This profile
 * is locked. Enter its PIN to continue." with nowhere to enter it. Telling someone what to do while
 * giving them no way to do it is worse than not guarding at all — the app looked broken.
 *
 * Rather than teaching a dozen pages to render a PIN form, this wraps fetch once and reacts to the
 * one thing the guard actually returns: HTTP 401 with reason "profile_locked". Any page, present or
 * future, is covered without knowing this exists.
 *
 * The wrapper is deliberately transparent: it passes the original response through untouched, so no
 * caller's error handling changes. It only observes.
 */

interface LockedInfo {
  candidateId: number;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The wrapper is installed at MODULE LOAD, not in an effect.
 *
 * Effects run child-first, so a page's own data fetch fires before this component's effect could
 * install anything — the first 401, the one that actually matters, sailed straight past. Patching
 * when the client bundle evaluates means the very first request of the page is already covered.
 *
 * Patched once and never restored: this lives for the lifetime of the tab, and un-patching on
 * unmount would reopen the same gap on the next navigation.
 */
const LOCK_EVENT = "career-ops:profile-locked";

if (typeof window !== "undefined" && !(window as unknown as { __coLockPatched?: boolean }).__coLockPatched) {
  (window as unknown as { __coLockPatched?: boolean }).__coLockPatched = true;
  const original = window.fetch;
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args);
    if (res.status === 401) {
      try {
        // Read a clone so the caller still receives an unconsumed body.
        const body = await res.clone().json();
        if (body?.reason === "profile_locked" && typeof body.candidateId === "number") {
          /* Only prompt for the profile the user is ACTUALLY on.
           *
           * useActiveCandidateId optimistically starts at candidate 1 before the server answers,
           * so a browser with no stored id — a phone opening the app for the first time — fires a
           * handful of requests for candidate 1 on every page. If candidate 1 has a PIN, those
           * 401 immediately, and a full-screen "Saikishore Reddy is locked" prompt landed on top
           * of a setup page belonging to somebody else, with no way past it. Onboarding on a new
           * device was blocked outright.
           *
           * The 401 body names the candidate it refers to, so a lock for anyone other than the
           * resolved active profile is a speculative request the user never asked for, and is
           * dropped. Locks for the profile they really are on behave exactly as before. */
          const active = await resolveActiveCandidateId().catch(() => null);
          if (active === null || active === body.candidateId) {
            window.dispatchEvent(new CustomEvent(LOCK_EVENT, { detail: { candidateId: body.candidateId } }));
          }
        }
      } catch {
        // A 401 without our JSON shape is somebody else's concern.
      }
    }
    return res;
  };
}

export function ProfileLockPrompt() {
  const [locked, setLocked] = useState<LockedInfo | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string>("");
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const releaseModalRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onLocked = (e: Event) => {
      const detail = (e as CustomEvent<{ candidateId: number }>).detail;
      if (detail && typeof detail.candidateId === "number") setLocked({ candidateId: detail.candidateId });
    };
    window.addEventListener(LOCK_EVENT, onLocked);
    return () => window.removeEventListener(LOCK_EVENT, onLocked);
  }, []);

  useEffect(() => {
    if (!locked) return;
    fetch(`/api/candidates`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const c = (b?.candidates ?? []).find((x: { id: number }) => x.id === locked.candidateId);
        if (c) setName(c.display_name);
      })
      .catch(() => {});
  }, [locked]);

  useEffect(() => {
    if (!locked || !overlayRef.current) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = overlayRef.current;
    const overlayRoot = Array.from(document.body.children).find(
      (child): child is HTMLElement => child instanceof HTMLElement && (child === overlay || child.contains(overlay))
    );
    const previousInert = new Map<HTMLElement, boolean>();

    const makeBackgroundInert = (element: Element) => {
      if (!(element instanceof HTMLElement) || element === overlayRoot || element.contains(overlay)) return;
      if (!previousInert.has(element)) previousInert.set(element, element.inert);
      element.inert = true;
    };

    Array.from(document.body.children).forEach(makeBackgroundInert);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) makeBackgroundInert(node);
        }
      }
    });
    observer.observe(document.body, { childList: true });

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      observer.disconnect();
      previousInert.forEach((wasInert, element) => {
        element.inert = wasInert;
      });
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
      previousFocusRef.current = null;
      releaseModalRef.current = null;
    };
    releaseModalRef.current = release;
    inputRef.current?.focus();
    return release;
  }, [locked]);

  function handleDialogKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      // A locked profile has no dismiss action: Escape must not reveal protected content.
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.focus();
      return;
    }

    if (e.key === "Tab") {
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (focusable.length === 0) {
        e.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }

    if (e.key === "Enter" && e.target === inputRef.current && pin.length === 4) {
      e.preventDefault();
      submit();
    }
  }

  async function submit() {
    if (!locked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/candidates/${locked.candidateId}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          body.reason === "locked"
            ? `Too many attempts. Try again in ${Math.ceil((body.retryAfterMs ?? 0) / 60000)} minutes.`
            : body.reason === "wrong"
              ? `Incorrect PIN. ${body.attemptsRemaining} attempt${body.attemptsRemaining === 1 ? "" : "s"} left.`
              : (body.error ?? "Could not unlock.")
        );
        setPin("");
        return;
      }
      releaseModalRef.current?.();
      // Reload so every request the page already made is retried with the unlock in place.
      window.location.reload();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (!locked) return null;

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[200] flex items-start justify-center px-4 pt-[16vh]">
      <div aria-hidden="true" className="absolute inset-0 bg-[rgba(10,11,15,0.5)]" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Profile locked"
        aria-describedby={error ? "profile-lock-hint profile-lock-error" : "profile-lock-hint"}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        className="plane plane-5 relative w-full max-w-sm rounded-[var(--radius-xl)] px-5 py-5 text-center"
      >
        <h2 className="text-[15px] font-semibold text-primary">
          {name ? `${name} is locked` : "This profile is locked"}
        </h2>
        <p id="profile-lock-hint" className="mt-1 text-[11.5px] text-tertiary">Enter the 4-digit PIN to continue</p>

        <input
          ref={inputRef}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          autoComplete="off"
          aria-label="PIN"
          className="mx-auto mt-3 block w-36 rounded-md border border-[var(--border)] bg-surface px-3 py-2 text-center text-[18px] tabular-nums tracking-[0.5em] text-primary outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
        />

        {error && <p id="profile-lock-error" role="alert" aria-live="assertive" className="mt-2 text-[12px] text-[var(--error)]">{error}</p>}

        <div className="mt-4 flex justify-center gap-2">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center rounded-md border border-[var(--border)] px-3 text-[12.5px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
          >
            Switch profile
          </Link>
          <button
            type="button"
            onClick={submit}
            disabled={busy || pin.length !== 4}
            className="min-h-11 rounded-md bg-[var(--accent)] px-3 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
      </div>
    </div>
  );
}
