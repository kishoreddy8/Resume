import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ApplicationBrowserRuntime } from "../browserRuntime";
import { captureValidationSnapshot } from "../validationSnapshot";

/**
 * PHASE 9E — VALIDATION OBSERVATION PASS. Proves `captureValidationSnapshot` reports exactly the
 * sanitized structural facts it claims to, against a fixture modelling the exact suspected State
 * Street failure: a combobox filled with plain text that Workday marks `aria-invalid`, plus an
 * ordinary valid field, a hidden field, and a page-level error banner.
 */

const mockUrl = pathToFileURL(path.join(import.meta.dirname, "mockAts/mock-validation-snapshot.html")).href;
const runtime = new ApplicationBrowserRuntime();

test.after(async () => {
  await runtime.close();
});

test("VALIDATION-SNAPSHOT-01: an aria-invalid combobox is reported as invalid, with its structural facts intact", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const snapshot = await captureValidationSnapshot(session.page);
    const county = snapshot.controls.find((c) => c.automationId === null && c.role === "combobox");
    assert.ok(county, "the county combobox must be found");
    assert.equal(county!.ariaInvalid, true);
    assert.equal(county!.ariaRequired, true);
    assert.equal(county!.ariaHaspopup, "listbox");
    assert.equal(county!.ariaControls, "county-listbox");
    assert.equal(county!.label, "County", "the fieldset legend is read as the label");
    assert.equal(county!.describedByText, "Please select a valid option from the list.");
  } finally {
    await session.close();
  }
});

test("VALIDATION-SNAPSHOT-02: no control's actual VALUE is ever captured — presence and length only", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const snapshot = await captureValidationSnapshot(session.page);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /Collin|Dallas/, "the county's actual selected/typed value must never appear");
    assert.doesNotMatch(serialized, /secret-should-not-appear/, "a hidden field's value must never appear");

    const county = snapshot.controls.find((c) => c.role === "combobox")!;
    assert.equal(county.hasValue, true);
    assert.equal(county.valueLength, "Collin".length);
  } finally {
    await session.close();
  }
});

test("VALIDATION-SNAPSHOT-03: a valid, non-invalid field is reported as such", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const snapshot = await captureValidationSnapshot(session.page);
    const firstName = snapshot.controls.find((c) => c.tag === "input" && c.type === "text" && c.label === "First Name");
    assert.ok(firstName);
    assert.equal(firstName!.ariaInvalid, false);
    assert.equal(firstName!.required, true);
  } finally {
    await session.close();
  }
});

test("VALIDATION-SNAPSHOT-04: a hidden field is reported as hidden", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const snapshot = await captureValidationSnapshot(session.page);
    const hidden = snapshot.controls.find((c) => c.valueLength === "secret-should-not-appear".length);
    assert.ok(hidden, "the hidden field must still be structurally reported (hidden, not silently dropped)");
    assert.equal(hidden!.hidden, true);
  } finally {
    await session.close();
  }
});

test("VALIDATION-SNAPSHOT-05: a page-level error banner is captured as page-level text, not attributed to one control", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const snapshot = await captureValidationSnapshot(session.page);
    assert.ok(snapshot.pageErrors.some((t) => t.includes("Please correct the errors below")));
  } finally {
    await session.close();
  }
});

test("VALIDATION-SNAPSHOT-06: heading and url are captured for provenance", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const snapshot = await captureValidationSnapshot(session.page);
    assert.equal(snapshot.heading, "My Information");
    assert.equal(snapshot.url, mockUrl);
  } finally {
    await session.close();
  }
});
