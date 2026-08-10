import assert from "node:assert/strict";
import { test } from "node:test";
import { clearNormalizeCache, normalizeEmployerName, normalizeEmployerNameCached } from "../normalizeEmployerName";

test("Google LLC, Google Inc., and GOOGLE all resolve to the same normalized identity", () => {
  const forms = ["Google LLC", "Google Inc.", "GOOGLE", "google", "  Google  "];
  const normalized = forms.map(normalizeEmployerName);
  assert.ok(normalized.every((n) => n === "GOOGLE"), JSON.stringify(normalized));
});

test("strips common legal-entity suffixes: Inc, LLC, Ltd, Corporation, Corp", () => {
  assert.equal(normalizeEmployerName("Acme Inc"), "ACME");
  assert.equal(normalizeEmployerName("Acme LLC"), "ACME");
  assert.equal(normalizeEmployerName("Acme Ltd"), "ACME");
  assert.equal(normalizeEmployerName("Acme Corporation"), "ACME");
  assert.equal(normalizeEmployerName("Acme Corp"), "ACME");
});

test("strips Technologies/Technology/Systems/Group/Holdings when trailing", () => {
  assert.equal(normalizeEmployerName("Acme Technologies"), "ACME");
  assert.equal(normalizeEmployerName("Acme Technology"), "ACME");
  assert.equal(normalizeEmployerName("Acme Systems"), "ACME");
  assert.equal(normalizeEmployerName("Acme Group"), "ACME");
  assert.equal(normalizeEmployerName("Acme Holdings"), "ACME");
});

test("strips compound trailing suffixes iteratively", () => {
  assert.equal(normalizeEmployerName("Acme Holdings Group LLC"), "ACME");
  assert.equal(normalizeEmployerName("Acme Systems Technologies Inc."), "ACME");
});

test("does NOT strip a suffix-like word that isn't trailing (avoids false-positive identity collisions)", () => {
  // "Group" is the first word here, not a trailing corporate suffix — a genuinely different
  // company from "Health Cooperative" and must not be collapsed into it.
  assert.equal(normalizeEmployerName("Group Health Cooperative"), "GROUP HEALTH COOPERATIVE");
  // "Systems" is a real, load-bearing middle word here.
  assert.equal(normalizeEmployerName("National Systems Analysis Corp"), "NATIONAL SYSTEMS ANALYSIS");
});

test("normalizes punctuation, capitalization, and whitespace", () => {
  assert.equal(normalizeEmployerName("Acme, Inc."), "ACME");
  assert.equal(normalizeEmployerName("O'Brien & Sons"), "OBRIEN SONS");
  assert.equal(normalizeEmployerName("   Acme    Widgets   "), "ACME WIDGETS");
});

test("never strips down to nothing — a single-token name equal to a suffix word is kept as-is", () => {
  assert.equal(normalizeEmployerName("Group"), "GROUP");
  assert.equal(normalizeEmployerName("Holdings"), "HOLDINGS");
});

test("KNOWN LIMITATION (deferred, see the approved pre-Phase-3 hardening plan §25): a legal suffix " +
  "with NO space before it fuses into the preceding token and is never stripped. Confirmed live in " +
  "h1b_sponsors on ~45/44,697 rows (e.g. 'Freyr,Inc.', 'Amazon.Com,Inc'). This test documents the " +
  "current behavior so it's visible rather than silently rediscovered — it is NOT the desired " +
  "behavior, and must be updated (not just flipped) if normalizeEmployerName is ever changed to fix " +
  "this, since that change requires a full H1B re-normalization + re-match migration (out of scope " +
  "for this hardening pass; the h1b_employer_aliases table is the safer near-term remediation for " +
  "specific affected employers as they're encountered).", () => {
  assert.equal(normalizeEmployerName("Freyr,Inc."), "FREYRINC", "suffix fused, not stripped — known gap");
  assert.equal(normalizeEmployerName("Amazon.Com,Inc"), "AMAZONCOMINC", "suffix fused, not stripped — known gap");
  // The space-separated form of the same name normalizes correctly and differently — proving these
  // two spellings of what may be the same real employer do NOT collapse to the same identity today.
  assert.equal(normalizeEmployerName("Freyr, Inc."), "FREYR");
});

test("normalizeEmployerNameCached returns the same result as the uncached function", () => {
  clearNormalizeCache();
  const inputs = ["Google LLC", "Acme Holdings Group LLC", "Group Health Cooperative"];
  for (const input of inputs) {
    assert.equal(normalizeEmployerNameCached(input), normalizeEmployerName(input));
    // Calling twice (cache hit path) must still return the identical value.
    assert.equal(normalizeEmployerNameCached(input), normalizeEmployerName(input));
  }
});
