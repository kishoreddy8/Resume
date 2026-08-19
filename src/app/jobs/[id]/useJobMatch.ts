"use client";

import { useEffect, useState } from "react";
import type { JobMatchResult } from "@/lib/match/types";

/**
 * Stage 2 — the Phase 2 match result for one job, lifted out of MatchCard so that the decision
 * header and the evidence section can render from the SAME result.
 *
 * This is a move, not a new data path. The request logic below is MatchCard's own, unchanged: one
 * cheap deterministic GET on mount (no AI, no cost, no reason to gate it behind a click) and a POST
 * only when the user explicitly presses Evaluate/Re-evaluate. The page calls this hook once, so the
 * number of requests is exactly what it was when MatchCard owned the state — putting the verdict at
 * the top of the page costs nothing extra.
 *
 * Nothing here interprets the result. Decision, eligibility, blocking reasons and the
 * insufficient-signal flag are passed through exactly as the API returned them.
 */

export type MatchState = "idle" | "loading" | "ok" | "none" | "unavailable" | "error";

type GetResponse = { status: "none" } | { status: "ok"; result: JobMatchResult } | { error: string };
type PostResponse =
  | { status: "unavailable"; reason: string }
  | { status: "ok"; cached: boolean; result: JobMatchResult }
  | { error: string };

export interface JobMatch {
  result: JobMatchResult | null;
  state: MatchState;
  /** The server's own reason string for an unavailable evaluation — never re-worded here. */
  reason: string | null;
  /** Explicit user action only; never called on a timer or on mount. */
  evaluate: () => Promise<void>;
}

export function useJobMatch(jobId: number, candidateId: number): JobMatch {
  const [result, setResult] = useState<JobMatchResult | null>(null);
  const [state, setState] = useState<MatchState>("idle");
  const [reason, setReason] = useState<string | null>(null);

  async function loadLatest() {
    setState("loading");
    try {
      const res = await fetch(`/api/jobs/${jobId}/match?candidateId=${candidateId}`);
      const body = (await res.json().catch(() => null)) as GetResponse | null;
      if (!res.ok || !body || "error" in body) {
        setState("error");
        return;
      }
      if (body.status === "none") {
        setState("none");
        return;
      }
      setResult(body.result);
      setState("ok");
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    // Intentional: cheap deterministic GET on mount, unlike AiInsightsCard's strictly on-demand
    // pattern — there is no cost/latency reason to gate this behind a click.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, candidateId]);

  async function evaluate() {
    setState("loading");
    try {
      const res = await fetch(`/api/jobs/${jobId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId }),
      });
      const body = (await res.json().catch(() => null)) as PostResponse | null;
      if (!res.ok || !body || "error" in body) {
        setState("error");
        return;
      }
      if (body.status === "unavailable") {
        setReason(body.reason);
        setState("unavailable");
        return;
      }
      setResult(body.result);
      setState("ok");
    } catch {
      setState("error");
    }
  }

  return { result, state, reason, evaluate };
}
