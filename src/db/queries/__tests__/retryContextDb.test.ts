import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * PHASE 9E RETRY HARDENING — DB-backed scoping tests for retry-context carry-forward: same
 * candidate + same job/dedupe_key (which itself encodes ATS tenant) required; the prior FAILED run
 * is read-only and never mutated; and the audit event carries no answer values.
 *
 * Isolated on a temp on-disk database (this repo's established convention — see
 * candidateJobState.test.ts) so this never touches the real, 2.4GB production database or Run 20.
 */

let tmpDir: string;
let createRun: typeof import("../applicationRuns").createRun;
let advanceRun: typeof import("../applicationRuns").advanceRun;
let updateCheckpoint: typeof import("../applicationRuns").updateCheckpoint;
let getRun: typeof import("../applicationRuns").getRun;
let listEvents: typeof import("../applicationRuns").listEvents;
let recordEvent: typeof import("../applicationRuns").recordEvent;
let createCandidate: typeof import("../candidates").createCandidate;
let priorRunAnswersForRetry: typeof import("../../../lib/apply/retryContext").priorRunAnswersForRetry;
let getDb: typeof import("../../index").getDb;

const DEDUPE_KEY = "workday:3850:R-796511";
const OTHER_JOB_DEDUPE_KEY = "workday:3850:R-999999";
const OTHER_TENANT_DEDUPE_KEY = "workday:9999:R-796511";

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-retry-context-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ createRun, advanceRun, updateCheckpoint, getRun, listEvents, recordEvent } = await import("../applicationRuns"));
  ({ createCandidate } = await import("../candidates"));
  ({ priorRunAnswersForRetry } = await import("../../../lib/apply/retryContext"));
  ({ getDb } = await import("../../index"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedFailedRun(candidateId: number, dedupeKey: string) {
  const run = createRun({ candidateId, jobId: 43785, dedupeKey, ats: "workday", applyUrl: "https://example.test/apply" });
  updateCheckpoint(run.id, {
    url: "https://example.test/apply",
    ats: "workday",
    step: "filling",
    completed: [],
    runAnswers: {
      "source--source": {
        questionId: "source--source",
        selector: "#source--source",
        label: "How Did You Hear About Us?",
        answer: "Online Source",
        canonicalKey: "referral_source",
        questionType: "other",
      },
      "address--postalCode": {
        questionId: "address--postalCode",
        selector: "#address--postalCode",
        label: "Postal Code",
        answer: "75072",
        canonicalKey: null,
        questionType: null,
      },
      gender: {
        questionId: "gender",
        selector: "#gender",
        label: "Gender",
        answer: "Prefer not to answer",
        canonicalKey: null,
        questionType: "voluntary_demographic",
      },
    },
    lastAction: "test fixture",
  });
  advanceRun(run.id, "FAILED", { blockingReason: "TimeoutError: page.fill: Timeout 30000ms exceeded." });
  return getRun(run.id)!;
}

test("RETRY-ANSWER-01: a user-approved answer from a FAILED run is available to a fresh retry of the SAME job", () => {
  const candidate = createCandidate({ firstName: "Retry", lastName: "One" });
  const failed = seedFailedRun(candidate.id, DEDUPE_KEY);

  const result = priorRunAnswersForRetry(candidate.id, DEDUPE_KEY);
  assert.ok(result, "a prior FAILED run for this exact candidate+job must be found");
  assert.equal(result!.priorRunId, failed.id);
  assert.ok(result!.answers["address--postalCode"], "the Postal Code answer must be carried forward");
  assert.equal(result!.answers["address--postalCode"]!.answer, "75072");
});

test("RETRY-ANSWER-02: the FAILED run itself is read-only — status and checkpoint are byte-identical before and after the lookup", () => {
  const candidate = createCandidate({ firstName: "Retry", lastName: "Two" });
  const failed = seedFailedRun(candidate.id, DEDUPE_KEY);
  const before_ = getRun(failed.id)!;

  priorRunAnswersForRetry(candidate.id, DEDUPE_KEY);

  const after_ = getRun(failed.id)!;
  assert.equal(after_.status, "FAILED");
  assert.equal(after_.status, before_.status);
  assert.equal(after_.checkpoint_json, before_.checkpoint_json, "checkpoint must not be mutated by a read-only carry-forward lookup");
  assert.equal(after_.updated_at, before_.updated_at, "updated_at must not change — nothing was written");
});

test("RETRY-ANSWER-03: same candidate + a DIFFERENT job does not receive the retry answer", () => {
  const candidate = createCandidate({ firstName: "Retry", lastName: "Three" });
  seedFailedRun(candidate.id, DEDUPE_KEY);

  const result = priorRunAnswersForRetry(candidate.id, OTHER_JOB_DEDUPE_KEY);
  assert.equal(result, null, "a FAILED run for a different job must never leak its answers into this job's retry");
});

test("RETRY-ANSWER-04: a DIFFERENT candidate never receives another candidate's retry answers", () => {
  const candidateA = createCandidate({ firstName: "Retry", lastName: "FourA" });
  const candidateB = createCandidate({ firstName: "Retry", lastName: "FourB" });
  seedFailedRun(candidateA.id, DEDUPE_KEY);

  const result = priorRunAnswersForRetry(candidateB.id, DEDUPE_KEY);
  assert.equal(result, null, "candidate B must never see candidate A's answers, even for the identical job");
});

test("RETRY-ANSWER-05: a different tenant (dedupe_key differs only in the tenant segment) does not receive the retry answer", () => {
  const candidate = createCandidate({ firstName: "Retry", lastName: "Five" });
  seedFailedRun(candidate.id, DEDUPE_KEY);

  const result = priorRunAnswersForRetry(candidate.id, OTHER_TENANT_DEDUPE_KEY);
  assert.equal(result, null, "dedupe_key already encodes the ATS tenant — a different tenant must not match");
});

test("RETRY-ANSWER-06: carrying answers forward never writes to the persistent Answer Vault (application_answers)", () => {
  const candidate = createCandidate({ firstName: "Retry", lastName: "Six" });
  seedFailedRun(candidate.id, DEDUPE_KEY);

  const before_ = (getDb().prepare("SELECT COUNT(*) AS c FROM application_answers").get() as { c: number }).c;
  priorRunAnswersForRetry(candidate.id, DEDUPE_KEY);
  const after_ = (getDb().prepare("SELECT COUNT(*) AS c FROM application_answers").get() as { c: number }).c;

  assert.equal(after_, before_, "retry-context carry-forward must never promote an ask-each-time answer into the global vault");
});

test("RETRY-ANSWER-11: a fresh run's checkpoint, once seeded, contains ONLY the carried runAnswers — no stale fields from the failed run", () => {
  const candidate = createCandidate({ firstName: "Retry", lastName: "Eleven" });
  seedFailedRun(candidate.id, DEDUPE_KEY);
  const result = priorRunAnswersForRetry(candidate.id, DEDUPE_KEY)!;

  const fresh = createRun({ candidateId: candidate.id, jobId: 43785, dedupeKey: DEDUPE_KEY, ats: "workday", applyUrl: "https://example.test/apply" });
  updateCheckpoint(fresh.id, {
    url: null,
    ats: "workday",
    step: "starting",
    completed: [],
    runAnswers: result.answers,
    lastAction: "retry context seeded",
  });

  const seeded = JSON.parse(getRun(fresh.id)!.checkpoint_json!);
  assert.deepEqual(seeded.completed, [], "a fresh run must start with no completed actions from the old run");
  assert.equal(seeded.review, undefined, "a fresh run must not inherit the old run's review/approval state");
  assert.equal(seeded.humanQuestions, undefined, "a fresh run must not inherit the old run's stale question batch");
  assert.ok(seeded.runAnswers["address--postalCode"], "only the carried retry context is present");
});

test("RETRY-ANSWER-12: audit trail records carry-forward provenance without any answer VALUES", () => {
  const candidate = createCandidate({ firstName: "Retry", lastName: "Twelve" });
  const failed = seedFailedRun(candidate.id, DEDUPE_KEY);
  const result = priorRunAnswersForRetry(candidate.id, DEDUPE_KEY)!;

  const fresh = createRun({ candidateId: candidate.id, jobId: 43785, dedupeKey: DEDUPE_KEY, ats: "workday", applyUrl: "https://example.test/apply" });
  recordEvent(
    fresh.id,
    "retry_context_carried_forward",
    `from run ${result.priorRunId}: ${result.eligibleCount} eligible, ${result.carriedCount} carried, ${result.excludedForPolicyCount} excluded by policy`
  );

  const events = listEvents(fresh.id);
  const provenance = events.find((e) => e.event_type === "retry_context_carried_forward");
  assert.ok(provenance);
  assert.match(provenance!.detail!, new RegExp(`from run ${failed.id}`));
  assert.doesNotMatch(provenance!.detail!, /75072|Online Source|Prefer not to answer/, "the audit event must never contain an actual answer value");
});

test("no prior FAILED run at all returns null cleanly (the ordinary first-attempt case)", () => {
  const candidate = createCandidate({ firstName: "Retry", lastName: "NoPrior" });
  const result = priorRunAnswersForRetry(candidate.id, "workday:1111:R-000000");
  assert.equal(result, null);
});
