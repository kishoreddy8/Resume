import test from "node:test";
import assert from "node:assert/strict";
import { discoverFields, selectorFor, type RawControl } from "../fieldDiscovery";
import { planFields } from "../planFields";
import type { AdapterContext } from "../types";
import type { StoredAnswer } from "../../resolveAnswer";
import type { QuestionType } from "../../questionTypes";

/**
 * GAP-2 (react-select/combobox discovery) and GAP-3 (numeric DOM id selectors), observed missing on
 * a real Greenhouse form (Celigo dry run). Pure, no browser — the same discipline as
 * fieldDiscovery.ts's own philosophy: everything that decides anything is testable without a page.
 */

const CONTEXT: AdapterContext = {
  candidateId: 1,
  contact: {
    name: "Jordan Rivera",
    email: "jordan@example.test",
    phone: "(214) 555-0100",
    location: "Dallas, TX",
  },
  resumePath: "/tmp/resume.docx",
  coverLetterPath: "/tmp/cover.docx",
};
const NO_VARIANTS = new Map<string, { canonicalKey: string; type: QuestionType }>();
const NO_ANSWERS = new Map<string, StoredAnswer>();

function control(overrides: Partial<RawControl>): RawControl {
  return { tag: "input", type: "text", id: null, name: null, ariaLabel: null, labelText: null, required: false, ...overrides };
}

test("DISC-01: role=\"combobox\" is recognized as a combobox, not a plain text field", () => {
  const [field] = discoverFields([control({ id: "country_select", role: "combobox", labelText: "Country" })]);
  assert.equal(field.kind, "combobox");
});

test("DISC-02: a react-select-style select__input class is recognized as a combobox even without role", () => {
  const [field] = discoverFields([control({ id: "loc_select", className: "select__input css-abc123", labelText: "Location" })]);
  assert.equal(field.kind, "combobox");
});

test("DISC-03: an ordinary text input with no role/select class remains a plain text field", () => {
  const [field] = discoverFields([control({ id: "first_name", labelText: "First Name" })]);
  assert.equal(field.kind, "text");
});

test("DISC-04: a numeric id (e.g. Greenhouse's demographic controls) produces a valid, addressable selector", () => {
  assert.equal(selectorFor(control({ id: "16768" })), '[id="16768"]');
  const [field] = discoverFields([control({ id: "16768", labelText: "Gender" })]);
  assert.equal(field.selector, '[id="16768"]');
});

test("DISC-05: normal alphabetic ids continue to use the #id shorthand, unchanged", () => {
  assert.equal(selectorFor(control({ id: "first_name" })), "#first_name");
});

test("DISC-06: special characters in an id are escaped, never interpolated raw into the selector", () => {
  // An unescaped quote in the id would terminate the attribute value early and corrupt the selector
  // (or, worse, let a crafted id break out of it) — both the quote and the backslash are escaped.
  const selector = selectorFor(control({ id: 'weird"id\\here' }));
  assert.equal(selector, '[id="weird\\"id\\\\here"]');
});

test("a numeric-id demographic field is discoverable but still never auto-filled — discovery is not permission (GAP-7 regression)", () => {
  const field: RawControl = control({ id: "16768", labelText: "Gender", role: "combobox" });
  const fields = discoverFields([field]);
  assert.equal(fields.length, 1, "the numeric-id combobox must be discoverable now");
  const plans = planFields({ fields, context: CONTEXT, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "ask", "a voluntary demographic question must never be auto-filled, however it was discovered");
});

test("sponsorship still pauses safely with no stored answer, unaffected by the combobox/id changes (GAP-6 regression)", () => {
  const field: RawControl = control({
    id: "16767",
    role: "combobox",
    labelText: "Do you now or in the future require visa sponsorship?*",
    required: true,
  });
  const plans = planFields({ fields: discoverFields([field]), context: CONTEXT, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "ask");
  assert.notEqual((plans[0] as { value?: string }).value, "Yes");
  assert.notEqual((plans[0] as { value?: string }).value, "No");
});
