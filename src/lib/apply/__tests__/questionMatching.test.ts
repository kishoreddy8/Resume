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
