import test from "node:test";
import assert from "node:assert/strict";
import { discoverFields, type RawControl } from "../fieldDiscovery";
import { planFields, collectHumanQuestions } from "../planFields";
import type { AdapterContext } from "../types";
import type { StoredAnswer } from "../../resolveAnswer";
import type { QuestionType } from "../../questionTypes";

/**
 * PHASE 9E — universal radio-group semantics.
 *
 * ROOT CAUSE these tests fence: `discoverFields` ranked a control's own `<label for>` above its
 * fieldset `<legend>`. On markup where each radio carries its own label — observed on a real
 * Workday tenant — that made the OPTION text ("Yes") the question, so the Human Question Center
 * would present the user a question titled "Yes" instead of the actual question. Greenhouse/Lever
 * radios carry no per-option label, which is the only reason the defect never surfaced there.
 */

const NO_VARIANTS = new Map<string, { canonicalKey: string; type: QuestionType }>();
const NO_ANSWERS = new Map<string, StoredAnswer>();

const CONTEXT: AdapterContext = {
  candidateId: 1,
  contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
  resumePath: "/tmp/resume.docx",
  coverLetterPath: "/tmp/cover.docx",
};

function control(overrides: Partial<RawControl>): RawControl {
  return { tag: "input", type: "text", id: null, name: null, ariaLabel: null, labelText: null, required: false, ...overrides };
}

/** The exact shape observed on the real Workday form: legend = question, per-option <label for>. */
function workdayShapedGroup(): RawControl[] {
  const legend = "Have you previously worked for our Organization?*";
  return [
    control({ type: "radio", id: "prev_yes", name: "previouslyWorked", labelText: "Yes", groupLegend: legend, required: true }),
    control({ type: "radio", id: "prev_no", name: "previouslyWorked", labelText: "No", groupLegend: legend }),
  ];
}

test("RADIO-SEMANTICS-01: the fieldset legend becomes the question", () => {
  const [field] = discoverFields(workdayShapedGroup());
  assert.equal(field.label, "Have you previously worked for our Organization?");
  assert.equal(field.kind, "radio");
});

test("RADIO-SEMANTICS-02: option labels remain option labels, carried as the field's options", () => {
  const [field] = discoverFields(workdayShapedGroup());
  assert.deepEqual(field.options, ["Yes", "No"], "both option texts are preserved, in document order");
});

test("RADIO-SEMANTICS-03: Yes/No option labels never replace an available legend", () => {
  const [field] = discoverFields(workdayShapedGroup());
  assert.notEqual(field.label, "Yes");
  assert.notEqual(field.label, "No");
});

test("RADIO-SEMANTICS-04: one logical radio group produces exactly ONE field, plan, and human question", () => {
  const fields = discoverFields(workdayShapedGroup());
  assert.equal(fields.length, 1, "two radio inputs, one logical question");

  const plans = planFields({ fields, context: CONTEXT, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans.length, 1, "one planning decision, not one per option");

  const questions = collectHumanQuestions(plans, NO_VARIANTS);
  assert.equal(questions.length, 1, "the user is asked once, not once per option");
  assert.match(questions[0].label, /previously worked/i);
  assert.deepEqual(questions[0].options, ["Yes", "No"], "the UI renders the real observed options");
});

test("RADIO-SEMANTICS-05: radio markup with NO legend preserves the pre-9E fallback behaviour", () => {
  // No groupLegend and no ancestorText — the option's own label is all there is, so it is used.
  const fields = discoverFields([
    control({ type: "radio", id: "r1", name: "solo", labelText: "Some Option", required: true }),
  ]);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].label, "Some Option", "fallback to the control's own label, exactly as before");
});

test("RADIO-SEMANTICS-05b: a radio with no name attribute cannot be grouped and remains its own field", () => {
  const fields = discoverFields([
    control({ type: "radio", id: "a", labelText: "A", groupLegend: "Pick one" }),
    control({ type: "radio", id: "b", labelText: "B", groupLegend: "Pick one" }),
  ]);
  assert.equal(fields.length, 2, "without a name there is no HTML radio group to fold into");
});

test("RADIO-SEMANTICS-06: Greenhouse-shaped radios (legend, no per-option label) are unchanged", () => {
  // Greenhouse/Lever markup: the legend arrives via ancestorText, options carry no <label for>.
  const legend = "Do you now or in the future require visa sponsorship?*";
  const fields = discoverFields([
    control({ type: "radio", id: "sp_yes", name: "sponsorship", ancestorText: legend, groupLegend: legend, required: true }),
    control({ type: "radio", id: "sp_no", name: "sponsorship", ancestorText: legend, groupLegend: legend }),
  ]);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].label, "Do you now or in the future require visa sponsorship?");
  assert.equal(fields[0].required, true, "a required member makes the group required");
  assert.ok(!fields[0].options, "no per-option labels exist, so no options are invented");
});

test("RADIO-SEMANTICS-07: a sponsorship radio group with no stored answer still pauses safely (GAP-6 discipline)", () => {
  const legend = "Do you now or in the future require visa sponsorship?*";
  const fields = discoverFields([
    control({ type: "radio", id: "sp_yes", name: "sponsorship", ancestorText: legend, groupLegend: legend, required: true }),
    control({ type: "radio", id: "sp_no", name: "sponsorship", ancestorText: legend, groupLegend: legend }),
  ]);
  const plans = planFields({ fields, context: CONTEXT, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "ask");
  assert.notEqual((plans[0] as { value?: string }).value, "Yes");
  assert.notEqual((plans[0] as { value?: string }).value, "No");
});
