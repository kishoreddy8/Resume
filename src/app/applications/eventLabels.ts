import { STATUS_PRESENTATION } from "./runStatus";
import type { RunStatus } from "@/lib/apply/runState";

/**
 * UI-0 DEFECT 2 — the application timeline's real event labels.
 *
 * THE BUG THIS REPLACES. `eventLabel()` looked up a lowercase, `application_run_events`-style event
 * type (`field_filled`, `login_succeeded`, `page_advanced`) directly against `STATUS_PRESENTATION`,
 * which is keyed by uppercase `RunStatus` values (`FILLING`, `SUBMITTED`). The two vocabularies never
 * intersect at a single value, so the lookup always missed and every row rendered the fallback,
 * "Application updated" — turning a genuinely informative ~100-event run history into pure noise.
 *
 * TWO GENUINELY DIFFERENT KINDS OF EVENT, HANDLED DIFFERENTLY. `advanceRun` (applicationRuns.ts)
 * emits `status_${to.toLowerCase()}` on every state transition — these DO share a real contract
 * with `RunStatus` (the suffix, uppercased, IS a RunStatus) and are resolved generically through the
 * existing `STATUS_PRESENTATION` table below, so a status wording change never has to be made twice.
 * Everything else is a narration event the engine records about what it actually DID — those have no
 * RunStatus counterpart at all, and are given their own specific, human sentence.
 *
 * NO FAKE PRECISION. Every label describes only what the recorded event actually establishes. An
 * event with no known mapping falls back to the same honest, neutral copy the old code used for its
 * one success case — never a guess at what might have happened.
 */

const STATUS_EVENT_PREFIX = "status_";

/** Non-status narration events, each mapped to what Career-Ops actually did or observed. Detail
 *  (the field name, file name, tenant, etc.) renders separately below the label — see
 *  ApplicationDetail.tsx — so labels here describe the ACTION, not the specific value. */
const EVENT_LABEL: Record<string, string> = {
  run_created: "Application started",

  auth_required: "This site requires signing in",
  credential_found: "Found a saved sign-in for this site",
  credential_missing: "No saved sign-in found for this site",
  account_creation_started: "Creating an account on this site",
  account_created: "Created an account on this site",
  login_started: "Signing in",
  login_succeeded: "Signed in",
  login_failed: "The sign-in attempt failed",
  invalid_credentials: "The saved sign-in was rejected",
  auth_resumed: "Resumed after signing in",

  captcha_required: "This site requires a CAPTCHA",
  mfa_required: "This site requires a verification code",
  email_verification_required: "This site requires email verification",
  blocking_detected: "Paused — this site needs your attention",

  field_filled: "Filled in a field",
  document_uploaded: "Attached a document",

  page_advanced: "Moved to the next page",
  page_did_not_advance: "This page did not move forward",
  review_page_detected: "Reached the review page",
  multi_page_limit_reached: "Stopped — this application was longer than the safe limit",
  no_application_form_found: "Could not find the application form",
  already_applied_detected: "This site reports an application already exists",

  application_entry_completed: "Opened the application",
  application_entry_failed: "Could not open the application",
  entry_step_missing: "A step in opening the application could not be found",

  human_question_batch_created: "Questions need your input",
  unresolved_questions_accumulated: "Found more questions to answer",
  question_barrier_validation: "Paused — this page needs answers first",
  user_intervention_completed: "You answered the questions",

  submit_preflight_auth_blocked: "Paused before submitting — needs signing in first",
  submit_preflight_new_question: "Paused before submitting — a new question appeared",
  /* Recorded the instant the submit control is clicked, BEFORE the outcome is known — see
   * executor.ts: `recordEvent(runId, "submit_attempted", outcome.evidence)` runs before the
   * confirmed/unconfirmed branch is decided. The immediately-following status_submitted /
   * status_submission_unconfirmed event is what actually resolves the outcome; this row must not
   * claim success on its own. */
  submit_attempted: "Attempted to submit the application",
  unconfirmed: "Could not confirm the submission",

  execution_error: "Something went wrong and the run stopped safely",
};

/**
 * `entry_step_completed` and `entry_step_skipped` fire once per pre-form control (dismiss a cookie
 * notice, click Apply, click Apply Manually, …) and carry which KIND of step it was as the leading
 * word of `detail` (see `ApplicationEntryStep["kind"]` in src/lib/apply/entry.ts: "dismiss_notice" |
 * "enter_application"). Read that kind rather than mapping every step to one identical sentence,
 * which would otherwise print the same row three or four times in a row.
 */
function entryStepLabel(detail: string | null, verb: string): string {
  if (detail?.startsWith("dismiss_notice")) return `Dismissed a site notice`;
  if (detail?.startsWith("enter_application")) return `${verb} the application`;
  return `${verb} a step of the application`;
}

/** Event types repetitive enough (one per field/document/pre-form step) that a long run of the
 *  identical type in a row is noise rather than narration — Part 20's "collapse low-value
 *  repetitive fill events". Never includes a milestone (status change, question batch, error,
 *  submit) — those always render as their own row, however many there are. */
const COLLAPSIBLE_EVENT_TYPES = new Set(["field_filled", "document_uploaded", "entry_step_completed", "entry_step_skipped"]);

/** Never groups on a synthetic/unrecognised event — only a real, repeated, known type. */
const MIN_GROUP_SIZE = 3;

export interface TimelineEvent {
  id: number;
  event_type: string;
  detail: string | null;
  created_at: string;
}

export type TimelineItem =
  | { kind: "single"; event: TimelineEvent }
  | { kind: "group"; eventType: string; events: TimelineEvent[] };

/**
 * Groups a real event list into single rows and collapsed runs — never drops an event, never
 * reorders one, never merges two different types together. A run shorter than MIN_GROUP_SIZE stays
 * as individual rows: three fields filled in a row is not worth collapsing, thirty is.
 */
export function groupTimelineEvents(events: readonly TimelineEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let i = 0;
  while (i < events.length) {
    const type = events[i]!.event_type;
    if (COLLAPSIBLE_EVENT_TYPES.has(type)) {
      let j = i;
      while (j < events.length && events[j]!.event_type === type) j++;
      const run = events.slice(i, j);
      if (run.length >= MIN_GROUP_SIZE) {
        items.push({ kind: "group", eventType: type, events: run });
      } else {
        for (const event of run) items.push({ kind: "single", event });
      }
      i = j;
    } else {
      items.push({ kind: "single", event: events[i]! });
      i++;
    }
  }
  return items;
}

/** The summary sentence for a collapsed group, in the same "what Career-Ops did" voice as
 *  eventLabel — a real count, never rounded or estimated. */
export function groupSummaryLabel(eventType: string, count: number): string {
  switch (eventType) {
    case "field_filled":
      return `Filled in ${count} fields`;
    case "document_uploaded":
      return `Attached ${count} documents`;
    case "entry_step_completed":
      return `Continued through ${count} steps of opening the application`;
    case "entry_step_skipped":
      return `Skipped ${count} steps of opening the application`;
    default:
      return `${count} similar updates`;
  }
}

/**
 * The label for one recorded event. Pure and total — every input produces a string, never throws.
 */
export function eventLabel(eventType: string, detail: string | null = null): string {
  /* Fail closed: a record with a malformed or missing event_type must render the same honest,
   * neutral copy as a genuinely unrecognised one — never throw and never invent a description. */
  if (typeof eventType !== "string" || eventType.length === 0) return "Application updated";

  if (eventType === "entry_step_completed") return entryStepLabel(detail, "Continued to");
  if (eventType === "entry_step_skipped") return entryStepLabel(detail, "Skipped continuing to");

  const known = EVENT_LABEL[eventType];
  if (known) return known;

  if (eventType.startsWith(STATUS_EVENT_PREFIX)) {
    const statusKey = eventType.slice(STATUS_EVENT_PREFIX.length).toUpperCase() as RunStatus;
    const presentation = STATUS_PRESENTATION[statusKey];
    if (presentation) return presentation.label;
  }

  /* Unknown to this build — the honest fallback the old code always fell back to, now reached only
   * for a genuinely new or unrecognised event type rather than for nearly every row. */
  return "Application updated";
}
