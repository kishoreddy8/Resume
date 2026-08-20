import type { RunStatus } from "@/lib/apply/runState";

/**
 * How each run state is presented.
 *
 * THE STATES ARE THE ENGINE'S OWN. Nothing here invents a status, merges two, or infers one from
 * another — the shape and word come from the state the run is actually in. A parallel display model
 * would be a second source of truth about whether an application was submitted.
 *
 * STATE IS NEVER COLOUR ALONE. Every entry carries a word AND a marker shape, so the display holds
 * up in greyscale, at low vision, and for every form of colour blindness.
 */

export type Marker = "waiting" | "running" | "done" | "stopped" | "unknown";

export interface StatusPresentation {
  /** The state in the user's words. Never "failed" for something that is merely waiting. */
  label: string;
  marker: Marker;
  /** True when a person has something to do. Drives ordering and the "needs you" grouping. */
  needsUser: boolean;
}

export const STATUS_PRESENTATION: Record<RunStatus, StatusPresentation> = {
  QUEUED: { label: "Queued", marker: "waiting", needsUser: false },
  STARTING: { label: "Starting", marker: "running", needsUser: false },
  NAVIGATING: { label: "Opening application", marker: "running", needsUser: false },
  ACCOUNT_REQUIRED: { label: "Account needed", marker: "waiting", needsUser: true },
  FILLING: { label: "Filling in", marker: "running", needsUser: false },
  WAITING_FOR_ANSWER: { label: "Needs your answer", marker: "waiting", needsUser: true },
  WAITING_FOR_CAPTCHA: { label: "Needs a CAPTCHA", marker: "waiting", needsUser: true },
  WAITING_FOR_MFA: { label: "Needs a verification code", marker: "waiting", needsUser: true },
  WAITING_FOR_EMAIL_VERIFICATION: { label: "Needs email verification", marker: "waiting", needsUser: true },
  READY_FOR_REVIEW: { label: "Ready for your review", marker: "waiting", needsUser: true },
  WAITING_FOR_SUBMIT_APPROVAL: { label: "Awaiting your approval", marker: "waiting", needsUser: true },
  SUBMITTING: { label: "Submitting", marker: "running", needsUser: false },
  SUBMITTED: { label: "Submitted", marker: "done", needsUser: false },
  /* Deliberately not "failed". The click happened; what is unknown is whether it landed. */
  SUBMISSION_UNCONFIRMED: { label: "Submitted — unconfirmed", marker: "unknown", needsUser: true },
  FAILED: { label: "Stopped", marker: "stopped", needsUser: false },
  CANCELLED: { label: "Cancelled", marker: "stopped", needsUser: false },
};

/** Marker classes. Shapes differ, not just hues — see the note above. */
export const MARKER_CLASS: Record<Marker, string> = {
  done: "bg-[var(--success)]",
  running: "bg-[var(--accent)]",
  waiting: "bg-transparent ring-2 ring-inset ring-[var(--accent)]",
  unknown: "bg-transparent ring-2 ring-inset ring-[var(--warning)]",
  stopped: "bg-transparent ring-1 ring-inset ring-[var(--border)]",
};

export const MARKER_TEXT: Record<Marker, string> = {
  done: "text-[var(--success)]",
  running: "text-[var(--accent)]",
  waiting: "text-[var(--accent)]",
  unknown: "text-[var(--warning)]",
  stopped: "text-tertiary",
};

export function presentStatus(status: string): StatusPresentation {
  return (
    STATUS_PRESENTATION[status as RunStatus] ?? {
      /* An unrecognised state is shown verbatim rather than guessed at — if the engine gains one,
       * the UI says what it is instead of quietly mislabelling it. */
      label: status.replace(/_/g, " ").toLowerCase(),
      marker: "unknown",
      needsUser: false,
    }
  );
}
