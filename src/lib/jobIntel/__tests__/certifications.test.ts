import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCertifications } from "../certifications";

test("named certification, required", () => {
  const html = "<p>AWS Certified Solutions Architect is required.</p>";
  const result = extractCertifications(html, null);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "AWS Certified Solutions Architect");
  assert.equal(result[0].requirementLevel, "Required");
});

test("longer named cert wins over a shorter substring cert (no duplicate rows)", () => {
  const html = "<p>AWS Certified Solutions Architect required.</p>";
  const result = extractCertifications(html, null);
  assert.equal(result.length, 1, "should not also match the shorter 'AWS Certified' as a separate row");
});

test("preferred certification via cue word", () => {
  const html = "<p>PMP certification preferred.</p>";
  const result = extractCertifications(html, null);
  assert.equal(result.find((c) => c.name === "PMP")?.requirementLevel, "Preferred");
});

test("generic 'X certification' pattern", () => {
  const html = "<p>Scrum Master certification is required.</p>";
  const result = extractCertifications(html, null);
  assert.ok(result.find((c) => /scrum master/i.test(c.name)));
});

test("does not infer a certification from a bare technology mention", () => {
  const html = "<p>Must have strong AWS experience.</p>";
  const result = extractCertifications(html, null);
  assert.equal(result.length, 0, "a bare 'AWS' mention must never create a certification row");
});

test("no cue word at all: not classified, not fabricated", () => {
  // "PMP" appears but the line carries no required/preferred cue word.
  const html = "<p>PMP is a well known credential.</p>";
  assert.equal(extractCertifications(html, null).length, 0);
});

test("malformed JD does not throw", () => {
  assert.doesNotThrow(() => extractCertifications("<p>PMP <b>required<div>", null));
});

test("null/empty description returns empty array", () => {
  assert.deepEqual(extractCertifications(null, null), []);
});
