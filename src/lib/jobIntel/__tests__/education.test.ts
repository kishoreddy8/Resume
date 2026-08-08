import assert from "node:assert/strict";
import { test } from "node:test";
import { extractEducation } from "../education";

test("equivalent education: 'Bachelor's degree or equivalent experience' preserves the equivalency", () => {
  const html = "<p>Bachelor's degree or equivalent experience required.</p>";
  const result = extractEducation(html, null);
  assert.equal(result.level, "Bachelor's");
  assert.equal(result.equivalentExperienceAllowed, true, "degree should not be treated as strictly mandatory");
});

test("degree with field: 'Bachelor's degree in Computer Science'", () => {
  const html = "<p>Bachelor's degree in Computer Science is required.</p>";
  const result = extractEducation(html, null);
  assert.equal(result.level, "Bachelor's");
  assert.equal(result.field, "Computer Science");
  assert.equal(result.requirement, "Required");
});

test("Master's degree preferred", () => {
  const html = "<p>Master's degree preferred.</p>";
  const result = extractEducation(html, null);
  assert.equal(result.level, "Master's");
  assert.equal(result.requirement, "Preferred");
});

test("no education language: level stays null, requirement stays Unknown, nothing fabricated", () => {
  const html = "<p>We are looking for a great engineer.</p>";
  const result = extractEducation(html, null);
  assert.equal(result.level, null);
  assert.equal(result.requirement, "Unknown");
  assert.equal(result.equivalentExperienceAllowed, false);
});

test("no explicit required/preferred cue near the degree mention: requirement is Unknown, not fabricated", () => {
  const html = "<p>Bachelor's degree in a related field.</p>";
  const result = extractEducation(html, null);
  assert.equal(result.level, "Bachelor's");
  assert.equal(result.requirement, "Unknown");
});

test("malformed JD does not throw", () => {
  assert.doesNotThrow(() => extractEducation("<p>Bachelor's <b>degree<div>required", null));
});

test("null/empty description returns empty result", () => {
  const result = extractEducation(null, null);
  assert.equal(result.level, null);
  assert.equal(result.evidence, null);
});
