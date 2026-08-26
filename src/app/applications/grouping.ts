import { presentStatus } from "./runStatus";

/**
 * Which of the five candidate-facing groups a run belongs to.
 *
 * UI-A — this was a four-group model (needs-action/in-progress/submitted/completed) that collapsed
 * two genuinely different things into one bucket each:
 *   - "needs-action" covered both "answer a question" (WAITING_FOR_ANSWER, verification, account
 *     setup) and "go read and approve this" (READY_FOR_REVIEW, WAITING_FOR_SUBMIT_APPROVAL) — the
 *     same action verb, "needs you", for two different candidate intents.
 *   - "completed" covered a genuine engine failure (FAILED) and a routine, unremarkable candidate
 *     cancellation (CANCELLED) under one success-toned ("completed") label, while a run whose
 *     submission could not be CONFIRMED (SUBMISSION_UNCONFIRMED — needsUser: true) sorted into
 *     "needs-action" instead, nowhere near the other terminal-but-uncertain outcomes it belongs with.
 *
 * DERIVED FROM `presentStatus`, NOT FROM THE STATUS STRING, wherever that alone is enough to decide
 * — so there is exactly one place that knows what a run state means. The two `status ===` checks
 * below are the only exceptions, and both are forced: READY_FOR_REVIEW and WAITING_FOR_SUBMIT_
 * APPROVAL share the identical (marker: "waiting", needsUser: true) shape as WAITING_FOR_ANSWER and
 * every verification state in STATUS_PRESENTATION, so nothing on that shared shape can distinguish
 * "answer a question" from "go review and approve" — the same pattern `primaryActionLabel` and
 * `applicationContext` already use elsewhere in this file for the same reason.
 */

export type ApplicationGroupId = "needs-you" | "in-progress" | "ready-for-review" | "submitted" | "needs-attention";

export interface ApplicationGroup {
  id: ApplicationGroupId;
  /** Heading above the rows. */
  label: string;
  /** Summary-card label. */
  cardLabel: string;
  /** Summary-card supporting line. */
  cardHint: string;
}

export const APPLICATION_GROUPS: ApplicationGroup[] = [
  {
    id: "needs-you",
    label: "Needs you",
    cardLabel: "Needs You",
    cardHint: "Answer a question or continue",
  },
  {
    id: "in-progress",
    label: "In progress",
    cardLabel: "In Progress",
    cardHint: "Applications running",
  },
  {
    id: "ready-for-review",
    label: "Ready for review",
    cardLabel: "Ready for Review",
    cardHint: "Read it, then approve to submit",
  },
  {
    id: "submitted",
    label: "Submitted",
    cardLabel: "Submitted",
    cardHint: "Sent to employers",
  },
  {
    id: "needs-attention",
    label: "Needs attention",
    cardLabel: "Needs Attention",
    cardHint: "Stopped, cancelled, or unconfirmed",
  },
];

export function groupForStatus(status: string): ApplicationGroupId {
  if (status === "READY_FOR_REVIEW" || status === "WAITING_FOR_SUBMIT_APPROVAL") return "ready-for-review";

  const p = presentStatus(status);
  /* SUBMISSION_UNCONFIRMED (marker: "unknown") joins FAILED/CANCELLED (marker: "stopped") here —
   * all three are terminal-or-uncertain outcomes a candidate should look at, not routine "type an
   * answer" states. Its row keeps its own honest label ("Submission unconfirmed"), never "Stopped". */
  if (p.marker === "stopped" || p.marker === "unknown") return "needs-attention";
  if (p.marker === "done") return "submitted";
  if (p.needsUser) return "needs-you";
  /* running and waiting-without-a-person: queued, starting, navigating, filling, submitting. */
  return "in-progress";
}

/**
 * The one action a row offers, worded for the state it is in.
 *
 * Every string is a verb for something the detail page can actually do. Where the engine has no
 * action for a state, the row still opens — reading what happened is itself the next step.
 */
export function primaryActionLabel(status: string): string {
  switch (status) {
    case "WAITING_FOR_ANSWER":
      return "Continue";
    case "WAITING_FOR_CAPTCHA":
    case "WAITING_FOR_MFA":
    case "WAITING_FOR_EMAIL_VERIFICATION":
      return "Complete verification";
    case "ACCOUNT_REQUIRED":
      return "Continue setup";
    case "READY_FOR_REVIEW":
      return "Review application";
    case "WAITING_FOR_SUBMIT_APPROVAL":
      return "Review & approve";
    case "SUBMITTING":
      return "View progress";
    case "SUBMISSION_UNCONFIRMED":
      return "Review submission status";
    case "SUBMITTED":
      return "View submission";
    case "FAILED":
    case "CANCELLED":
      return "View history";
    default:
      return "View progress";
  }
}

/** One concise, candidate-facing explanation. Server prompts remain authoritative when present. */
export function applicationContext(status: string, prompt: string | null): string {
  if (prompt) return prompt;
  switch (status) {
    case "QUEUED":
      return "Waiting to begin.";
    case "STARTING":
      return "Preparing the application.";
    case "NAVIGATING":
      return "Opening the employer application.";
    case "FILLING":
      return "Completing supported application fields.";
    case "SUBMITTING":
      return "Sending the application you approved.";
    case "SUBMITTED":
      return "The employer site confirmed submission.";
    case "SUBMISSION_UNCONFIRMED":
      return "Career-Ops attempted submission but could not confirm the employer site accepted it.";
    case "FAILED":
      return "This application run stopped.";
    case "CANCELLED":
      return "This application was cancelled.";
    default:
      return "Open this application for the latest status.";
  }
}

/**
 * The phase a detail view should lead with.
 *
 * A presentation grouping over the engine's real states — it invents no state and changes no
 * transition. "tracking" is reached only once the engine itself says the run is past submitting.
 */
export type DetailPhase =
  | "preparing"
  | "filling"
  | "needs-input"
  | "verification"
  | "review"
  | "submitting"
  | "tracking";

export function detailPhase(status: string): DetailPhase {
  switch (status) {
    case "QUEUED":
    case "STARTING":
    case "NAVIGATING":
      return "preparing";
    case "FILLING":
      return "filling";
    case "WAITING_FOR_ANSWER":
      return "needs-input";
    case "WAITING_FOR_CAPTCHA":
    case "WAITING_FOR_MFA":
    case "WAITING_FOR_EMAIL_VERIFICATION":
    case "ACCOUNT_REQUIRED":
      return "verification";
    case "READY_FOR_REVIEW":
    case "WAITING_FOR_SUBMIT_APPROVAL":
      return "review";
    case "SUBMITTING":
      return "submitting";
    case "SUBMITTED":
    case "SUBMISSION_UNCONFIRMED":
    case "FAILED":
    case "CANCELLED":
      return "tracking";
    default:
      return "preparing";
  }
}
