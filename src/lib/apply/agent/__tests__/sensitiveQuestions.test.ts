import test from "node:test";
import assert from "node:assert/strict";
import { discoverFields, type RawControl } from "../fieldDiscovery";
import { planFields } from "../planFields";
import type { AdapterContext } from "../types";
import type { StoredAnswer } from "../../resolveAnswer";
import type { QuestionType } from "../../questionTypes";
import { DEFAULT_POLICY } from "../../questionTypes";

/**
 * PHASE 9D — SENSITIVE-01..05 and the form-filling variant of CONSENT-01/02 (distinct from Phase
 * 9C's account-CREATION consent gate, tested in engine/__tests__/authExecution.test.ts). Proves
 * DEFAULT_POLICY's existing `protected`/`never_auto` classification holds for every voluntary
 * demographic category, and that an unclassified required consent checkbox during ORDINARY form
 * filling is asked, never auto-checked.
 */

const NO_VARIANTS = new Map<string, { canonicalKey: string; type: QuestionType }>();
const NO_ANSWERS = new Map<string, StoredAnswer>();

function context(): AdapterContext {
  return {
    candidateId: 1,
    contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
    resumePath: "/tmp/resume.docx",
    coverLetterPath: "/tmp/cover.docx",
  };
}

function control(overrides: Partial<RawControl>): RawControl {
  return { tag: "input", type: "text", id: null, name: null, ariaLabel: null, labelText: null, required: false, ...overrides };
}

test("SENSITIVE-01: race/ethnicity is never inferred — no stored answer means ask, with the voluntary-question reason", () => {
  const fields = discoverFields([control({ id: "q_race", labelText: "Race / Ethnicity (voluntary)", required: false })]);
  const plans = planFields({ fields, context: context(), knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "ask");
  assert.match((plans[0] as { reason: string }).reason, /voluntary demographic/i);
});

test("SENSITIVE-02: gender is never inferred", () => {
  const fields = discoverFields([control({ id: "q_gender", labelText: "Gender", required: false })]);
  const plans = planFields({ fields, context: context(), knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "ask");
});

test("SENSITIVE-03: disability status is never inferred", () => {
  const fields = discoverFields([control({ id: "q_disability", type: "checkbox", labelText: "Do you have a disability?", required: false })]);
  const plans = planFields({ fields, context: context(), knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "ask");
});

test("SENSITIVE-04: veteran status is never inferred", () => {
  const fields = discoverFields([control({ id: "q_veteran", labelText: "Veteran Status", required: false })]);
  const plans = planFields({ fields, context: context(), knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "ask");
});

test("SENSITIVE-05: an approved demographic answer is only ever SUGGESTED, never auto-filled, regardless of auto_fill_allowed", () => {
  assert.equal(DEFAULT_POLICY.voluntary_demographic.reusePolicy, "never_auto");
  assert.equal(DEFAULT_POLICY.voluntary_demographic.sensitivity, "protected");
  const fields = discoverFields([control({ id: "q_gender", labelText: "Gender", required: false })]);
  const plans = planFields({
    fields,
    context: context(),
    knownVariants: NO_VARIANTS,
    storedAnswers: new Map([["gender", { answer_value: "Woman", answer_source: "USER_INTERVENTION", approved_by_user: 1, auto_fill_allowed: 1 }]]),
  });
  // Even with approved_by_user=1 AND auto_fill_allowed=1, "never_auto" policy means resolveAnswer
  // returns "suggest", not "fill" — planFields' mayFill gate then still asks.
  assert.equal(plans[0].action, "ask", "never_auto policy overrides auto_fill_allowed — a voluntary answer is never typed unattended");
});

test("CONSENT-01 (form-filling, not account-creation): a required, unrecognized consent checkbox is asked, never auto-checked", () => {
  const fields = discoverFields([control({ id: "terms", type: "checkbox", labelText: "I agree to the Terms of Service", required: true })]);
  const plans = planFields({ fields, context: context(), knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "ask", "no canonical mapping exists for arbitrary consent text — never guessed");
});

test("CONSENT-02 (form-filling): an optional marketing checkbox is likewise never auto-checked", () => {
  const fields = discoverFields([control({ id: "newsletter", type: "checkbox", labelText: "Send me newsletters and promotions", required: false })]);
  const plans = planFields({ fields, context: context(), knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.notEqual(plans[0].action, "fill", "an optional marketing checkbox is never opted into automatically");
});
