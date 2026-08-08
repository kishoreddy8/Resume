import assert from "node:assert/strict";
import { test } from "node:test";
import { combineH1bConfidence } from "../combineSignal";

test("JD override: negative polarity forces Not Sponsoring regardless of company confidence", () => {
  for (const companyConfidence of ["Very High", "High", "Medium", "Low", "Unknown"] as const) {
    const result = combineH1bConfidence(companyConfidence, "negative");
    assert.equal(result.confidence, "Not Sponsoring", companyConfidence);
    assert.equal(result.overridden, true, companyConfidence);
    assert.match(result.reason, /explicitly states no visa sponsorship/);
  }
});

test("JD override: positive polarity forces Very High regardless of company confidence", () => {
  for (const companyConfidence of ["Unknown", "Low", "Medium", "High", "Very High"] as const) {
    const result = combineH1bConfidence(companyConfidence, "positive");
    assert.equal(result.confidence, "Very High", companyConfidence);
    assert.equal(result.overridden, true, companyConfidence);
    assert.match(result.reason, /explicitly offers visa sponsorship/);
  }
});

test("no JD language: falls back to the company's historical confidence, unmodified", () => {
  for (const companyConfidence of ["Very High", "High", "Medium", "Low", "Unknown"] as const) {
    const result = combineH1bConfidence(companyConfidence, "none");
    assert.equal(result.confidence, companyConfidence);
    assert.equal(result.overridden, false);
    assert.match(result.reason, /historical DOL H1B\/LCA filing record/);
  }
});
