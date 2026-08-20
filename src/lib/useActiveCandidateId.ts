"use client";

import { useEffect, useState } from "react";

/**
 * Client-side convenience default for "which candidate is this page currently showing" — fetches
 * from /api/candidates/active. This is a UX default only (see CAREER_OPS_HANDOFF.md's Phase 2.5
 * design record §8/9): every candidate-scoped API call still sends this value explicitly, so it
 * never becomes a hidden source of truth the server relies on — it's just what the UI starts on
 * before the user picks a different candidate from the selector. Defaults to 1 (Candidate #1, which
 * always exists) while the fetch is in flight, never fabricated for any OTHER candidate id.
 *
 * REQUEST DEDUPLICATION. This hook is used by many components at once, and it previously issued one
 * request per instance — measured at 5-6 concurrent calls to /api/candidates/active on a single
 * /jobs load. They are individually tiny, but browsers cap concurrent connections per origin, so
 * six redundant requests queue ahead of the ones that actually matter. The in-flight promise is now
 * shared at module scope, so N mounts produce exactly one request and all of them resolve from it.
 *
 * The cache is the resolved id, not a timed entry: the active candidate only changes when the user
 * picks a different one, and that path sets it explicitly rather than re-reading this endpoint.
 */

const LAST_ACTIVE_KEY = "career-ops:last-active-candidate";

/**
 * Seeded from the last id this browser resolved.
 *
 * The hook used to start at 1 on every fresh page load, so each page fired its first request for
 * candidate 1 before the real id arrived. Once candidate 1 had a PIN that first request 401'd, and
 * a spurious "Saikishore Reddy is locked" prompt appeared in front of people who were not using
 * that profile at all. Remembering the last resolved id makes the optimistic guess a correct one
 * for every load after the first.
 *
 * It is only ever a starting guess: the server remains the authority and overwrites it below.
 */
function seedFromStorage(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_ACTIVE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

let cachedId: number | null = null;
let inFlight: Promise<number> | null = null;

/**
 * Seed the cache after the active candidate is CHANGED by this tab.
 *
 * Required because the cache above is module-scoped and outlives a client-side navigation. Creating
 * a candidate POSTs /api/candidates/active and then router.push()es — no page reload, so a stale id
 * survived the navigation and the destination page rendered the PREVIOUS candidate. That looked
 * exactly like "creating a new person sends you to the first person's profile"; the record was
 * created correctly every time, the UI just kept reading the old id.
 *
 * CandidateSelector does a full window.location.reload() and so was never affected — which is why
 * only the create-new path showed it.
 */
export function primeActiveCandidateId(id: number): void {
  cachedId = id;
  inFlight = null;
  try {
    window.localStorage.setItem(LAST_ACTIVE_KEY, String(id));
  } catch {
    /* ignore */
  }
}

/**
 * The authoritative active candidate, resolved once and shared.
 *
 * Exported so ProfileLockPrompt can distinguish a lock that matters from one that does not — see
 * the note there about speculative requests on a fresh browser.
 */
export function resolveActiveCandidateId(): Promise<number> {
  return fetchActiveCandidateId();
}

function fetchActiveCandidateId(): Promise<number> {
  if (cachedId !== null) return Promise.resolve(cachedId);
  if (inFlight) return inFlight;
  inFlight = fetch("/api/candidates/active")
    .then((res) => res.json())
    .then((body) => {
      const id = typeof body?.candidateId === "number" ? body.candidateId : 1;
      cachedId = id;
      try {
        window.localStorage.setItem(LAST_ACTIVE_KEY, String(id));
      } catch {
        /* a browser refusing storage is not worth failing over */
      }
      return id;
    })
    .catch(() => 1 /* stay on the default */)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useActiveCandidateId(): number {
  const [candidateId, setCandidateId] = useState(() => cachedId ?? seedFromStorage() ?? 1);

  useEffect(() => {
    let cancelled = false;
    fetchActiveCandidateId().then((id) => {
      if (!cancelled) setCandidateId(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return candidateId;
}

/**
 * The active candidate, or null until the SERVER has actually said which one it is.
 *
 * useActiveCandidateId above returns an optimistic guess immediately so pages can render. That is
 * right for rendering and wrong for fetching: a page that starts fetching on the guess issues a
 * full set of candidate-scoped requests for the wrong profile and then repeats every one of them
 * when the real id arrives — measured at ten duplicated calls on a single setup page load. On a
 * fresh browser those speculative calls also 401, because the guessed profile may be someone
 * else's and PIN-protected.
 *
 * Fetch on this; render on the other.
 */
export function useResolvedCandidateId(): number | null {
  const [id, setId] = useState<number | null>(() => cachedId);

  useEffect(() => {
    if (id !== null) return;
    let cancelled = false;
    resolveActiveCandidateId().then((v) => {
      if (!cancelled) setId(v);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return id;
}

/**
 * The active candidate, but never before the browser has mounted.
 *
 * WHY A THIRD HOOK. The other two are correct for fetching and for driving layout, and wrong for
 * anything that reaches the RENDERED MARKUP. Server rendering has no browser, no localStorage and
 * no module cache, so it emits the fallback; the client's very first render may already hold a
 * resolved id from a previous page. React compares those two and reports a hydration mismatch,
 * which is exactly what /master-files hit by printing the id into its own copy.
 *
 * This returns null until after mount, so the first client render is identical to the server's by
 * construction, and the real value arrives on the next paint. Callers show a neutral placeholder
 * for that one frame — honest, because until the server answers the app genuinely does not know
 * which candidate this is.
 *
 * Use this ONLY for values that appear in markup. For requests use useResolvedCandidateId, which
 * does not need to wait for a paint.
 */
export function useDisplayCandidateId(): number | null {
  const [mounted, setMounted] = useState(false);
  const resolved = useResolvedCandidateId();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  return mounted ? resolved : null;
}
