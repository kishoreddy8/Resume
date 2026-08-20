"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { primeActiveCandidateId } from "@/lib/useActiveCandidateId";
import { Surface } from "@/components/ui";

/**
 * The landing page: choose a profile, enter its PIN, go to that person's workspace.
 *
 * This replaced a bare redirect to /jobs, which meant the app always opened as whoever was last
 * active. With several people sharing one install that is the wrong default — you could be looking
 * at someone else's matches without realising the profile had never changed.
 *
 * Only presentation-safe fields are used here. /api/candidates deliberately never returns pin_hash
 * or pin_salt (see CANDIDATE_SELECT), so this page can list who exists without publishing anything
 * that would let a visitor brute-force a 4-digit PIN offline.
 */

interface Candidate {
  id: number;
  display_name: string;
  has_pin: 0 | 1;
  is_owner: 0 | 1;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export default function HomePage() {
  const router = useRouter();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownerUnlocked, setOwnerUnlocked] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/candidates");
    const body = await res.json().catch(() => ({ candidates: [] }));
    const list: Candidate[] = body.candidates ?? [];
    setCandidates(list);
    const owner = list.find((c) => c.is_owner === 1);
    if (owner) {
      const s = await fetch(`/api/candidates/${owner.id}/unlock`).then((r) => (r.ok ? r.json() : null));
      setOwnerUnlocked(Boolean(s?.unlocked && s?.hasPin));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    if (selected?.has_pin) pinRef.current?.focus();
  }, [selected]);

  /** Where a profile should land depends on whether its setup is finished. */
  const enter = useCallback(
    async (candidate: Candidate) => {
      await fetch("/api/candidates/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: candidate.id }),
      });
      primeActiveCandidateId(candidate.id);
      const setup = await fetch(`/api/candidates/${candidate.id}/setup`).then((r) => (r.ok ? r.json() : null));
      router.push(setup && setup.complete === false ? "/onboarding" : "/jobs");
    },
    [router]
  );

  async function choose(candidate: Candidate) {
    setError(null);
    if (!candidate.has_pin) {
      setBusy(true);
      await enter(candidate);
      return;
    }
    setSelected(candidate);
    setPin("");
  }

  async function submitPin() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/candidates/${selected.id}/unlock`, {
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
        setBusy(false);
        return;
      }
      await enter(selected);
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  async function removeProfile(c: Candidate) {
    if (!window.confirm(`Permanently delete “${c.display_name}”? This removes their matches, resumes and uploaded files. It cannot be undone.`))
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/candidates/${c.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not delete.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center py-10">
      <div className="mb-7 text-center">
        <h1 className="page-title">Who&apos;s working?</h1>
        <p className="mt-1.5 text-[12.5px] text-tertiary">
          Choose a profile. Everything except companies and job postings is kept separate per person.
        </p>
      </div>

      {candidates === null && <p className="text-center text-[12.5px] text-tertiary">Loading profiles…</p>}

      {candidates && !selected && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {candidates.map((c) => (
              <Surface
                key={c.id}
                level="z3"
                className="group flex items-center gap-3 rounded-[var(--radius-xl)] px-4 py-3.5 transition-transform duration-150 ease-out hover:-translate-y-px"
              >
                <button
                  type="button"
                  onClick={() => choose(c)}
                  disabled={busy}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-50"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--accent-soft)] text-[13px] font-semibold text-[var(--accent)]">
                    {initials(c.display_name)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] font-semibold text-primary">{c.display_name}</span>
                    <span className="mt-0.5 block text-[11px] text-tertiary">
                      {c.is_owner === 1 ? "Owner · " : ""}
                      {c.has_pin ? "PIN required" : "No PIN — open"}
                    </span>
                  </span>
                </button>
                {ownerUnlocked && c.is_owner !== 1 && (
                  <button
                    type="button"
                    onClick={() => removeProfile(c)}
                    disabled={busy}
                    aria-label={`Delete ${c.display_name}`}
                    className="shrink-0 rounded-md border border-[var(--error)]/35 px-2 py-1 text-[11px] font-medium text-[var(--error)] opacity-0 transition-opacity duration-150 ease-out hover:bg-[color-mix(in_oklab,var(--error)_10%,transparent)] focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    Delete
                  </button>
                )}
              </Surface>
            ))}
          </div>

          <div className="mt-5 flex items-center justify-center gap-4 text-[12px]">
            <Link href="/candidates/new" className="text-secondary hover:text-primary">
              + Add a profile
            </Link>
            {!ownerUnlocked && candidates.some((c) => c.is_owner === 1 && c.has_pin === 1) && (
              <span className="text-tertiary">Unlock the owner profile to manage profiles</span>
            )}
          </div>
        </>
      )}

      {selected && (
        <Surface level="z3" className="mx-auto w-full max-w-sm rounded-[var(--radius-xl)] px-5 py-5 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--accent-soft)] text-[15px] font-semibold text-[var(--accent)]">
            {initials(selected.display_name)}
          </span>
          <h2 className="mt-3 text-[15px] font-semibold text-primary">{selected.display_name}</h2>
          <p className="mt-1 text-[11.5px] text-tertiary">Enter the 4-digit PIN</p>

          <input
            ref={pinRef}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && pin.length === 4) submitPin();
              if (e.key === "Escape") setSelected(null);
            }}
            inputMode="numeric"
            autoComplete="off"
            aria-label={`PIN for ${selected.display_name}`}
            className="mx-auto mt-3 block w-36 rounded-md border border-[var(--border)] bg-surface px-3 py-2 text-center text-[18px] tabular-nums tracking-[0.5em] text-primary outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
          />

          {error && <p className="mt-2 text-[12px] text-[var(--error)]">{error}</p>}

          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
            >
              Back
            </button>
            <button
              type="button"
              onClick={submitPin}
              disabled={busy || pin.length !== 4}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
            >
              {busy ? "Unlocking…" : "Unlock"}
            </button>
          </div>
        </Surface>
      )}
    </div>
  );
}
