import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSeniority, extractSeniorityFromBody } from "../seniority";

test("title-based seniority: Senior", () => {
  assert.equal(extractSeniority("Senior Data Engineer").level, "Senior");
});

test("title-based seniority: Staff", () => {
  assert.equal(extractSeniority("Staff Software Engineer").level, "Staff");
});

test("title-based seniority: Principal", () => {
  assert.equal(extractSeniority("Principal Data Scientist").level, "Principal");
});

test("title-based seniority: Manager not confused with Senior when both could apply", () => {
  assert.equal(extractSeniority("Senior Engineering Manager").level, "Manager");
});

test("title-based seniority: Intern", () => {
  assert.equal(extractSeniority("Data Engineering Intern").level, "Intern");
});

test("title with no seniority signal: Unknown", () => {
  const result = extractSeniority("Data Engineer");
  assert.equal(result.level, "Unknown");
  assert.equal(result.evidence, null);
});

test("body fallback: uninformative title, JD body carries the signal", () => {
  const result = extractSeniorityFromBody("We're looking for a recent graduate to join our team.");
  assert.equal(result.level, "Entry");
});

test("body fallback: no signal in body either -> Unknown, not fabricated", () => {
  const result = extractSeniorityFromBody("We build great data products.");
  assert.equal(result.level, "Unknown");
});

test("null description text handled safely", () => {
  const result = extractSeniorityFromBody(null);
  assert.equal(result.level, "Unknown");
});
