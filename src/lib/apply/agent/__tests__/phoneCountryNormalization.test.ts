import test from "node:test";
import assert from "node:assert/strict";
import { matchQuestion } from "../../questionMatching";
import { greenhouseAdapter } from "../adapters/greenhouse";
import { planFields } from "../planFields";
import { derivePhoneCountryCode, findCanonicalPhoneCountry } from "../phoneCountryNormalizer";
import type { DiscoveredField } from "../types";
import type { QuestionType } from "../../questionTypes";

/**
 * Phone Country / Dial Code Normalization & Semantic Classification Tests.
 *
 * PHONE-01: Greenhouse phone "Country*" control is classified as phone dial-code, not residence country.
 * PHONE-02: Verified +1 phone metadata resolves exact Greenhouse option "United States +1".
 * PHONE-03: Unknown/unverified phone-country context causes ASK, not guess.
 * PHONE-04: Country-of-residence field remains separate from phone dial-code.
 * PHONE-05: Generic Country field outside phone context is not reclassified incorrectly.
 * PHONE-06: Combobox exact-match safety unchanged (no fuzzy/closest match).
 * SAFE-01: Sponsorship behavior unchanged.
 * SAFE-02: Demographic never-auto behavior unchanged.
 */

const knownVariants = new Map<string, { canonicalKey: string; type: QuestionType }>();
const storedAnswers = new Map();

const baseContext = {
  candidateId: 1,
  contact: {
    name: "Saikishore Reddy",
    email: "saireddy2898@gmail.com",
    phone: "9452370560",
    location: "Dallas, TX",
    linkedin: "linkedin.com/in/saikishore28",
  },
  resumePath: "/path/to/resume.docx",
  coverLetterPath: "/path/to/cover.docx",
};

const GH_PHONE_COUNTRY_OPTIONS = [
  "United States +1",
  "Canada +1",
  "United Kingdom +44",
  "India +91",
  "Australia +61",
  "Germany +49",
  "France +33",
  "Japan +81",
  "China +86",
  "Mexico +52",
  "Afghanistan +93",
  "Albania +355",
];

// ─── PHONE-01: Greenhouse #country hint maps to phone_country_code ──────────
test("PHONE-01: Greenhouse #country is classified as phone_country_code via adapter hints", () => {
  const hints = greenhouseAdapter.fieldSelectorHints();
  assert.equal(hints?.phone_country_code, "#country", "Greenhouse hint maps #country to phone_country_code");

  const fields: DiscoveredField[] = [
    { selector: "#phone", id: "phone", name: null, label: "Phone*", kind: "tel", required: true },
    { selector: "#country", id: "country", name: null, label: "Country*", kind: "combobox", required: true },
  ];

  const plans = planFields({
    fields,
    context: baseContext,
    knownVariants,
    storedAnswers,
    selectorHints: hints,
  });

  assert.equal(plans.length, 2);
  const plan = plans.find((p) => p.field.selector === "#country");
  assert.ok(plan);
  assert.equal(plan!.action, "fill");
  if (plan?.action === "fill") {
    assert.equal(plan.canonicalKey, "phone_country_code");
    assert.equal(plan.value, "+1");
    assert.equal(plan.phoneCountryContext, "United States");
  }
});

// ─── PHONE-02: Verified +1 phone resolves exact Greenhouse option ────────────
test("PHONE-02: findCanonicalPhoneCountry maps +1 and United States to 'United States +1'", () => {
  const derived = derivePhoneCountryCode("9452370560", "Dallas, TX");
  assert.ok(derived);
  assert.equal(derived!.dialCode, "+1");
  assert.equal(derived!.countryName, "United States");

  const canonical = findCanonicalPhoneCountry(derived!.dialCode, GH_PHONE_COUNTRY_OPTIONS, derived!.countryName);
  assert.equal(canonical, "United States +1");
});

test("PHONE-02b: E.164 +44 phone resolves to 'United Kingdom +44'", () => {
  const derived = derivePhoneCountryCode("+44 7911 123456", "London, UK");
  assert.ok(derived);
  assert.equal(derived!.dialCode, "+44");
  assert.equal(derived!.countryName, "United Kingdom");

  const canonical = findCanonicalPhoneCountry(derived!.dialCode, GH_PHONE_COUNTRY_OPTIONS, derived!.countryName);
  assert.equal(canonical, "United Kingdom +44");
});

test("PHONE-02c: E.164 +91 phone resolves to 'India +91'", () => {
  const derived = derivePhoneCountryCode("+91 98765 43210", "Hyderabad, India");
  assert.ok(derived);
  assert.equal(derived!.dialCode, "+91");
  assert.equal(derived!.countryName, "India");

  const canonical = findCanonicalPhoneCountry(derived!.dialCode, GH_PHONE_COUNTRY_OPTIONS, derived!.countryName);
  assert.equal(canonical, "India +91");
});

// ─── PHONE-03: Unknown/unverified phone-country causes ASK, not guess ────────
test("PHONE-03: 10-digit phone with no location context cannot confirm country → asks safely", () => {
  const derived = derivePhoneCountryCode("9452370560", null);
  assert.equal(derived, null, "Without location context, 10-digit number is ambiguous between US and Canada");

  const fields: DiscoveredField[] = [
    { selector: "#country", id: "country", name: null, label: "Country*", kind: "combobox", required: true },
  ];

  const plans = planFields({
    fields,
    context: {
      ...baseContext,
      contact: { ...baseContext.contact, phone: "9452370560", location: "" },
    },
    knownVariants,
    storedAnswers,
    selectorHints: greenhouseAdapter.fieldSelectorHints(),
  });

  assert.equal(plans[0].action, "ask", "Must pause and ask user when phone country cannot be verified");
});

test("PHONE-03b: Invalid/short phone number causes ASK", () => {
  const derived = derivePhoneCountryCode("12345", "Dallas, TX");
  assert.equal(derived, null, "Short/invalid number cannot derive dial code");
});

// ─── PHONE-04: Country of residence remains separate from phone dial code ────
test("PHONE-04: 'Country of Residence' maps to country_of_residence, not phone_country_code", () => {
  const match = matchQuestion("Country of Residence", knownVariants);
  assert.ok(match);
  assert.equal(match!.canonicalKey, "country_of_residence");
  assert.notEqual(match!.canonicalKey, "phone_country_code");
});

// ─── PHONE-05: Generic Country field outside phone context is not reclassified
test("PHONE-05: Generic 'Country' label maps to country (residence), not phone_country_code", () => {
  const match = matchQuestion("Country", knownVariants);
  assert.ok(match);
  assert.equal(match!.canonicalKey, "country");
  assert.notEqual(match!.canonicalKey, "phone_country_code");

  // A generic Country field with no selector hints asks when no country answer is in vault
  const fields: DiscoveredField[] = [
    { selector: "#residence_country", id: "residence_country", name: "residence_country", label: "Country", kind: "combobox", required: true },
  ];

  const plans = planFields({
    fields,
    context: baseContext,
    knownVariants,
    storedAnswers,
    // No greenhouse hint for residence_country
    selectorHints: greenhouseAdapter.fieldSelectorHints(),
  });

  assert.equal(plans[0].action, "ask", "Generic country field requires explicit answer, not phone dial code");
});

// ─── PHONE-06: Combobox exact-match safety unchanged ─────────────────────────
test("PHONE-06: findCanonicalPhoneCountry returns null on unmatched dial code or ambiguous matches", () => {
  // Unmatched dial code
  const unmatched = findCanonicalPhoneCountry("+999", GH_PHONE_COUNTRY_OPTIONS, "Unknownland");
  assert.equal(unmatched, null, "Non-existent dial code returns null");

  // Ambiguous dial code without country context (+1 matches US and Canada)
  const ambiguous = findCanonicalPhoneCountry("+1", GH_PHONE_COUNTRY_OPTIONS, null);
  assert.equal(ambiguous, null, "Ambiguous dial code without country context returns null");
});

// ─── SAFE-01: Sponsorship safety unchanged ───────────────────────────────────
test("SAFE-01: Sponsorship question with no vault answer still causes ASK", () => {
  const fields: DiscoveredField[] = [
    { selector: "#question_65938389", id: "question_65938389", name: null, label: "Do you now or in the future require visa sponsorship?*", kind: "combobox", required: true },
  ];

  const plans = planFields({
    fields,
    context: baseContext,
    knownVariants,
    storedAnswers,
    selectorHints: greenhouseAdapter.fieldSelectorHints(),
  });

  assert.equal(plans[0].action, "ask", "Sponsorship must pause safely when no vault answer exists");
});

// ─── SAFE-02: Demographic never-auto safety unchanged ────────────────────────
test("SAFE-02: Demographic combobox is planned as ASK, never AUTO-FILLED", () => {
  const fields: DiscoveredField[] = [
    { selector: "#gender", id: "gender", name: null, label: "Gender", kind: "combobox", required: false },
  ];

  const plans = planFields({
    fields,
    context: baseContext,
    knownVariants,
    storedAnswers,
    selectorHints: greenhouseAdapter.fieldSelectorHints(),
  });

  assert.equal(plans[0].action, "ask", "Demographics are never auto-filled");
});

// ─── PHONE-07: #country with #phone present plans as phone_country_code ───────
test("PHONE-07: #country alongside #phone plans as phone_country_code from verified contact", () => {
  const fields: DiscoveredField[] = [
    { selector: "#phone", id: "phone", name: null, label: "Phone*", kind: "tel", required: true },
    { selector: "#country", id: "country", name: null, label: "Country*", kind: "combobox", required: true },
  ];

  const plans = planFields({
    fields,
    context: baseContext,
    knownVariants,
    storedAnswers,
    selectorHints: greenhouseAdapter.fieldSelectorHints(),
  });

  assert.equal(plans.length, 2);
  const phonePlan = plans.find((p) => p.field.selector === "#phone");
  const countryPlan = plans.find((p) => p.field.selector === "#country");

  assert.ok(phonePlan && phonePlan.action === "fill");
  assert.ok(countryPlan && countryPlan.action === "fill");
  if (countryPlan?.action === "fill") {
    assert.equal(countryPlan.canonicalKey, "phone_country_code");
    assert.equal(countryPlan.value, "+1");
    assert.equal(countryPlan.phoneCountryContext, "United States");
  }
});

// ─── PHONE-08: #country without #phone plans as generic country (residence) ──
test("PHONE-08: #country without #phone plans as generic country, not phone_country_code", () => {
  const fields: DiscoveredField[] = [
    { selector: "#country", id: "country", name: null, label: "Country*", kind: "combobox", required: true },
  ];

  const plans = planFields({
    fields,
    context: baseContext,
    knownVariants,
    storedAnswers,
    selectorHints: greenhouseAdapter.fieldSelectorHints(),
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0].action, "ask");
  if (plans[0].action === "ask") {
    assert.equal(plans[0].questionType, "contact");
  }
});
