import assert from "node:assert/strict";
import { test } from "node:test";
import { extractVendorFlags, normalizeEmploymentType } from "../employmentType";

test("native ATS value normalizes directly: 'Full-time'", () => {
  assert.equal(normalizeEmploymentType("Full-time", null).type, "Full-Time");
});

test("native ATS value normalizes: Workday-style 'Part time'", () => {
  assert.equal(normalizeEmploymentType("Part time", null).type, "Part-Time");
});

test("contract-to-hire checked before bare 'Contract'", () => {
  assert.equal(normalizeEmploymentType("Contract-to-hire", null).type, "Contract-to-Hire");
});

test("native ATS field takes precedence over JD text when both are present", () => {
  const result = normalizeEmploymentType("Full-time", "This is a contract position.");
  assert.equal(result.type, "Full-Time", "reliable native field should win over a JD-text guess");
});

test("JD text fallback when native field is null", () => {
  const result = normalizeEmploymentType(null, "This is a full-time position based in Austin.");
  assert.equal(result.type, "Full-Time");
});

test("no signal anywhere: Unknown, not fabricated", () => {
  const result = normalizeEmploymentType(null, null);
  assert.equal(result.type, "Unknown");
  assert.equal(result.evidence, null);
});

test("vendor flags: W2 only", () => {
  assert.deepEqual(extractVendorFlags("This is a W2 only position."), ["W2 Only"]);
});

test("vendor flags: C2C mentioned", () => {
  assert.deepEqual(extractVendorFlags("Corp-to-corp candidates welcome."), ["C2C"]);
});

test("vendor flags: no C2C wins over a bare C2C mention", () => {
  assert.deepEqual(extractVendorFlags("No C2C candidates please."), ["No C2C"]);
});

test("vendor flags: none present -> empty array", () => {
  assert.deepEqual(extractVendorFlags("We are hiring a great engineer."), []);
});
