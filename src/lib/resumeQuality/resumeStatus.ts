/**
 * One candidate-facing verdict for a tailored resume.
 *
 * WHY THIS EXISTS. Resume Studio's library and the Job Workspace's Validation step both have to
 * turn the same engine output into the same sentence. Two switch statements over readiness is how
 * one screen ends up saying "Ready to use" while the other says "Blocked" about the same resume —
 * and on this particular data they genuinely disagree unless the rules are shared, because a
 * workflow can read READY with every dimension at 100 while readiness is BLOCKED.
 *
 * THIS MODULE DECIDES NOTHING. It does not evaluate a gate, re-apply a threshold, or compare a
 * score. It receives what `evaluateApplicationReadiness` and `evaluateQualityGate` already decided
 * and picks the words for it. `humanMaySend` remains the only authority on whether a package can be
 * sent, and nothing here can raise a verdict — the mapping is total and every branch that is not
 * explicitly READY resolves to something short of sendable.
 *
 * THE ORDER OF THE BRANCHES IS THE POINT. Legacy-refresh is checked before BLOCKED so a resume that
 * can be recovered says so instead of reading as a dead end, but it is still NOT presented as
 * cleared: `sendable` stays false until a fresh review says otherwise.
 */

import type { ApplicationReadiness } from "./applicationReadiness";

export type ResumeStatusKey = "ready" | "needs-review" | "needs-refresh" | "blocked" | "generating" | "unknown";

export interface ResumeStatusPresentation {
  key: ResumeStatusKey;
  /** The word a candidate reads. */
  label: string;
  /** Maps to the shared Pill tones. Never carries the meaning alone — the label is always shown. */
  tone: "success" | "warning" | "info" | "danger" | "neutral";
  /** One line of context, or null when the label says it all. */
  hint: string | null;
  /**
   * Whether this package may be attached to an application. Mirrors `humanMaySend` exactly and is
   * never inferred from a score, a gate outcome, or a workflow status.
   */
  sendable: boolean;
}

export interface ResumeStatusInput {
  /** Workflow lifecycle status, e.g. READY / FAILED / REVIEW_RUNNING. NOT a sendability signal. */
  workflowStatus: string | null;
  /**
   * `evaluateApplicationReadiness` output. The authority.
   *
   * Typed as the engine's own union rather than `string`, so a branch cannot be written against a
   * value the engine never produces. The first draft of this file compared against "READY" — which
   * is a workflow status, not a readiness — and the one genuinely sendable resume in the library
   * silently counted as zero. The compiler now rejects that.
   */
  readiness: ApplicationReadiness | null;
  /** `applicationReadiness.humanMaySend`. The only thing that makes `sendable` true. */
  humanMaySend: boolean | null;
  /** First blocking reason, verbatim from the engine. Never summarised here. */
  blockingReason?: string | null;
  /** A review written before today's typed safety analyses existed. */
  isLegacyMissingAnalysis?: boolean;
  /** Whether the workflow still has an iteration left to record a fresh review. */
  canRevalidate?: boolean;
}

const RUNNING_STATUSES = new Set([
  "PENDING",
  "WRITER_RUNNING",
  "REVIEW_RUNNING",
  "IMPROVEMENT_RUNNING",
  "RENDER_RUNNING",
]);

/**
 * The engine's reason, minus its machine prefix.
 *
 * Blocking reasons arrive as `UNSUPPORTED_CLAIM: "Data Governance…"`. The sentence after the colon
 * is the part a person can act on; the prefix is a category name for diagnostics. This strips ONLY
 * a leading SCREAMING_SNAKE token and its colon, and never rewords what follows — the untouched
 * string is still shown verbatim in the expanded detail.
 */
export function humaniseReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const stripped = reason.replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, "").trim();
  return stripped.length > 0 ? stripped : reason;
}

export function presentResumeStatus(input: ResumeStatusInput): ResumeStatusPresentation {
  const { workflowStatus, readiness, humanMaySend } = input;

  if (workflowStatus !== null && RUNNING_STATUSES.has(workflowStatus)) {
    return { key: "generating", label: "Generating", tone: "info", hint: "JobHunt is still working on this.", sendable: false };
  }

  if (readiness === null) {
    return {
      key: "unknown",
      label: "Not validated yet",
      tone: "neutral",
      hint: "No review has been recorded for this resume.",
      sendable: false,
    };
  }

  /* The one blocked state a person can resolve themselves. Checked before BLOCKED so it does not
   * read as a dead end — but deliberately NOT sendable: refreshing runs the checks, it does not
   * pass them. */
  if (input.isLegacyMissingAnalysis && input.canRevalidate && humanMaySend !== true) {
    return {
      key: "needs-refresh",
      label: "Validation needs refresh",
      tone: "warning",
      hint: "Reviewed before JobHunt's current safety checks existed.",
      sendable: false,
    };
  }

  if (readiness === "READY_FOR_HUMAN_APPLICATION" && humanMaySend === true) {
    return { key: "ready", label: "Ready to use", tone: "success", hint: null, sendable: true };
  }

  if (readiness === "BLOCKED") {
    return {
      key: "blocked",
      label: "Blocked",
      tone: "danger",
      hint: humaniseReason(input.blockingReason) ?? "This resume can't be sent yet.",
      sendable: false,
    };
  }

  /* NEEDS_IMPROVEMENT, and anything the engine adds later. Never sendable from here: only an
   * explicit READY_FOR_HUMAN_APPLICATION plus humanMaySend gets that. */
  return {
    key: "needs-review",
    label: "Needs your review",
    tone: "warning",
    hint: humaniseReason(input.blockingReason) ?? "Validation stopped short of clearing on its own.",
    sendable: false,
  };
}

/** Library filter buckets. `all` is not listed because it is the absence of a filter. */
export const RESUME_FILTERS = [
  { id: "ready", label: "Ready", keys: ["ready"] as ResumeStatusKey[] },
  { id: "needs-review", label: "Needs review", keys: ["needs-review", "needs-refresh"] as ResumeStatusKey[] },
  { id: "blocked", label: "Blocked", keys: ["blocked"] as ResumeStatusKey[] },
] as const;

export type ResumeFilterId = (typeof RESUME_FILTERS)[number]["id"] | "all";
