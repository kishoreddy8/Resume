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

/* ── PHASE 9A — Workday data-automation-id selector stabilisation ─────────────────────────────────
 * Regression fence for the ONLY live behavior change of the interrupted Phase 9 session: selectorFor
 * preferring a tenant-stable data-automation-id over a Workday-generated id. Pure, no browser. */

test("DISC-07: a data-automation-id outranks a Workday-generated id", () => {
  const selector = selectorFor(control({ id: "input--uid42", automationId: "legalNameSection_firstName" }));
  assert.equal(selector, '[data-automation-id="legalNameSection_firstName"]');
});

test("DISC-08: a STABLE id still outranks an automation id — existing Greenhouse behavior is authoritative", () => {
  assert.equal(selectorFor(control({ id: "first_name", automationId: "somethingElse" })), "#first_name");
});

test("DISC-09: a generated id with no automation id remains a usable last-resort selector, not null", () => {
  // Deliberately NOT reload-stable — Workday regenerates these ids — but addressable-now beats
  // refusing the field outright. The claim under test is only "not null and correctly formed".
  assert.equal(selectorFor(control({ id: "input--uid42" })), "#input--uid42");
});

test("DISC-10: selector-breaking characters in an automation id are escaped, never interpolated raw", () => {
  // An unescaped quote would terminate the attribute value early; a backslash could smuggle one in.
  const selector = selectorFor(control({ id: "input--uid7", automationId: 'we"ird\\aid' }));
  assert.equal(selector, '[data-automation-id="we\\"ird\\\\aid"]');
});

test("DISC-11: without a data-automation-id the DiscoveredField shape is identical to the pre-WIP shape", () => {
  // Checkpoint serialisation compatibility: the property must be OMITTED entirely, never present
  // as `automationId: undefined` — JSON round-trips and deep-equality both depend on that.
  const [field] = discoverFields([control({ id: "first_name", labelText: "First Name" })]);
  assert.ok(!("automationId" in field), "automationId must be absent, not undefined");
  assert.deepEqual(field, {
    selector: "#first_name",
    kind: "text",
    label: "First Name",
    id: "first_name",
    name: null,
    required: false,
  });
});

test("DISC-12: a stable id merely containing 'uid' is never treated as generated (classifier regression)", () => {
  // The generated-id test is "--uid" or "input-<n>" ONLY. A single-dash id like
  // "candidate-uid-display" is an ordinary stable id and must keep winning over an automation id.
  assert.equal(selectorFor(control({ id: "candidate-uid-display", automationId: "x" })), "#candidate-uid-display");
});

/* ── PHASE 9D — date/month control recognition ────────────────────────────────────────────────── */

test("PHASE9D-DATE-01: a date input is recognized as kind \"date\", not lumped into \"unknown\"", () => {
  const [field] = discoverFields([control({ id: "start_date", type: "date", labelText: "Start Date" })]);
  assert.equal(field.kind, "date");
});

test("PHASE9D-DATE-02: a month input is recognized as kind \"month\"", () => {
  const [field] = discoverFields([control({ id: "grad_month", type: "month", labelText: "Graduation" })]);
  assert.equal(field.kind, "month");
});

test("PHASE9D-DATE-03: an UNLABELED date field is still discovered (previously silently dropped as unknown+no-label furniture)", () => {
  // Before this kind existed, an unlabeled date input fell to kind "unknown", and discoverFields
  // drops unknown+unlabeled controls as page furniture — silently losing a real question.
  const fields = discoverFields([control({ id: "sd1", type: "date", labelText: null })]);
  assert.equal(fields.length, 1, "a date control must never be silently dropped for lacking a label");
});
