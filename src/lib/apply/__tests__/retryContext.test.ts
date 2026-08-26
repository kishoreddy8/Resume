import test from "node:test";
import assert from "node:assert/strict";
import { carryForwardApprovedRunAnswers, isRetryEligible } from "../retryContext";
import { planFields } from "../agent/planFields";
import type { AdapterContext, DiscoveredField, RunApprovedAnswer } from "../agent/types";
import type { StoredAnswer } from "../resolveAnswer";
import type { QuestionType } from "../questionTypes";
import type { ExecutionCheckpoint } from "../engine/executor";

/**
 * PHASE 9E RETRY HARDENING — carrying a user's already-approved answers forward from a terminally
 * FAILED run into a fresh retry of the SAME application. These tests cover the pure decision layer
 * (retryContext.ts); the DB-backed scoping tests (candidate/job/tenant matching, FAILED-run
 * immutability, audit provenance) live in db/queries/__tests__/retryContextDb.test.ts.
 */

function runApproved(overrides: Partial<RunApprovedAnswer>): RunApprovedAnswer {
  return {
    questionId: "q1",
    selector: "#q1",
    label: "Some Question",
    answer: "An answer",
    canonicalKey: null,
    questionType: null,
    ...overrides,
  };
}

// ── RETRY-ANSWER-07: eligible-by-default classes ─────────────────────────────────────────────────

test("RETRY-ANSWER-07: an auto_after_approval question (e.g. contact) may be carried forward", () => {
  assert.equal(isRetryEligible(runApproved({ questionType: "contact" as QuestionType })), true);
});

test("RETRY-ANSWER-07: an ask_each_time question (e.g. \"other\" — custom employer questions) may STILL be carried forward within the same application's retry", () => {
  /* This is the deliberate, narrow distinction this module exists for: ask_each_time forbids
   * silent reuse ACROSS different applications, not replay within the SAME unsubmitted one. */
  assert.equal(isRetryEligible(runApproved({ questionType: "other" as QuestionType })), true);
  assert.equal(isRetryEligible(runApproved({ questionType: null })), true, "an unclassified custom question defaults to `other`, which is eligible");
});

// ── RETRY-ANSWER-10: never_auto / protected always wins ─────────────────────────────────────────

test("RETRY-ANSWER-10: a voluntary_demographic (never_auto, protected) question is NEVER carried forward, even though the user approved it for this exact form", () => {
  const answer = runApproved({ questionType: "voluntary_demographic" as QuestionType, label: "Gender" });
  assert.equal(isRetryEligible(answer), false);
});

// ── RETRY-ANSWER-09: secret-shaped labels are excluded regardless of type ───────────────────────

test("RETRY-ANSWER-09: password/OTP/verification-code-shaped labels are never eligible, whatever questionType is attached", () => {
  const secretLabels = [
    "Password",
    "Confirm Password",
    "One-Time Passcode",
    "OTP",
    "Verification Code",
    "Security Code",
    "SSN",
    "Social Security Number",
    "CVV",
  ];
  for (const label of secretLabels) {
    assert.equal(
      isRetryEligible(runApproved({ label, questionType: "other" as QuestionType })),
      false,
      `"${label}" must never be retry-eligible`
    );
  }
});

test("RETRY-ANSWER-09: an ordinary label containing no secret keyword is unaffected by the secret filter", () => {
  assert.equal(isRetryEligible(runApproved({ label: "Postal Code" })), true);
  assert.equal(isRetryEligible(runApproved({ label: "County" })), true);
});

// ── carryForwardApprovedRunAnswers: counting, de-duplication, filtering ─────────────────────────

test("carryForwardApprovedRunAnswers de-duplicates by questionId (runAnswers stores each answer under 3 keys)", () => {
  const answer = runApproved({ questionId: "postal", selector: "#postal", label: "Postal Code", answer: "75072" });
  const checkpoint: ExecutionCheckpoint = {
    url: null,
    ats: "workday",
    step: "starting",
    completed: [],
    runAnswers: { postal: answer, "#postal": answer, "Postal Code": answer },
    lastAction: "",
  };
  const result = carryForwardApprovedRunAnswers(99, checkpoint);
  assert.equal(result.eligibleCount, 1, "3 stored keys for ONE question must count as 1 eligible answer, not 3");
  assert.equal(result.carriedCount, 1);
});

test("carryForwardApprovedRunAnswers excludes never_auto answers from the carried count but still counts them as eligible-before-policy", () => {
  const safe = runApproved({ questionId: "postal", selector: "#postal", label: "Postal Code", questionType: null });
  const protectedAnswer = runApproved({ questionId: "gender", selector: "#gender", label: "Gender", questionType: "voluntary_demographic" as QuestionType });
  const checkpoint: ExecutionCheckpoint = {
    url: null,
    ats: "workday",
    step: "starting",
    completed: [],
    runAnswers: { postal: safe, gender: protectedAnswer },
    lastAction: "",
  };
  const result = carryForwardApprovedRunAnswers(99, checkpoint);
  assert.equal(result.eligibleCount, 2);
  assert.equal(result.carriedCount, 1);
  assert.equal(result.excludedForPolicyCount, 1);
  assert.ok(result.answers["postal"]);
  assert.ok(!result.answers["gender"], "the protected answer must not appear in the seeded set at all");
});

test("carryForwardApprovedRunAnswers handles a null/empty checkpoint safely", () => {
  const result = carryForwardApprovedRunAnswers(1, null);
  assert.equal(result.eligibleCount, 0);
  assert.equal(result.carriedCount, 0);
  assert.deepEqual(result.answers, {});
});

// ── RETRY-ANSWER-08: changed finite options invalidate a carried-forward answer ─────────────────

const CONTEXT: AdapterContext = {
  candidateId: 1,
  contact: { name: "Jane Doe", email: "jane@example.com", phone: "(214) 555-0100", location: "Dallas, TX" },
  resumePath: "/path/to/resume.pdf",
  coverLetterPath: null,
};
const NO_VARIANTS = new Map<string, { canonicalKey: string; type: QuestionType }>();
const NO_ANSWERS = new Map<string, StoredAnswer>();

test("RETRY-ANSWER-08: a carried-forward answer whose value is no longer among the field's CURRENT options is not applied — the form asks instead", () => {
  const priorAnswer = runApproved({
    questionId: "source--source",
    selector: "#source--source",
    label: "How Did You Hear About Us?",
    answer: "Online Source",
    canonicalKey: "referral_source",
    questionType: "other" as QuestionType,
  });
  const checkpoint: ExecutionCheckpoint = {
    url: null,
    ats: "workday",
    step: "starting",
    completed: [],
    runAnswers: { "source--source": priorAnswer, "#source--source": priorAnswer, "How Did You Hear About Us?": priorAnswer },
    lastAction: "",
  };
  const carried = carryForwardApprovedRunAnswers(20, checkpoint);
  assert.equal(carried.carriedCount, 1);

  /* The SAME question, rediscovered on the fresh run's live page — but the employer has since
   * reconfigured the picker and "Online Source" is no longer one of the choices. */
  const field: DiscoveredField = {
    selector: "#source--source",
    id: "source--source",
    name: "source--source",
    kind: "select",
    label: "How Did You Hear About Us?",
    required: true,
    options: ["LinkedIn", "Referral", "Other"],
  };

  const plans = planFields({
    fields: [field],
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
    runAnswers: carried.answers,
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.action, "ask", "changed options must force ASK, never a loose remap onto a different current option");
  assert.match((plans[0] as { reason: string }).reason, /no longer one of the options/i);
});

test("RETRY-ANSWER-08 (control case): the SAME options still present means the carried answer DOES apply", () => {
  const priorAnswer = runApproved({
    questionId: "source--source",
    selector: "#source--source",
    label: "How Did You Hear About Us?",
    answer: "Online Source",
    canonicalKey: "referral_source",
    questionType: "other" as QuestionType,
  });
  const checkpoint: ExecutionCheckpoint = {
    url: null,
    ats: "workday",
    step: "starting",
    completed: [],
    runAnswers: { "source--source": priorAnswer },
    lastAction: "",
  };
  const carried = carryForwardApprovedRunAnswers(20, checkpoint);

  const field: DiscoveredField = {
    selector: "#source--source",
    id: "source--source",
    name: "source--source",
    kind: "select",
    label: "How Did You Hear About Us?",
    required: true,
    options: ["Agency / Executive Search Firm", "Campus / University", "Employees", "Online Source", "Other"],
  };

  const plans = planFields({
    fields: [field],
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
    runAnswers: carried.answers,
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.action, "fill");
  assert.equal((plans[0] as { value: string }).value, "Online Source");
});
