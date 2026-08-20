"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

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
          window.dispatchEvent(new CustomEvent(LOCK_EVENT, { detail: { candidateId: body.candidateId } }));
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
  const inputRef = useRef<HTMLInputElement>(null);

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
    inputRef.current?.focus();
    fetch(`/api/candidates`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const c = (b?.candidates ?? []).find((x: { id: number }) => x.id === locked.candidateId);
        if (c) setName(c.display_name);
      })
      .catch(() => {});
  }, [locked]);

  const submit = useCallback(async () => {
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
      // Reload so every request the page already made is retried with the unlock in place.
      window.location.reload();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }, [locked, pin]);

  if (!locked) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center px-4 pt-[16vh]">
      <div aria-hidden="true" className="absolute inset-0 bg-[rgba(10,11,15,0.5)]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Profile locked"
        onKeyDown={(e) => {
          if (e.key === "Enter" && pin.length === 4) submit();
        }}
        className="plane plane-5 relative w-full max-w-sm rounded-[var(--radius-xl)] px-5 py-5 text-center"
      >
        <h2 className="text-[15px] font-semibold text-primary">
          {name ? `${name} is locked` : "This profile is locked"}
        </h2>
        <p className="mt-1 text-[11.5px] text-tertiary">Enter the 4-digit PIN to continue</p>

        <input
          ref={inputRef}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          autoComplete="off"
          aria-label="PIN"
          className="mx-auto mt-3 block w-36 rounded-md border border-[var(--border)] bg-surface px-3 py-2 text-center text-[18px] tabular-nums tracking-[0.5em] text-primary outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
        />

        {error && <p className="mt-2 text-[12px] text-[var(--error)]">{error}</p>}

        <div className="mt-4 flex justify-center gap-2">
          <Link
            href="/"
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
          >
            Switch profile
          </Link>
          <button
            type="button"
            onClick={submit}
            disabled={busy || pin.length !== 4}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
      </div>
    </div>
  );
}
