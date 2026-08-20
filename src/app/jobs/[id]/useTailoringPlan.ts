"use client";

import { useEffect, useState } from "react";
import type { TailoringPlan } from "@/lib/tailoringIntelligence/plan";

/**
 * Loads the Tailoring Intelligence plan for one job.
 *
 * ONE REQUEST, AND ONLY WHEN IT IS WANTED. The plan is fetched once per candidate/job pair and not
 * at all while `enabled` is false — the panel is inside a disclosure, so a user who never opens it
 * never pays for it. The endpoint itself re-reads the persisted match result rather than evaluating
 * anything, so this costs a row read and no computation.
 */
export type PlanState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "not_evaluated" }
  | { state: "error" }
  | { state: "ready"; plan: TailoringPlan };

export function useTailoringPlan(candidateId: number, jobId: number, enabled: boolean): PlanState {
  const [value, setValue] = useState<PlanState>({ state: "idle" });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    /* The loading state is set here rather than derived, because "enabled just became true" is
     * exactly the transition it describes and there is nowhere else to observe it. */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue({ state: "loading" });
    fetch(`/api/candidates/${candidateId}/jobs/${jobId}/tailoring-intelligence`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        if (!body) setValue({ state: "error" });
        else if (body.status === "not_evaluated") setValue({ state: "not_evaluated" });
        else setValue({ state: "ready", plan: body.plan as TailoringPlan });
      })
      .catch(() => {
        if (!cancelled) setValue({ state: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId, jobId, enabled]);

  return value;
}
