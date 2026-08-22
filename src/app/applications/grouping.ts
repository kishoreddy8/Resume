import { presentStatus, type Marker } from "./runStatus";

/**
 * Which of the four candidate-facing groups a run belongs to.
 *
 * DERIVED FROM `presentStatus`, NOT FROM THE STATUS STRING. Every decision below reads the existing
 * presentation contract — `needsUser` and `marker` — so there is exactly one place that knows what
 * a run state means. A second switch over RunStatus here is how "Submitted" and "needs you" would
 * eventually disagree between the list and the detail.
 *
 * "Completed" is the lifecycle bucket for runs that have ended without a confirmed submission.
 * The row keeps the engine-derived candidate label (Stopped or Cancelled), so the group never turns
 * an unsuccessful outcome into a successful one.
 *
 * WHY SUBMISSION_UNCONFIRMED IS NOT UNDER "SUBMITTED". Its `needsUser` is true — the click happened
 * but nothing confirmed it landed, and that is a thing a person has to check. It sorts into "Needs
 * your action" for exactly that reason, and its row still reads "Submission unconfirmed".
 */

export type ApplicationGroupId = "needs-action" | "in-progress" | "submitted" | "completed";

export interface ApplicationGroup {
  id: ApplicationGroupId;
  /** Heading above the rows. */
  label: string;
  /** Summary-card label. */
  cardLabel: string;
  /** Summary-card supporting line. */
  cardHint: string;
  tone: "warning" | "accent" | "info" | "success";
}

export const APPLICATION_GROUPS: ApplicationGroup[] = [
  {
    id: "needs-action",
    label: "Needs your action",
    cardLabel: "Needs your action",
    cardHint: "Requires your input",
    tone: "warning",
  },
  {
    id: "in-progress",
    label: "In progress",
    cardLabel: "In progress",
    cardHint: "Applications running",
    tone: "accent",
  },
  {
    id: "submitted",
    label: "Submitted",
    cardLabel: "Submitted",
    cardHint: "Sent to employers",
    tone: "info",
  },
  {
    id: "completed",
    label: "Completed",
    cardLabel: "Completed",
    cardHint: "Finished or cancelled",
    tone: "success",
  },
];

export function groupForStatus(status: string): ApplicationGroupId {
  const p = presentStatus(status);
  if (p.needsUser) return "needs-action";

  const marker: Marker = p.marker;
  if (marker === "done") return "submitted";
  if (marker === "stopped") return "completed";
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
      return "JobHunt attempted submission but could not confirm the employer site accepted it.";
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
