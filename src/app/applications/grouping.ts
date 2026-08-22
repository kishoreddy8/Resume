import { presentStatus, type Marker } from "./runStatus";
import { candidateStatus } from "@/lib/candidateStatus";

/**
 * Which of the four candidate-facing groups a run belongs to.
 *
 * DERIVED FROM `presentStatus`, NOT FROM THE STATUS STRING. Every decision below reads the existing
 * presentation contract — `needsUser` and `marker` — so there is exactly one place that knows what
 * a run state means. A second switch over RunStatus here is how "Submitted" and "needs you" would
 * eventually disagree between the list and the detail.
 *
 * WHY "CLOSED" AND NOT "COMPLETED". The reference's fourth card says Completed / Process finished.
 * The engine has no completed state: what actually lands there is FAILED ("Stopped") and CANCELLED,
 * neither of which finished anything. Calling a stopped application "completed" would be the single
 * most misleading word on the page, so the card keeps its position and takes the truthful name.
 *
 * WHY SUBMISSION_UNCONFIRMED IS NOT UNDER "SUBMITTED". Its `needsUser` is true — the click happened
 * but nothing confirmed it landed, and that is a thing a person has to check. It sorts into "Needs
 * your action" for exactly that reason, and its row still reads "Submitted — unconfirmed".
 */

export type ApplicationGroupId = "needs-action" | "in-progress" | "submitted" | "closed";

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
    label: candidateStatus("needsYourAction").label,
    cardLabel: candidateStatus("needsYourAction").label,
    cardHint: "Requires your input",
    tone: "warning",
  },
  {
    id: "in-progress",
    label: candidateStatus("inProgress").label,
    cardLabel: candidateStatus("inProgress").label,
    cardHint: "Applications running",
    tone: "accent",
  },
  {
    id: "submitted",
    label: candidateStatus("submitted").label,
    cardLabel: candidateStatus("submitted").label,
    cardHint: "Sent to employers",
    tone: "info",
  },
  {
    id: "closed",
    label: candidateStatus("closed").label,
    cardLabel: candidateStatus("closed").label,
    cardHint: "Stopped or cancelled",
    tone: "success",
  },
];

export function groupForStatus(status: string): ApplicationGroupId {
  const p = presentStatus(status);
  if (p.needsUser) return "needs-action";

  const marker: Marker = p.marker;
  if (marker === "done") return "submitted";
  if (marker === "stopped") return "closed";
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
      return "Answer question";
    case "WAITING_FOR_CAPTCHA":
    case "WAITING_FOR_MFA":
    case "WAITING_FOR_EMAIL_VERIFICATION":
      return "Complete now";
    case "ACCOUNT_REQUIRED":
      return "Set up account";
    case "READY_FOR_REVIEW":
    case "WAITING_FOR_SUBMIT_APPROVAL":
      return "Review application";
    case "SUBMISSION_UNCONFIRMED":
      return "Check status";
    case "SUBMITTED":
      return "View application";
    default:
      return "Open";
  }
}

/**
 * The phase a detail view should lead with.
 *
 * A presentation grouping over the engine's real states — it invents no state and changes no
 * transition. "tracking" is reached only once the engine itself says the run is past submitting.
 */
export type DetailPhase = "needs-input" | "verification" | "review" | "submitting" | "tracking";

export function detailPhase(status: string): DetailPhase {
  switch (status) {
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
      return "submitting";
  }
}
