import assert from "node:assert/strict";
import test from "node:test";
import {
  groupForTimestamp,
  matchesFilter,
  parseApplicationRunKey,
  presentActivityItem,
} from "../activityPresentation";

/* ============================================================================================
 * UI-ACT — SPATIAL PREMIUM ACTIVITY — TEST CONTRACT (Part 36)
 * ============================================================================================ */

test("UIACT-ACTION-01: needs-you classification for an application-run notification comes from presentStatus, not title/body text", () => {
  // WAITING_FOR_ANSWER is a real, needsUser:true RunStatus in src/app/applications/runStatus.ts.
  const waiting = presentActivityItem("application_needs_attention", "application-run:501:WAITING_FOR_ANSWER", 701);
  assert.equal(waiting.needsUser, true);
  assert.equal(waiting.statusLabel, "Needs input");

  // SUBMITTED is real and needsUser:false, even though its TYPE is "application_outcome" (the same
  // type SUBMISSION_UNCONFIRMED also uses) — proving the classification reads the real per-status
  // authority, not a coarse type-level guess.
  const submitted = presentActivityItem("application_outcome", "application-run:502:SUBMITTED", 702);
  assert.equal(submitted.needsUser, false);
  assert.equal(submitted.statusLabel, "Submitted");

  // SUBMISSION_UNCONFIRMED is real and needsUser:true, despite sharing the "application_outcome"
  // type with SUBMITTED above — this is exactly the case a type-string-only classifier would miss.
  const unconfirmed = presentActivityItem("application_outcome", "application-run:503:SUBMISSION_UNCONFIRMED", 703);
  assert.equal(unconfirmed.needsUser, true);
});

test("UIACT-ACTION-01b: HUMAN_REVIEW_REQUIRED is the one job-keyed type that needs the candidate; the other four do not", () => {
  assert.equal(presentActivityItem("HUMAN_REVIEW_REQUIRED", "job-1", 1).needsUser, true);
  for (const type of ["HIGH_VALUE_JOB_MATCH", "RESUME_READY", "WRITER_FAILURE", "QUALITY_FAILURE"]) {
    assert.equal(presentActivityItem(type, "job-1", 1).needsUser, false, `${type} should not be needsUser`);
  }
});

test("UIACT-ROUTE-01: a CTA/destination is rendered only when a real structured id is known", () => {
  // No jobId, not an application-run key -> no destination at all, not a fake one.
  const noDestination = presentActivityItem("HIGH_VALUE_JOB_MATCH", "job-1", null);
  assert.equal(noDestination.href, null);
  assert.equal(noDestination.ctaLabel, null);

  // Real jobId -> /jobs/{id}, never derived from title text.
  const withJob = presentActivityItem("HIGH_VALUE_JOB_MATCH", "job-1", 42);
  assert.equal(withJob.href, "/jobs/42");

  // Real application-run key -> /applications/{runId}, parsed from the documented dedupe_key
  // format, never from title/body prose.
  const withRun = presentActivityItem("application_needs_attention", "application-run:99:WAITING_FOR_ANSWER", null);
  assert.equal(withRun.href, "/applications/99");
});

test("UIACT-ROUTE-02: parseApplicationRunKey only matches its own documented format, never a job dedupe_key", () => {
  assert.deepEqual(parseApplicationRunKey("application-run:501:WAITING_FOR_ANSWER"), { runId: 501, status: "WAITING_FOR_ANSWER" });
  assert.equal(parseApplicationRunKey("greenhouse:acme:eng-42"), null);
  assert.equal(parseApplicationRunKey("job-12345"), null);
  assert.equal(parseApplicationRunKey("application-run:not-a-number:FAILED"), null);
});

test("UIACT-OUTCOME-01: application outcome is never automatically treated as success — tone follows the real status marker", () => {
  const submitted = presentActivityItem("application_outcome", "application-run:1:SUBMITTED", 1);
  assert.equal(submitted.tone, "success");

  const failed = presentActivityItem("application_outcome", "application-run:2:FAILED", 2);
  assert.notEqual(failed.tone, "success");

  const unconfirmed = presentActivityItem("application_outcome", "application-run:3:SUBMISSION_UNCONFIRMED", 3);
  assert.notEqual(unconfirmed.tone, "success");

  // CANCELLED is a real RunStatus, even though applicationNotifications.ts's own messageFor()
  // switch never actually fires a notification for it today (it falls to the "no interruption
  // worth it" default) — defensive coverage in case that ever changes: it must never render as
  // success either.
  const cancelled = presentActivityItem("application_outcome", "application-run:4:CANCELLED", 4);
  assert.notEqual(cancelled.tone, "success");
  assert.equal(cancelled.needsUser, false);
});

test("UIACT-RESUME-01: RESUME_READY is only ever the notification's own real type — nothing here re-derives or upgrades a resume disposition", () => {
  const ready = presentActivityItem("RESUME_READY", "job-1", 1);
  assert.equal(ready.tone, "success");
  assert.equal(ready.domain, "resume");
  // QUALITY_FAILURE and HUMAN_REVIEW_REQUIRED (real, distinct failure/review types) must never be
  // classified as success — proves no blanket "resume event = good news" shortcut exists.
  assert.notEqual(presentActivityItem("QUALITY_FAILURE", "job-1", 1).tone, "success");
  assert.notEqual(presentActivityItem("HUMAN_REVIEW_REQUIRED", "job-1", 1).tone, "success");
});

test("UIACT-APP-01: an unrecognized type fails safe (neutral, job domain) rather than inventing a raw-executor-event category", () => {
  const unknown = presentActivityItem("field_filled", "job-1", 1);
  assert.equal(unknown.tone, "neutral");
  assert.equal(unknown.domain, "job");
  assert.equal(unknown.needsUser, false);
});

test("UIACT-JOB-01: no ranking/scoring value is computed here — presentActivityItem never reads or returns a score", () => {
  const result = presentActivityItem("HIGH_VALUE_JOB_MATCH", "job-1", 1);
  assert.equal("score" in result, false);
  assert.equal("matchScore" in result, false);
});

test("UIACT filters: matchesFilter reads the real computed domain/needsUser, never title text", () => {
  const jobItem = presentActivityItem("HIGH_VALUE_JOB_MATCH", "job-1", 1);
  assert.equal(matchesFilter(jobItem, "all"), true);
  assert.equal(matchesFilter(jobItem, "job"), true);
  assert.equal(matchesFilter(jobItem, "resume"), false);
  assert.equal(matchesFilter(jobItem, "needsYou"), false);

  const needsYouItem = presentActivityItem("application_needs_attention", "application-run:1:WAITING_FOR_ANSWER", 1);
  assert.equal(matchesFilter(needsYouItem, "needsYou"), true);
  assert.equal(matchesFilter(needsYouItem, "application"), true);
});

test("UIACT grouping: real calendar-day buckets from the actual createdAt timestamp, never fabricated", () => {
  const now = new Date("2026-08-26T12:00:00.000Z");
  assert.equal(groupForTimestamp("2026-08-26T09:00:00.000Z", now), "today");
  assert.equal(groupForTimestamp("2026-08-25T23:00:00.000Z", now), "yesterday");
  assert.equal(groupForTimestamp("2026-08-20T00:00:00.000Z", now), "earlier");
  // Malformed timestamp fails safe into "earlier" rather than throwing or crashing render.
  assert.equal(groupForTimestamp("not-a-real-date", now), "earlier");
});
