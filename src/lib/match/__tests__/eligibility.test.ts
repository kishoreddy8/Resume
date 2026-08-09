import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { evaluateEligibility, type EligibilityJobInput } from "../eligibility";

function job(overrides: Partial<EligibilityJobInput>): EligibilityJobInput {
  return {
    sponsorshipPolarity: "none",
    companyH1bConfidence: "Unknown",
    clearanceRequired: "Not Required",
    clearanceLevel: null,
    citizenshipRequired: "Not Required",
    workAuthorizationRequired: "Not Required",
    ...overrides,
  };
}

const requiresSponsorship = { ...DEFAULT_SETTINGS.candidate, requiresSponsorship: true };
const noSponsorshipNeeded = { ...DEFAULT_SETTINGS.candidate, requiresSponsorship: false };

test("explicit negative JD sponsorship language is a hard BLOCKED for a candidate who needs sponsorship", () => {
  const result = evaluateEligibility(job({ sponsorshipPolarity: "negative" }), requiresSponsorship);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.sponsorship.signal, "explicit_negative");
});

test("explicit positive JD sponsorship language is PASS with role-specific note, not a legal guarantee claim", () => {
  const result = evaluateEligibility(job({ sponsorshipPolarity: "positive" }), requiresSponsorship);
  assert.equal(result.status, "PASS");
  assert.equal(result.sponsorship.signal, "explicit_positive");
  assert.ok(!/guarantee/i.test(result.sponsorship.note) || /not a legal guarantee/i.test(result.sponsorship.note));
});

test("silent JD + company historical sponsorship record is PASS but explicitly caveated as NOT a per-requisition confirmation", () => {
  const result = evaluateEligibility(job({ sponsorshipPolarity: "none", companyH1bConfidence: "High" }), requiresSponsorship);
  assert.equal(result.status, "PASS");
  assert.equal(result.sponsorship.signal, "silent_company_history");
  assert.match(result.sponsorship.note, /NOT confirmation/i);
  assert.match(result.sponsorship.note, /propensity/i);
});

test("silent JD + no company history at all is genuinely UNKNOWN, never silently PASS", () => {
  const result = evaluateEligibility(job({ sponsorshipPolarity: "none", companyH1bConfidence: "Unknown" }), requiresSponsorship);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.sponsorship.signal, "unknown");
});

test("candidate who does not require sponsorship: job's sponsorship posture never affects eligibility", () => {
  const result = evaluateEligibility(job({ sponsorshipPolarity: "negative" }), noSponsorshipNeeded);
  assert.equal(result.status, "PASS");
  assert.equal(result.sponsorship.signal, "not_applicable");
});

test("required clearance the candidate does not hold is a hard BLOCKED", () => {
  const result = evaluateEligibility(job({ clearanceRequired: "Required", clearanceLevel: "Secret" }), { ...DEFAULT_SETTINGS.candidate, requiresSponsorship: false, clearanceLevel: "None" });
  assert.equal(result.status, "BLOCKED");
});

test("required clearance the candidate holds at or above the required level is not blocked by it", () => {
  const result = evaluateEligibility(job({ clearanceRequired: "Required", clearanceLevel: "Secret" }), { ...DEFAULT_SETTINGS.candidate, requiresSponsorship: false, clearanceLevel: "Top Secret" });
  assert.equal(result.status, "PASS");
});

test("required citizenship the candidate profile does not confirm is a hard BLOCKED", () => {
  const result = evaluateEligibility(job({ citizenshipRequired: "Required" }), { ...DEFAULT_SETTINGS.candidate, requiresSponsorship: false, usCitizen: false });
  assert.equal(result.status, "BLOCKED");
});

test("required work authorization the candidate profile does not confirm is a hard BLOCKED", () => {
  const result = evaluateEligibility(job({ workAuthorizationRequired: "Required" }), { ...DEFAULT_SETTINGS.candidate, requiresSponsorship: false, workAuthorizedUS: false });
  assert.equal(result.status, "BLOCKED");
});

test("missing/Unknown job-side clearance/citizenship/work-auth facts never block on their own (missing info is not failure)", () => {
  const result = evaluateEligibility(
    job({ clearanceRequired: "Unknown" as unknown as "Not Required", citizenshipRequired: "Unknown" as unknown as "Not Required", workAuthorizationRequired: "Unknown" as unknown as "Not Required" }),
    noSponsorshipNeeded
  );
  assert.equal(result.status, "PASS");
});

test("multiple simultaneous hard blockers are all collected, not just the first", () => {
  const result = evaluateEligibility(
    job({ sponsorshipPolarity: "negative", citizenshipRequired: "Required" }),
    { ...requiresSponsorship, usCitizen: false }
  );
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasons.length >= 2);
});

test("PASS is never rendered as a bare status — reasons/sponsorship.note are always populated", () => {
  const result = evaluateEligibility(job({}), noSponsorshipNeeded);
  assert.equal(result.status, "PASS");
  assert.ok(result.reasons.length > 0);
  assert.ok(result.sponsorship.note.length > 0);
});
