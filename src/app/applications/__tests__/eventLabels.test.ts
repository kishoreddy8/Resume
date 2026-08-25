import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { eventLabel } from "../eventLabels";
import { STATUS_PRESENTATION } from "../runStatus";

/**
 * UI-0 DEFECT 2 — the application timeline's event labels.
 *
 * ROOT CAUSE PINNED: the old `eventLabel()` looked up a lowercase, snake_case `event_type`
 * (`field_filled`) directly against `STATUS_PRESENTATION`, keyed by uppercase `RunStatus`
 * (`FILLING`). No event type is ever a RunStatus value verbatim, so the lookup always missed.
 *
 * THE KNOWN PRODUCTION EVENT TAXONOMY, verified 2026-08-25 as the union of every literal
 * `recordEvent(...)` call site in `src/lib/apply/**` at this repository's committed HEAD, plus the
 * distinct event types observed in the real `application_run_events` table (which additionally
 * reflects the still-uncommitted Phase 9E work already running against real applications). Every
 * one of these must resolve to something other than the generic fallback.
 */
const KNOWN_EVENT_TYPES = [
  // committed-HEAD literal recordEvent calls
  "account_created",
  "account_creation_started",
  "already_applied_detected",
  "auth_required",
  "auth_resumed",
  "blocking_detected",
  "captcha_required",
  "credential_found",
  "credential_missing",
  "email_verification_required",
  "execution_error",
  "human_question_batch_created",
  "invalid_credentials",
  "login_failed",
  "login_started",
  "login_succeeded",
  "multi_page_limit_reached",
  "page_advanced",
  "page_did_not_advance",
  "review_page_detected",
  "submit_attempted",
  "submit_preflight_auth_blocked",
  "submit_preflight_new_question",
  "unconfirmed",
  "document_uploaded",
  "field_filled",
  "run_created",
  // observed in the real application_run_events table (Phase 9E, currently uncommitted)
  "application_entry_completed",
  "application_entry_failed",
  "entry_step_completed",
  "entry_step_missing",
  "entry_step_skipped",
  "no_application_form_found",
  "question_barrier_validation",
  "unresolved_questions_accumulated",
  "user_intervention_completed",
];

const KNOWN_STATUS_EVENT_TYPES = Object.keys(STATUS_PRESENTATION).map((s) => `status_${s.toLowerCase()}`);

test("UI-ACTIVITY-01: every known application event type has a meaningful, non-generic label", () => {
  for (const type of [...KNOWN_EVENT_TYPES, ...KNOWN_STATUS_EVENT_TYPES]) {
    const label = eventLabel(type, null);
    assert.notEqual(label, "Application updated", `${type} must not collapse to the generic fallback`);
    assert.ok(label.trim().length > 0, `${type} must have a non-empty label`);
  }
});

test("UI-ACTIVITY-02: known event types do not collapse to the same generic string as each other", () => {
  /* The old bug produced ~100 identical rows for one real run. Confirm real distinctness across a
   * representative slice of genuinely different actions. */
  const distinctSample = [
    "login_succeeded",
    "field_filled",
    "page_advanced",
    "human_question_batch_created",
    "multi_page_limit_reached",
    "application_entry_completed",
  ];
  const labels = distinctSample.map((t) => eventLabel(t, null));
  assert.equal(new Set(labels).size, labels.length, "each distinct real event must produce a distinct label");
});

test("UI-ACTIVITY-03: an unknown event type safely falls back to honest, neutral copy", () => {
  assert.equal(eventLabel("some_future_event_type", null), "Application updated");
  assert.equal(eventLabel("", null), "Application updated");
});

test("status_* events resolve generically through STATUS_PRESENTATION — one source of truth, not a second copy", () => {
  assert.equal(eventLabel("status_waiting_for_answer", null), STATUS_PRESENTATION.WAITING_FOR_ANSWER.label);
  assert.equal(eventLabel("status_filling", null), STATUS_PRESENTATION.FILLING.label);
  assert.equal(eventLabel("status_submitted", null), STATUS_PRESENTATION.SUBMITTED.label);
  assert.equal(eventLabel("status_failed", null), STATUS_PRESENTATION.FAILED.label);
});

test("repeated entry_step_completed events (one per pre-form control) do not all print the identical sentence", () => {
  const notice = eventLabel("entry_step_completed", 'dismiss_notice: [data-automation-id="legalNoticeAcceptButton"]');
  const apply = eventLabel("entry_step_completed", 'enter_application: [data-automation-id="adventureButton"]');
  const applyManually = eventLabel("entry_step_completed", 'enter_application: [data-automation-id="applyManually"]');
  assert.notEqual(notice, apply, "dismissing a notice and opening the application must read differently");
  assert.equal(apply, applyManually, "two enter_application steps may legitimately share the same narration");
});

test("eventLabel is pure and total: never throws, always returns a string, for any input", () => {
  const weirdInputs = [null, undefined, "STATUS_WEIRD", "status_", "status_not_a_real_status", 123 as unknown as string];
  for (const input of weirdInputs) {
    assert.doesNotThrow(() => eventLabel(input as string, null));
    assert.equal(typeof eventLabel(input as string, null), "string");
  }
});

test("UI-0.1 checkpoint fix: submit_attempted does not claim success — it fires before the outcome is known", () => {
  /* executor.ts records submit_attempted with outcome.evidence BEFORE branching on
   * outcome.confirmed into SUBMITTED vs SUBMISSION_UNCONFIRMED. The label for this one event must
   * not assert a completed, successful submission — that is exactly the fabrication-of-certainty
   * this whole initiative exists to remove. */
  const label = eventLabel("submit_attempted", null);
  assert.doesNotMatch(label, /^Submitted\b/i, "must not read as a completed, confirmed submission");
  assert.match(label, /attempt/i, "must communicate that the outcome is not yet established");
});

test("ApplicationDetail no longer defines its own broken local eventLabel, and imports the fixed one", () => {
  const source = fs.readFileSync("src/app/applications/[id]/ApplicationDetail.tsx", "utf8");
  assert.doesNotMatch(source, /function eventLabel\(/, "the broken local implementation must be removed");
  assert.match(source, /from "\.\.\/eventLabels"/, "the fixed, shared implementation must be imported");
  assert.match(source, /eventLabel\(event\.event_type, event\.detail\)/, "detail is passed through for entry-step disambiguation");
});
