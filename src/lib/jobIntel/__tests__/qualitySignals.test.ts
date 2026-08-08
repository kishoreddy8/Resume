import assert from "node:assert/strict";
import { test } from "node:test";
import { extractQualitySignals } from "../qualitySignals";

test("staffing/vendor language sets a flag", () => {
  const flags = extractQualitySignals({
    descriptionText: "This role is on behalf of our client, a Fortune 500 company.",
    clearanceRequired: false,
    sponsorshipPolarity: "none",
  });
  assert.ok(flags.includes("Staffing/Vendor"));
});

test("no third-party recruiters language sets a flag", () => {
  const flags = extractQualitySignals({
    descriptionText: "No third-party agencies please.",
    clearanceRequired: false,
    sponsorshipPolarity: "none",
  });
  assert.ok(flags.includes("No Third-Party Recruiters"));
});

test("clearance required flag mirrors the clearance extractor's result", () => {
  const flags = extractQualitySignals({ descriptionText: null, clearanceRequired: true, sponsorshipPolarity: "none" });
  assert.ok(flags.includes("Clearance Required"));
});

test("sponsorship restriction flag mirrors negative sponsorship polarity", () => {
  const flags = extractQualitySignals({ descriptionText: null, clearanceRequired: false, sponsorshipPolarity: "negative" });
  assert.ok(flags.includes("Sponsorship Restriction"));
});

test("'Direct Employer' is never asserted — no positive text pattern can prove it", () => {
  const flags = extractQualitySignals({
    descriptionText: "We are a great company to work for.",
    clearanceRequired: false,
    sponsorshipPolarity: "none",
  });
  assert.ok(!flags.includes("Direct Employer"));
});

test("no evidence anywhere: empty array, nothing fabricated", () => {
  const flags = extractQualitySignals({ descriptionText: null, clearanceRequired: false, sponsorshipPolarity: "none" });
  assert.deepEqual(flags, []);
});
