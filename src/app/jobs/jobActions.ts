import type { ListDecision } from "@/lib/rank/jobsList";

/**
 * UI-J — the two real mutations behind "Approve & Tailor" and "Not interested," extracted so a new
 * call site (the mobile swipe card) can reuse them EXACTLY rather than re-deriving the same two
 * requests. Neither function is new business logic:
 *
 *  - approveForTailoring mirrors ResumeQualityPipeline.tsx's handleStartTailoring() verbatim — the
 *    same two calls, in the same order, with the same payload shape (PATCH markedForTailoring+
 *    approval, then POST quality-workflow — no body, but the same Content-Type header the original
 *    sends anyway). That file is out of UI-J's scope to touch (see the phase brief's DO NOT TOUCH
 *    list), so this is a parallel copy of its existing sequence, not a divergent one — same two
 *    endpoints, same order, same shape.
 *  - rejectJob wires the existing, already-shipped, previously-unused `/api/jobs/[id]/not-interested`
 *    route (Phase 2.5: candidate-personal, reversible, never deletes the job row — see that route's
 *    own doc comment). No UI in the app called it before this phase.
 *
 * Both are candidateId-scoped, both hit only Career-Ops's own resume-tailoring surface — never
 * src/lib/apply/** (employer submission), never Workday/Greenhouse/Lever. "Approve & Tailor" starts
 * tailoring; it never submits anything to an employer.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** READY_FOR_TAILORING approves directly; NEEDS_REVIEW is an explicit override. BLOCKED (or no
 *  decision at all) has no approval path — same rule JobActionDock's resolveDockState already
 *  enforces on the detail page; this is not a new judgment call, just applied at the card level. */
export function canApproveForTailoring(decision: ListDecision | undefined): boolean {
  return decision === "READY_FOR_TAILORING" || decision === "NEEDS_REVIEW";
}

export async function approveForTailoring({
  candidateId,
  jobId,
  decision,
}: {
  candidateId: number;
  jobId: number;
  decision: ListDecision;
}): Promise<ActionResult> {
  if (!canApproveForTailoring(decision)) {
    return { ok: false, error: "This job is not ready to approve for tailoring yet." };
  }
  const approvalType = decision === "NEEDS_REVIEW" ? "NEEDS_REVIEW_OVERRIDE" : "READY_DIRECT";
  try {
    const patchRes = await fetch(`/api/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidateId,
        markedForTailoring: true,
        approval: { approvalType, decision },
      }),
    });
    if (!patchRes.ok) {
      const body = await patchRes.json().catch(() => ({}));
      return { ok: false, error: body.error ?? "Could not approve this job for tailoring." };
    }
    const workflowRes = await fetch(`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!workflowRes.ok) {
      const body = await workflowRes.json().catch(() => ({}));
      return { ok: false, error: body.error ?? "Approved, but tailoring could not start." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error — could not approve this job." };
  }
}

/** Reversible: a second call with notInterested:false clears the flag. Never deletes the job row —
 *  see /api/jobs/[id]/not-interested's own doc comment for the Phase 2.5 semantics this reuses. */
export async function setJobNotInterested({
  candidateId,
  jobId,
  notInterested,
}: {
  candidateId: number;
  jobId: number;
  notInterested: boolean;
}): Promise<ActionResult> {
  try {
    const res = await fetch(`/api/jobs/${jobId}/not-interested`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, notInterested }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error ?? "Could not update this job." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error — could not update this job." };
  }
}
