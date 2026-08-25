import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * PHASE 9D — QUESTION-UI-01/02/04/05/06: source-verification tests for the human-question batch
 * UI, matching this repo's existing convention for surfaces with no jsdom/component-rendering
 * harness (see qualityWorkflowApprovalUi.test.ts / workspacePremiumUi.test.ts): no
 * @testing-library/react and zero .test.tsx files exist anywhere in the codebase, so UI behavior is
 * proven by asserting the actual source contains the specific control-rendering logic it must
 * contain, rather than rendering and inspecting DOM output.
 *
 * QUESTION-UI-03 (checkbox-GROUP multi-select) is deliberately NOT covered here — Career-Ops does
 * not yet group same-name checkboxes into one logical multi-select question; each checkbox remains
 * an independent boolean field, exactly as before this phase. See the Phase 9D final report.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

const SOURCE = read("src/app/applications/[id]/ApplicationDetail.tsx");

test("QUESTION-UI-01: a dropdown (select) question renders with the CURRENT options, not a hardcoded list", () => {
  assert.match(SOURCE, /q\.options && q\.options\.length > 0/, "options gate the select branch");
  assert.match(SOURCE, /q\.options\.map\(\(opt\) => <option key={opt} value={opt}>{opt}<\/option>\)/, "every current option renders, verbatim");
});

test("QUESTION-UI-02: a radio question renders as an actual radio GROUP (fieldset + radio inputs), preserving its exact options — not forced through a dropdown", () => {
  assert.match(SOURCE, /q\.kind === "radio" && q\.options && q\.options\.length > 0/);
  assert.match(SOURCE, /<fieldset/);
  assert.match(SOURCE, /type="radio"/);
  assert.match(SOURCE, /name={`batch-\$\{q\.id\}`}/, "radio inputs for one question share a name so only one can be selected");
});

test("QUESTION-UI-04: a date/month question renders a date-compatible input, not a plain text box", () => {
  assert.match(SOURCE, /q\.kind === "date" \|\| q\.kind === "month"/);
  assert.match(SOURCE, /type={q\.kind}/);
});

test("QUESTION-UI-05: a textarea question stays a textarea", () => {
  assert.match(SOURCE, /q\.kind === "textarea"/);
  assert.match(SOURCE, /<textarea/);
});

test("QUESTION-UI-06: required vs optional questions remain visually distinguishable", () => {
  assert.match(SOURCE, /q\.required && <span className="ml-1 text-\[var\(--error\)\]" aria-label="required">\*<\/span>/);
});

test("accessibility: the radio group's fieldset carries a legend naming the question (Part 34 — no bare, unlabelled grouped control)", () => {
  assert.match(SOURCE, /<legend className="sr-only">\{q\.label\}<\/legend>/);
});

test("a checkbox-kind question with no options renders an actual checkbox, not a free-text box", () => {
  assert.match(SOURCE, /q\.kind === "checkbox" && \(!q\.options \|\| q\.options\.length === 0\)/);
  assert.match(SOURCE, /type="checkbox"[\s\S]{0,120}id={`batch-\$\{q\.id\}`}/);
});
