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

/* ── PHASE 9E.2 — a password input is never application data ─────────────────────────────────── */

test("SECRET-FIELD-01: a password input is NEVER discovered as an application field", () => {
  /* FOUND BY THE REAL WORKDAY RUN. A mis-detected auth state let the engine treat a sign-in form as
   * the application form: it filled Email and then asked the operator for "Password" through the
   * Human Question Center. Any answer given there would have been persisted into the run's
   * checkpoint — a password written to SQLite, which is precisely what credentials.ts exists to
   * prevent. A password field is authentication, never application data; ensureAuthenticated is the
   * only thing that may ever type into one. */
  const fields = discoverFields([
    control({ id: "password", type: "password", labelText: "Password", required: true }),
    control({ id: "verifyPassword", type: "password", labelText: "Verify New Password", required: true }),
  ]);
  assert.deepEqual(fields, [], "no password control may be discovered, labelled or not");
});

test("SECRET-FIELD-02: a password field cannot reach the planner, so it can never become a human question", () => {
  const fields = discoverFields([
    control({ id: "first_name", labelText: "First Name", required: true }),
    control({ id: "password", type: "password", labelText: "Password", required: true }),
  ]);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].id, "first_name", "only the real application field survives discovery");
});

/**
 * PHASE 9E — VALIDATION OBSERVATION. Real State Street evidence, sanitized: Run 22 filled every
 * field discovery could see, and Workday still refused to advance. A `validation_snapshot` capture
 * taken at the exact moment of refusal showed the ACTUAL cause — two required fields Career-Ops
 * never even attempted, because they are rendered as `<button data-automation-id="formField-...">`
 * elements with `aria-haspopup="listbox"`, not `<input>`s — completely outside
 * `COLLECT_CONTROLS_SCRIPT`'s old `"input, select, textarea"` query. "State"
 * (`formField-countryRegion`) and "Phone Device Type" (`formField-phoneType`) were silently
 * invisible: never filled, never asked about, and never counted toward "nothing more could be
 * safely filled" — which is exactly why that message was reached with two required Workday
 * questions still genuinely unanswered.
 */
test("BUTTON-PICKER-01: a button with aria-haspopup=\"listbox\" is discovered as a combobox (Workday's real State / Phone Device Type shape)", () => {
  const [field] = discoverFields([
    control({ tag: "button", automationId: "formField-countryRegion", ariaHaspopup: "listbox", labelText: "State", required: true }),
  ]);
  assert.ok(field, "the button must be discovered at all — it was previously invisible");
  assert.equal(field.kind, "combobox");
  assert.equal(field.required, true);
});

test("BUTTON-PICKER-02: an ordinary button (no aria-haspopup) is never classified as a combobox — kindOf, in isolation", () => {
  /* The REAL exclusion happens one layer earlier: COLLECT_CONTROLS_SCRIPT's live query is
   * `button[aria-haspopup="listbox"]`, so an ordinary "Cancel"/"Save and Continue" button is never
   * even collected into a RawControl in the first place (proved live in workdayDiscovery.test.ts,
   * BUTTON-PICKER-05). `type: null` here models a real button's actual attribute — never "text",
   * which only an <input> carries — so this test is not defeated by the test helper's own default. */
  const [field] = discoverFields([control({ tag: "button", type: null, id: "cancel-button", labelText: "Cancel" })]);
  assert.notEqual(field?.kind, "combobox", "a plain button must never be classified as a combobox");
});

test("BUTTON-PICKER-03: aria-haspopup values other than \"listbox\" (e.g. \"dialog\") are not treated as a combobox picker", () => {
  const [field] = discoverFields([control({ tag: "button", type: null, id: "help-button", ariaHaspopup: "dialog", labelText: "Help" })]);
  assert.notEqual(field?.kind, "combobox", "only the observed listbox shape is recognized — a dialog-opening button is a different control entirely");
});

test("BUTTON-PICKER-04: with no stored answer, a newly-discovered button picker is asked about, never guessed at (matches the real State/Phone Device Type outcome)", () => {
  const fields = discoverFields([
    control({ tag: "button", automationId: "formField-phoneType", ariaHaspopup: "listbox", labelText: "Phone Device Type", required: true }),
  ]);
  const plans = planFields({ fields, context: CONTEXT, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.action, "ask", "an unrecognized required field must be asked, never filled with a guess");
});

/**
 * PHASE 9E.3 — FORM-CONTROL SCOPING. Real Run 23 evidence (State Street, 2026-08-25): the
 * button-picker discovery above (BUTTON-PICKER-01..05) also swept in Workday's own persistent page
 * chrome — `languageSelectorButton` and `settingsSelectorButton`, each a `<button
 * aria-haspopup="listbox">` with NO label of any kind — and surfaced them as two junk Human
 * Questions while the real My Information form was never reached. These tests pin the fix: a
 * button-driven picker is only ever a question when it carries a discoverable label, exactly like
 * every other `unknown`-kind control.
 */
test("FORM-SCOPE-01: a real, labeled button picker inside recognized field context is still discovered (State/Phone Device Type unaffected)", () => {
  const fields = discoverFields([
    control({ tag: "button", id: "address--countryRegion", automationId: "formField-countryRegion", ariaHaspopup: "listbox", labelText: "State", required: true }),
  ]);
  assert.equal(fields.length, 1);
  assert.equal(fields[0]!.kind, "combobox");
  assert.equal(fields[0]!.label, "State");
});

test("FORM-SCOPE-02: an unlabeled header language-switcher button (languageSelectorButton shape) is excluded, never a question", () => {
  const fields = discoverFields([
    control({ tag: "button", id: "languageSelectorButton", ariaHaspopup: "listbox", labelText: null, ariaLabel: null }),
  ]);
  assert.equal(fields.length, 0, "unlabeled page chrome must never become a discovered field");
});

test("FORM-SCOPE-03: an unlabeled settings/accessibility menu button (settingsSelectorButton shape) is excluded, never a question", () => {
  const fields = discoverFields([
    control({ tag: "button", id: "settingsSelectorButton", ariaHaspopup: "listbox", labelText: null, ariaLabel: null }),
  ]);
  assert.equal(fields.length, 0, "unlabeled page chrome must never become a discovered field");
});

test("FORM-SCOPE-04: an ordinary button with no aria-haspopup is never classified as a combobox by the new rule (pre-existing behavior, unaffected)", () => {
  const [field] = discoverFields([control({ tag: "button", type: null, id: "cancel-button", labelText: "Cancel" })]);
  assert.notEqual(field?.kind, "combobox", "the new scoping rule only ever applies to kind === \"combobox\" — an ordinary button was never affected by it");
});

test("FORM-SCOPE-05: native input/select/textarea discovery is completely unaffected by the scoping rule", () => {
  const fields = discoverFields([
    control({ id: "first_name", labelText: "First Name" }),
    control({ tag: "select", id: "country", labelText: "Country", options: ["US", "CA"] }),
    control({ tag: "textarea", id: "cover_note", labelText: "Cover Note" }),
  ]);
  assert.equal(fields.length, 3, "the scoping rule only ever excludes an unlabeled BUTTON combobox");
  assert.deepEqual(fields.map((f) => f.kind), ["text", "select", "textarea"]);
});

test("FORM-SCOPE-06: required semantics of a real labeled button picker survive the scoping check", () => {
  const [field] = discoverFields([
    control({ tag: "button", id: "phoneNumber--phoneType", automationId: "formField-phoneType", ariaHaspopup: "listbox", labelText: "Phone Device Type", required: true }),
  ]);
  assert.equal(field!.required, true, "a genuine required field must not lose its required flag on the way through the new guard");
});
