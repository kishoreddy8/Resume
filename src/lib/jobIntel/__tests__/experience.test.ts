import assert from "node:assert/strict";
import { test } from "node:test";
import { extractExperience } from "../experience";

test("overall years of experience: '5+ years overall data engineering'", () => {
  const html = "<p>5+ years overall data engineering experience required.</p>";
  const result = extractExperience(html, null);
  assert.equal(result.minYears, 5);
});

test("technology-specific years: '3+ years PySpark' and '2 years Azure' tracked separately from overall", () => {
  const html = "<p>5+ years overall data engineering experience.<br>3+ years PySpark.<br>2 years Azure.</p>";
  const result = extractExperience(html, null);
  assert.equal(result.minYears, 5, "overall minimum should come from the skill-free statement");
  const pyspark = result.byTech.find((t) => t.technology === "PySpark");
  const azure = result.byTech.find((t) => t.technology === "Azure");
  assert.equal(pyspark?.years, 3);
  assert.equal(azure?.years, 2);
});

test("range statement: '3-5 years' splits into min/preferred", () => {
  const html = "<p>3-5 years of experience with SQL.</p>";
  const result = extractExperience(html, null);
  assert.equal(result.minYears, 3);
  assert.equal(result.preferredYears, 5);
});

test("distinct required + preferred statements: '5+ years required, 7+ years preferred'", () => {
  const html = "<p>5+ years of experience required.<br>7+ years preferred.</p>";
  const result = extractExperience(html, null);
  assert.equal(result.minYears, 5);
  assert.equal(result.preferredYears, 7);
});

test("sparse JD with no years language returns null, not a fabricated value", () => {
  const html = "<p>We are looking for a great engineer.</p>";
  const result = extractExperience(html, null);
  assert.equal(result.minYears, null);
  assert.equal(result.preferredYears, null);
  assert.deepEqual(result.byTech, []);
});

test("malformed JD does not throw", () => {
  assert.doesNotThrow(() => extractExperience("<p>5+ years <b>Python<div>3+", null));
});

test("null/empty description returns empty result", () => {
  const result = extractExperience(null, null);
  assert.equal(result.minYears, null);
  assert.equal(result.evidence, null);
});
