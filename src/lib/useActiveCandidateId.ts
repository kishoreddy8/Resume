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
}

function fetchActiveCandidateId(): Promise<number> {
  if (cachedId !== null) return Promise.resolve(cachedId);
  if (inFlight) return inFlight;
  inFlight = fetch("/api/candidates/active")
    .then((res) => res.json())
    .then((body) => {
      const id = typeof body?.candidateId === "number" ? body.candidateId : 1;
      cachedId = id;
      return id;
    })
    .catch(() => 1 /* stay on the default */)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useActiveCandidateId(): number {
  const [candidateId, setCandidateId] = useState(cachedId ?? 1);

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
