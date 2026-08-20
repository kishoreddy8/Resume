import { createNotificationIfAbsent } from "@/db/queries/notifications";
import { isWaiting, type RunStatus } from "./runState";

/**
 * Notifications for application runs.
 *
 * EMITTED FROM OUTSIDE THE EXECUTOR, DELIBERATELY. The execution engine is protected and knows
 * nothing about notifications; this is called by the API route after a run returns, so the UI layer
 * reacts to state rather than the engine reaching into it.
 *
 * ONLY REAL TRANSITIONS. Each notification names a state the run actually reached — there is no
 * "your application is progressing", no periodic nudge, nothing emitted on a timer. The dedupe key
 * is the run plus the status, so a run that pauses, resumes and pauses again on the SAME thing does
 * not notify twice, while a genuinely new state does.
 *
 * WAITING IS NOT FAILURE. A paused run says what it needs; the wording never calls it an error,
 * because the system is working correctly and simply cannot proceed without a person.
 */

interface NotifiableRun {
  id: number;
  candidate_id: number;
  status: RunStatus;
  blocking_question: string | null;
}

/** Title and body per state. Absent means that state is not worth interrupting anyone for. */
function messageFor(run: NotifiableRun, role: string, company: string | null): { title: string; body: string } | null {
  const where = company ? `${role} at ${company}` : role;

  switch (run.status) {
    case "WAITING_FOR_ANSWER":
      return {
        title: "An application needs your answer",
        body: run.blocking_question
          ? `${where} asked: "${run.blocking_question}"`
          : `${where} asked something Career-Ops does not have an answer for.`,
      };
    case "WAITING_FOR_CAPTCHA":
      return { title: "An application needs you to complete a CAPTCHA", body: `${where} is waiting in the browser.` };
    case "WAITING_FOR_MFA":
      return { title: "An application needs a verification code", body: `${where} is waiting for you to enter it.` };
    case "WAITING_FOR_EMAIL_VERIFICATION":
      return { title: "An application needs email verification", body: `${where} is waiting for you to confirm it.` };
    case "ACCOUNT_REQUIRED":
      return { title: "An application needs an account", body: `${where} requires signing in before you can apply.` };
    case "READY_FOR_REVIEW":
      return { title: "An application is ready for your review", body: `${where} is filled in and waiting for you to check it.` };
    case "SUBMITTED":
      return { title: "Application submitted", body: `${where} was submitted and the site confirmed receipt.` };
    case "SUBMISSION_UNCONFIRMED":
      return {
        title: "An application may not have gone through",
        body: `${where} was submitted but the site did not confirm receipt. Please check.`,
      };
    case "FAILED":
      return { title: "An application stopped", body: `${where} hit a problem and stopped safely. Nothing was submitted.` };
    default:
      /* QUEUED, STARTING, NAVIGATING, FILLING, SUBMITTING and WAITING_FOR_SUBMIT_APPROVAL are
       * transient or already on screen. Interrupting someone for them would be noise. */
      return null;
  }
}

/** Returns true when a NEW notification was created. Safe to call after every run transition. */
export function notifyApplicationState(run: NotifiableRun, role: string, company: string | null): boolean {
  const message = messageFor(run, role, company);
  if (!message) return false;

  return createNotificationIfAbsent({
    candidateId: run.candidate_id,
    /* Run + status: the same pause on the same run notifies once, a different state notifies
     * again. Including the question would re-notify for a re-worded prompt, which is noise. */
    dedupeKey: `application-run:${run.id}:${run.status}`,
    type: isWaiting(run.status) ? "application_needs_attention" : "application_outcome",
    title: message.title,
    body: message.body,
  });
}
