import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildAnswerSubmission, requiredQuestionsSatisfied } from "../[id]/questionBatch";

/**
 * UI-0 DEFECT 4 — the real State Street / Workday batch this fixes: 2 required questions (How Did
 * You Hear About Us?, Postal Code) and 4 optional ones (previously worked here?, Address Line 2,
 * County, Phone Extension). The old `allAnswered` logic required all 6; only 2 are actually
 * required by the employer.
 */

const REAL_BATCH = [
  { id: "how-heard", required: true },
  { id: "previously-employed", required: false },
  { id: "address-line-2", required: false },
  { id: "postal-code", required: true },
  { id: "county", required: false },
  { id: "phone-extension", required: false },
];

test("QUESTION-OPTIONAL-01: unanswered optional question does not disable Save & Continue", () => {
  const answers = { "how-heard": "Online Source", "postal-code": "02110" };
  assert.equal(requiredQuestionsSatisfied(REAL_BATCH, answers), true);
});

test("QUESTION-OPTIONAL-02: unanswered required question still blocks", () => {
  const missingOneRequired = { "how-heard": "Online Source" /* postal-code missing */ };
  assert.equal(requiredQuestionsSatisfied(REAL_BATCH, missingOneRequired), false);

  const missingBothRequired = {};
  assert.equal(requiredQuestionsSatisfied(REAL_BATCH, missingBothRequired), false);

  const whitespaceOnly = { "how-heard": "Online Source", "postal-code": "   " };
  assert.equal(requiredQuestionsSatisfied(REAL_BATCH, whitespaceOnly), false, "whitespace-only is not a real answer");
});

test("QUESTION-OPTIONAL-03: a mix of answered required + unanswered optional can continue", () => {
  const answers = {
    "how-heard": "Online Source",
    "postal-code": "02110",
    county: "", // explicitly left blank
    // address-line-2, previously-employed, phone-extension never touched at all
  };
  assert.equal(requiredQuestionsSatisfied(REAL_BATCH, answers), true);
});

test("QUESTION-OPTIONAL-04: a skipped optional value is never fabricated or included in the submission", () => {
  const answers = { "how-heard": "Online Source", "postal-code": "02110", county: "" };
  const submission = buildAnswerSubmission(REAL_BATCH, answers, {});
  const ids = submission.map((a) => a.id);
  assert.deepEqual(ids.sort(), ["how-heard", "postal-code"], "only genuinely answered questions are submitted");
  assert.ok(!ids.includes("county"), "an explicitly blanked optional question is never sent");
  assert.ok(!ids.includes("address-line-2"), "an untouched optional question is never sent");
  assert.ok(
    submission.every((a) => a.answer.length > 0),
    "no submitted entry may ever carry a blank answer — the server's own schema requires min(1)"
  );
});

test("an explicit answer to an optional question IS included and validated normally", () => {
  const answers = { "how-heard": "Online Source", "postal-code": "02110", county: "Suffolk" };
  const submission = buildAnswerSubmission(REAL_BATCH, answers, {});
  const county = submission.find((a) => a.id === "county");
  assert.ok(county, "an answered optional question must still be submitted");
  assert.equal(county!.answer, "Suffolk");
});

test("reuse-for-equivalent-questions is carried through per question, defaulting to false", () => {
  const answers = { "how-heard": "Online Source" };
  const noReuse = buildAnswerSubmission(REAL_BATCH, answers, {});
  assert.equal(noReuse[0]!.reuseForEquivalentQuestions, false);

  const withReuse = buildAnswerSubmission(REAL_BATCH, answers, { "how-heard": true });
  assert.equal(withReuse[0]!.reuseForEquivalentQuestions, true);
});

test("answers are trimmed before submission, matching the server's own trim().min(1) contract", () => {
  const answers = { "how-heard": "  Online Source  " };
  const submission = buildAnswerSubmission(REAL_BATCH, answers, {});
  assert.equal(submission[0]!.answer, "Online Source");
});

test("with zero questions answered at all, the submission is empty and required-check fails closed", () => {
  assert.deepEqual(buildAnswerSubmission(REAL_BATCH, {}, {}), []);
  assert.equal(requiredQuestionsSatisfied(REAL_BATCH, {}), false);
});

test("a batch with no required questions at all can always be saved, even with nothing answered", () => {
  const allOptional = REAL_BATCH.map((q) => ({ ...q, required: false }));
  assert.equal(requiredQuestionsSatisfied(allOptional, {}), true);
});

test("ApplicationDetail wires the button to the required-only gate, not the old all-questions gate", () => {
  const source = fs.readFileSync("src/app/applications/[id]/ApplicationDetail.tsx", "utf8");
  assert.doesNotMatch(source, /const allAnswered = humanQuestions\.every/, "the old blanket gate must be gone");
  assert.match(source, /requiredQuestionsSatisfied\(humanQuestions, batchAnswers\)/);
  assert.match(source, /disabled=\{busy !== null \|\| !canSave\}/);
  assert.match(source, /buildAnswerSubmission\(humanQuestions, batchAnswers, batchReuse\)/, "onSave must use the filtering submission builder, not a raw map over every question");
});
