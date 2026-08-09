"use client";

import { useEffect, useState } from "react";

/**
 * Client-side convenience default for "which candidate is this page currently showing" — fetches
 * once from /api/candidates/active on mount. This is a UX default only (see
 * CAREER_OPS_HANDOFF.md's Phase 2.5 design record §8/9): every candidate-scoped API call still sends
 * this value explicitly, so it never becomes a hidden source of truth the server relies on — it's
 * just what the UI starts on before the user picks a different candidate from the selector.
 * Defaults to 1 (Candidate #1, which always exists) while the fetch is in flight, never fabricated
 * for any OTHER candidate id.
 */
export function useActiveCandidateId(): number {
  const [candidateId, setCandidateId] = useState(1);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/candidates/active")
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled && typeof body?.candidateId === "number") setCandidateId(body.candidateId);
      })
      .catch(() => {
        /* stay on the default of 1 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return candidateId;
}
