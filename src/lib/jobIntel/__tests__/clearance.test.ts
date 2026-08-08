import assert from "node:assert/strict";
import { test } from "node:test";
import { extractClearance } from "../clearance";

test("clearance required, explicit phrasing", () => {
  const result = extractClearance("Candidates must hold an active security clearance.");
  assert.equal(result.required, "Required");
});

test("clearance level detected: Top Secret", () => {
  const result = extractClearance("This role requires a Top Secret clearance.");
  assert.equal(result.required, "Required");
  assert.ok(result.level && /top secret/i.test(result.level));
});

test("TS/SCI level detected", () => {
  const result = extractClearance("Active TS/SCI clearance needed.");
  assert.ok(result.level && /ts\/sci/i.test(result.level));
});

test("citizenship requirement detected separately from clearance", () => {
  const result = extractClearance("Must be a U.S. citizen. No clearance required for this specific role.");
  assert.equal(result.citizenshipRequired, "Required");
});

test("citizenship and clearance are independent facts, not merged", () => {
  const result = extractClearance("U.S. citizens only for this role.");
  assert.equal(result.citizenshipRequired, "Required");
  assert.equal(result.required, "Unknown", "no clearance language present, so clearance itself stays Unknown");
});

test("general work authorization language detected", () => {
  const result = extractClearance("Must be authorized to work in the United States.");
  assert.equal(result.workAuthorizationRequired, "Required");
});

test("no clearance/citizenship language: everything Unknown, nothing fabricated", () => {
  const result = extractClearance("We are looking for a great data engineer.");
  assert.equal(result.required, "Unknown");
  assert.equal(result.citizenshipRequired, "Unknown");
  assert.equal(result.workAuthorizationRequired, "Unknown");
});

test("null description handled safely", () => {
  const result = extractClearance(null);
  assert.equal(result.required, "Unknown");
});
