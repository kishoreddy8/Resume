import assert from "node:assert/strict";
import { test } from "node:test";
import { matchQuestion, normalizeQuestion } from "../questionMatching";

/**
 * GAP-1 — Country / Location (City) matching, observed missing on a real Greenhouse form (Celigo
 * dry run). Deterministic pattern matching only, same discipline as every other rule in
 * questionMatching.ts: no fuzzy distance, no guessing, and an explicit `none` guard wherever a
 * shared word could otherwise pull in an opposite/unrelated question.
 */

const NO_VARIANTS = new Map<string, { canonicalKey: string; type: import("../questionTypes").QuestionType }>();

test("MATCH-01: 'Country*' maps to the country contact question", () => {
  const match = matchQuestion("Country*", NO_VARIANTS);
  assert.ok(match);
  assert.equal(match!.canonicalKey, "country");
  assert.equal(match!.type, "contact");
});

test("MATCH-02: 'Location (City)*' maps to the city contact question", () => {
  const match = matchQuestion("Location (City)*", NO_VARIANTS);
  assert.ok(match);
  assert.equal(match!.canonicalKey, "location_city");
  assert.equal(match!.type, "contact");
});

test("MATCH-03: bare 'City' maps to the city contact question", () => {
  const match = matchQuestion("City", NO_VARIANTS);
  assert.ok(match);
  assert.equal(match!.canonicalKey, "location_city");
});

test("MATCH-04: an unrelated question that merely mentions 'location' does not match the new city rule", () => {
  // Already covered by the pre-existing location_current rule's own narrowness, but this proves the
  // NEW city rule doesn't widen that — "location" alone, without "city", must not match location_city.
  const match = matchQuestion("Preferred work location", NO_VARIANTS);
  assert.notEqual(match?.canonicalKey, "location_city");
});

test("a relocation-preference question is not answered with the candidate's current city", () => {
  const match = matchQuestion("Which city would you be willing to relocate to?", NO_VARIANTS);
  assert.notEqual(match?.canonicalKey, "location_city");
});

test("'Country Code' (a phone dial-code control) does not match the country residency question", () => {
  const match = matchQuestion("Country Code", NO_VARIANTS);
  assert.notEqual(match?.canonicalKey, "country");
});

test("'Current location' still maps to the existing location_current key, unchanged by the new rules", () => {
  const match = matchQuestion("Current location", NO_VARIANTS);
  assert.ok(match);
  assert.equal(match!.canonicalKey, "location_current");
});

test("normalizeQuestion strips general parentheses so 'Location (City)' reads as two plain words", () => {
  assert.equal(normalizeQuestion("Location (City)*"), "location city");
});

test("regression: 'Race / Ethnicity' is NOT reclassified as a contact question by the new city rule ('city' is a substring of 'ethnicity')", () => {
  const match = matchQuestion("Race / Ethnicity", NO_VARIANTS);
  assert.ok(match);
  assert.equal(match!.type, "voluntary_demographic", "a protected demographic question must never resolve to 'contact'");
});

// ── PHASE 9D — conservative new question categories ──────────────────────────────────────────────

test("'How did you hear about this position?' maps to referral_source (type other, ask each time)", () => {
  const match = matchQuestion("How did you hear about this position?", new Map());
  assert.equal(match?.canonicalKey, "referral_source");
  assert.equal(match?.type, "other");
});

test("'Have you previously been employed by our company?' maps to previously_employed", () => {
  const match = matchQuestion("Have you previously been employed by our company?", new Map());
  assert.equal(match?.canonicalKey, "previously_employed");
  assert.equal(match?.type, "other");
});

test("neither new pattern collides with work authorization or sponsorship", () => {
  assert.notEqual(matchQuestion("Are you authorized to work in the United States?", new Map())?.canonicalKey, "referral_source");
  assert.notEqual(matchQuestion("Will you require sponsorship?", new Map())?.canonicalKey, "previously_employed");
});

// ── PHASE 9E.2 — phone sub-fields must never collapse into the phone number ─────────────────────

test("PHONE-PARTS-01: 'Country Phone Code' maps to phone_country_code, never to phone", () => {
  /* FOUND ON THE REAL WORKDAY FORM. The broad ["phone"] rule matched "Country Phone Code" first,
   * so Career-Ops wrote the candidate's phone NUMBER into the country-code field of a live
   * application. Greenhouse never exposed this because its adapter hint claims #country before
   * matching runs; Workday has no such hint. */
  const match = matchQuestion("Country Phone Code*", new Map());
  assert.equal(match?.canonicalKey, "phone_country_code");
});

test("PHONE-PARTS-02: 'Phone Extension' is not the phone number", () => {
  const match = matchQuestion("Phone Extension", new Map());
  assert.notEqual(match?.canonicalKey, "phone", "an extension must never receive the full phone number");
});

test("PHONE-PARTS-03: 'Phone Device Type' is not the phone number", () => {
  const match = matchQuestion("Phone Device Type*", new Map());
  assert.notEqual(match?.canonicalKey, "phone");
});

test("PHONE-PARTS-04: a plain phone question still maps to phone", () => {
  assert.equal(matchQuestion("Phone", new Map())?.canonicalKey, "phone");
  assert.equal(matchQuestion("Phone Number*", new Map())?.canonicalKey, "phone");
  assert.equal(matchQuestion("Mobile Phone", new Map())?.canonicalKey, "phone");
});
