import test from "node:test";
import assert from "node:assert/strict";
import { mockAtsUrl } from "./mockAts/paths";
import { COLLECT_CONTROLS_SCRIPT, discoverFields, type RawControl } from "@/lib/apply/agent/fieldDiscovery";

/**
 * PHASE 9E — universal field discovery against a SANITIZED fixture of a real Workday form.
 *
 * Every assertion here encodes something OBSERVED on a live Workday tenant, not assumed. See the
 * fixture's own header comment for the four structural facts and how they were captured.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { ApplicationBrowserRuntime } = require("../browserRuntime") as typeof import("../browserRuntime");

const runtime = new ApplicationBrowserRuntime();

test.after(async () => {
  await runtime.close();
});

async function collect(): Promise<RawControl[]> {
  const session = await runtime.open(mockAtsUrl("mock-workday-myinformation"));
  try {
    return (await session.page.evaluate(COLLECT_CONTROLS_SCRIPT)) as RawControl[];
  } finally {
    await session.close();
  }
}

test("WORKDAY-02a: Workday puts data-automation-id on a WRAPPER, not the input — discovery must still capture it", async () => {
  const controls = await collect();
  const firstName = controls.find((c) => c.id === "name--legalName--firstName");
  assert.ok(firstName, "the first-name input must be discovered");
  assert.equal(
    firstName!.automationId,
    "formField-legalName--firstName",
    "the wrapper's automation id (3 levels up) must be captured — reading the attribute off the input itself yields null on every real Workday control"
  );
});

test("WORKDAY-02b: every observed Workday form field is discovered with its real label", async () => {
  const fields = discoverFields(await collect());
  const byId = new Map(fields.map((f) => [f.id, f]));

  for (const [id, label] of [
    ["name--legalName--firstName", "First Name"],
    ["name--legalName--lastName", "Last Name"],
    ["address--addressLine1", "Address Line 1"],
    ["address--city", "City"],
    ["address--postalCode", "Postal Code"],
    ["phoneNumber--phoneNumber", "Phone Number"],
  ] as const) {
    const f = byId.get(id);
    assert.ok(f, `${id} must be discovered`);
    assert.equal(f!.label, label, `${id} must carry its real <label for> text`);
    assert.equal(f!.required, true, `${id} is required on the real form`);
  }
});

test("WORKDAY-03: Workday's stable semantic ids produce #id selectors — they are NOT generated ids", async () => {
  const fields = discoverFields(await collect());
  const firstName = fields.find((f) => f.id === "name--legalName--firstName");
  assert.equal(
    firstName!.selector,
    "#name--legalName--firstName",
    "a stable semantic id must win the #id fast path; it must not be demoted to the automation id"
  );
});

test("WORKDAY-12: the observed Workday radio group asks the REAL question, with the real options, exactly once", async () => {
  /* This test previously pinned a defect: Workday puts a <label for> on each radio OPTION while the
   * question lives in the fieldset <legend>, and discovery ranked the option label higher — so the
   * Human Question Center would have shown the user a question titled "Yes". Phase 9E fixed the
   * underlying semantics (see radioSemantics.test.ts); this now proves the correct behaviour
   * against the sanitized capture of the real form. */
  const { collectHumanQuestions, planFields } = await import("@/lib/apply/agent/planFields");
  const fields = discoverFields(await collect());
  const radios = fields.filter((f) => f.kind === "radio");

  assert.equal(radios.length, 1, "two radio inputs on the real form are ONE logical question");
  assert.match(radios[0].label ?? "", /previously worked for our Organization/i, "the legend is the question");
  assert.deepEqual(radios[0].options, ["Yes", "No"], "the real observed options are preserved as options");

  const plans = planFields({
    fields,
    context: {
      candidateId: 1,
      contact: { name: "Test Candidate", email: "t@example.test", phone: "(000) 000-0000", location: "Somewhere, TX" },
      resumePath: null,
      coverLetterPath: null,
    },
    knownVariants: new Map(),
    storedAnswers: new Map(),
  });
  const radioPlan = plans.find((p) => p.field.kind === "radio");
  assert.equal(radioPlan?.action, "ask", "no stored answer exists, so it is asked — never guessed");

  const asked = collectHumanQuestions(plans, new Map()).filter((q) => q.kind === "radio");
  assert.ok(asked.length <= 1, "the user is never asked the same radio group twice");
});

test("WORKDAY-HONEYPOT-01: the beecatcher honeypot is discovered but never auto-filled", async () => {
  const { planFields } = await import("@/lib/apply/agent/planFields");
  const fields = discoverFields(await collect());
  const honeypot = fields.find((f) => f.automationId === "beecatcher" || f.id === "beecatcher-input");
  assert.ok(honeypot, "the honeypot IS discovered — universal discovery cannot know it is a trap");

  const plans = planFields({
    fields,
    context: {
      candidateId: 1,
      contact: { name: "Test Candidate", email: "t@example.test", phone: "(000) 000-0000", location: "Somewhere, TX" },
      resumePath: null,
      coverLetterPath: null,
    },
    knownVariants: new Map(),
    storedAnswers: new Map(),
  });
  const honeypotPlan = plans.find((p) => p.field.selector === honeypot!.selector);
  assert.ok(honeypotPlan, "the honeypot must appear in the plan");
  assert.notEqual(honeypotPlan!.action, "fill", "the honeypot must NEVER be filled — filling it flags the application as a bot");
});

/**
 * PHASE 9E — VALIDATION OBSERVATION. Real evidence from Run 22 (State Street, 2026-08-25): a
 * validation_snapshot captured at the exact moment Workday refused to advance showed "State" and
 * "Phone Device Type" as required-and-empty — because both are <button data-automation-id="…">
 * elements with aria-haspopup="listbox", entirely outside the OLD `input, select, textarea` query.
 * This is the actual, confirmed reason a real run filled every field it could see and the page
 * still would not proceed.
 */
test("BUTTON-PICKER-05: the LIVE query now finds Workday's button-triggered listbox pickers (State, Phone Device Type) as real fields", async () => {
  const { planFields } = await import("@/lib/apply/agent/planFields");
  const fields = discoverFields(await collect());

  const state = fields.find((f) => f.automationId === "formField-countryRegion");
  const phoneType = fields.find((f) => f.automationId === "formField-phoneType");
  assert.ok(state, "State must now be discovered — it was previously invisible to the whole pipeline");
  assert.ok(phoneType, "Phone Device Type must now be discovered — it was previously invisible");
  assert.equal(state!.kind, "combobox");
  assert.equal(phoneType!.kind, "combobox");
  assert.equal(state!.label, "State", "cleanLabel strips the trailing required-marker asterisk, same as every other field");
  assert.equal(phoneType!.label, "Phone Device Type");
  assert.equal(state!.required, true);
  assert.equal(phoneType!.required, true);

  /* Neither has ever been asked about or matched to any canonical answer — the honest, safe
   * outcome is exactly what real Run 22 needed and never got: a question, not silence. */
  const plans = planFields({
    fields,
    context: {
      candidateId: 1,
      contact: { name: "Test Candidate", email: "t@example.test", phone: "(000) 000-0000", location: "Somewhere, TX" },
      resumePath: null,
      coverLetterPath: null,
    },
    knownVariants: new Map(),
    storedAnswers: new Map(),
  });
  const statePlan = plans.find((p) => p.field.selector === state!.selector);
  const phoneTypePlan = plans.find((p) => p.field.selector === phoneType!.selector);
  assert.equal(statePlan!.action, "ask");
  assert.equal(phoneTypePlan!.action, "ask");
});

test("BUTTON-PICKER-06: an ordinary button (no aria-haspopup) on the same live page is never discovered as a field", async () => {
  const fields = discoverFields(await collect());
  const cancel = fields.find((f) => f.automationId === "pageFooterCancelButton");
  assert.equal(cancel, undefined, "a plain button must never be swept into discovery merely for being a <button>");
});
