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
      router.push(setup && setup.complete === false ? "/onboarding" : "/home");
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
      /* Full reload rather than a local refetch. The candidate selector in the app shell fetches
       * once on mount and lives outside this tree, so a local refetch left deleted profiles listed
       * there — indistinguishable, from the user's side, from the delete having failed. Same
       * approach CandidateSelector already uses when switching profiles. */
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative isolate mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-6xl flex-col justify-center px-4 py-12 sm:px-6 lg:py-16">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-[12%] top-[20%] -z-10 h-64 rounded-full bg-[radial-gradient(circle,var(--accent-soft),transparent_68%)] opacity-45 blur-3xl" />
      <div className="mb-9 text-center sm:mb-11">
        <h1 className="text-[clamp(2rem,4vw,2.875rem)] font-semibold leading-tight tracking-[-0.035em] text-primary">Who&apos;s working?</h1>
        <p className="mx-auto mt-2.5 max-w-2xl text-[14px] leading-6 text-tertiary sm:text-[15px]">
          Choose a profile. Everything except companies and job postings is kept separate per person.
        </p>
      </div>

      {candidates === null && <p className="text-center text-[14px] text-tertiary">Loading profiles…</p>}

      {candidates && !selected && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {candidates.map((c) => (
              <Surface
                key={c.id}
                level="z3"
                className="group flex min-h-24 items-center gap-4 rounded-[var(--radius-xl)] px-5 py-4 shadow-[var(--lift-1)] transition-[transform,box-shadow,border-color] duration-150 ease-out hover:-translate-y-0.5 hover:border-[color-mix(in_oklab,var(--accent)_30%,var(--border))] hover:shadow-[var(--lift-2)]"
              >
                <button
                  type="button"
                  onClick={() => choose(c)}
                  disabled={busy}
                  className="flex min-h-14 min-w-0 flex-1 items-center gap-4 text-left disabled:opacity-50"
                >
                  <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-[var(--accent-soft)] text-[16px] font-semibold text-[var(--accent)]">
                    {initials(c.display_name)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[16px] font-semibold text-primary sm:text-[17px]">{c.display_name}</span>
                    <span className="mt-1 block text-[13px] text-tertiary">
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
                    className="min-h-11 shrink-0 rounded-md border border-[var(--error)]/35 px-3 text-[13px] font-medium text-[var(--error)] opacity-0 transition-opacity duration-150 ease-out hover:bg-[color-mix(in_oklab,var(--error)_10%,transparent)] focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    Delete
                  </button>
                )}
              </Surface>
            ))}
          </div>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[14px]">
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
        <Surface level="z3" className="mx-auto w-full max-w-lg rounded-[24px] px-6 py-8 text-center shadow-[var(--lift-3)] sm:px-10 sm:py-10">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[var(--accent-soft)] text-[19px] font-semibold text-[var(--accent)]">
            {initials(selected.display_name)}
          </span>
          <h2 className="mt-4 text-[21px] font-semibold text-primary">{selected.display_name}</h2>
          <p className="mt-1.5 text-[14px] text-tertiary">Enter the 4-digit PIN</p>

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
            className="mx-auto mt-5 block h-14 w-48 rounded-xl border border-[var(--border)] bg-surface px-4 text-center text-[24px] tabular-nums tracking-[0.5em] text-primary outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
          />

          {error && <p className="mt-3 text-[13px] text-[var(--error)]">{error}</p>}

          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="min-h-11 rounded-lg border border-[var(--border)] px-5 text-[14px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
            >
              Back
            </button>
            <button
              type="button"
              onClick={submitPin}
              disabled={busy || pin.length !== 4}
              className="min-h-11 rounded-lg bg-[var(--accent)] px-5 text-[14px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
            >
              {busy ? "Unlocking…" : "Unlock"}
            </button>
          </div>
        </Surface>
      )}
    </div>
  );
}
