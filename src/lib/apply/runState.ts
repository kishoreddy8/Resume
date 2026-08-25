/**
 * The application run state machine.
 *
 * WHY EVERY WAITING STATE IS DISTINCT. "Blocked" would be simpler and useless: waiting for a
 * CAPTCHA, an MFA code, an unknown answer and a submit approval need four different things from the
 * user, and collapsing them into one status means the inbox cannot tell them what to do.
 *
 * THE ONE RULE THAT MATTERS. SUBMITTING is reachable only from WAITING_FOR_SUBMIT_APPROVAL. There
 * is no path from FILLING, from READY_FOR_REVIEW, or from any waiting state directly to submission.
 * A transition table makes that structural rather than a check someone can forget to write.
 */

export type RunStatus =
  | "QUEUED"
  | "STARTING"
  | "NAVIGATING"
  | "ACCOUNT_REQUIRED"
  | "FILLING"
  | "WAITING_FOR_ANSWER"
  | "WAITING_FOR_CAPTCHA"
  | "WAITING_FOR_MFA"
  | "WAITING_FOR_EMAIL_VERIFICATION"
  | "READY_FOR_REVIEW"
  | "WAITING_FOR_SUBMIT_APPROVAL"
  | "SUBMITTING"
  | "SUBMITTED"
  | "SUBMISSION_UNCONFIRMED"
  | "FAILED"
  | "CANCELLED";

/** States where the run is stopped and the user has something to do. */
export const WAITING_STATES: readonly RunStatus[] = [
  "ACCOUNT_REQUIRED",
  "WAITING_FOR_ANSWER",
  "WAITING_FOR_CAPTCHA",
  "WAITING_FOR_MFA",
  "WAITING_FOR_EMAIL_VERIFICATION",
  "READY_FOR_REVIEW",
  "WAITING_FOR_SUBMIT_APPROVAL",
];

export const TERMINAL_STATES: readonly RunStatus[] = ["SUBMITTED", "SUBMISSION_UNCONFIRMED", "FAILED", "CANCELLED"];

/**
 * Legal transitions.
 *
 * Note what is absent: nothing reaches SUBMITTING except WAITING_FOR_SUBMIT_APPROVAL. That is the
 * human-approval contract expressed as a graph, so violating it is impossible rather than merely
 * discouraged.
 */
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  /* FAILED is reachable from QUEUED: a run can be unstartable — no application URL, no adapter —
   * and discovering that before opening a browser must still be recordable as a failure. Without
   * it the executor's own guard threw an illegal-transition error instead of failing cleanly. */
  QUEUED: ["STARTING", "FAILED", "CANCELLED"],
  STARTING: ["NAVIGATING", "FAILED", "CANCELLED"],
  /* Every verification wall is reachable while navigating, not only while filling. A login gate
   * asking for an emailed code appears before any form does, and omitting those two edges made a
   * real MFA page fail the run instead of pausing it. */
  NAVIGATING: [
    "ACCOUNT_REQUIRED",
    "FILLING",
    "WAITING_FOR_CAPTCHA",
    "WAITING_FOR_MFA",
    "WAITING_FOR_EMAIL_VERIFICATION",
    "FAILED",
    "CANCELLED",
  ],
  ACCOUNT_REQUIRED: ["NAVIGATING", "FILLING", "WAITING_FOR_MFA", "WAITING_FOR_EMAIL_VERIFICATION", "FAILED", "CANCELLED"],
  /* ACCOUNT_REQUIRED is reachable while FILLING since the multi-page walk: a login wall can sit
   * between two form pages, discovered only after a safe Next — the same reality that already put
   * every verification wall on NAVIGATING's list. The submission boundary is untouched: FILLING
   * still cannot reach SUBMITTING or WAITING_FOR_SUBMIT_APPROVAL (asserted by RUN-2). */
  FILLING: [
    "WAITING_FOR_ANSWER",
    "WAITING_FOR_CAPTCHA",
    "WAITING_FOR_MFA",
    "WAITING_FOR_EMAIL_VERIFICATION",
    "ACCOUNT_REQUIRED",
    "READY_FOR_REVIEW",
    "FAILED",
    "CANCELLED",
  ],
  WAITING_FOR_ANSWER: ["FILLING", "CANCELLED", "FAILED"],
  WAITING_FOR_CAPTCHA: ["FILLING", "NAVIGATING", "CANCELLED", "FAILED"],
  WAITING_FOR_MFA: ["FILLING", "NAVIGATING", "CANCELLED", "FAILED"],
  WAITING_FOR_EMAIL_VERIFICATION: ["FILLING", "NAVIGATING", "CANCELLED", "FAILED"],
  READY_FOR_REVIEW: ["WAITING_FOR_SUBMIT_APPROVAL", "FILLING", "CANCELLED", "FAILED"],
  WAITING_FOR_SUBMIT_APPROVAL: ["SUBMITTING", "READY_FOR_REVIEW", "CANCELLED"],
  SUBMITTING: ["SUBMITTED", "SUBMISSION_UNCONFIRMED", "FAILED"],
  SUBMITTED: [],
  SUBMISSION_UNCONFIRMED: ["SUBMITTED", "FAILED"],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isWaiting(status: RunStatus): boolean {
  return WAITING_STATES.includes(status);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/** What the user is being asked for, in their words. Never "blocked". */
export const WAITING_PROMPT: Partial<Record<RunStatus, string>> = {
  ACCOUNT_REQUIRED: "This site needs an account before you can apply.",
  WAITING_FOR_ANSWER: "This application asked something Career-Ops does not have an answer for.",
  WAITING_FOR_CAPTCHA: "Complete the CAPTCHA in the application browser, then resume.",
  WAITING_FOR_MFA: "Enter the verification code this site sent you.",
  WAITING_FOR_EMAIL_VERIFICATION: "Confirm the verification email this site sent, then resume.",
  READY_FOR_REVIEW: "The application is filled in and ready for you to review.",
  WAITING_FOR_SUBMIT_APPROVAL: "Review the application and approve it before anything is submitted.",
};
