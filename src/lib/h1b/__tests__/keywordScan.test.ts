import assert from "node:assert/strict";
import { test } from "node:test";
import { scanSponsorshipLanguage } from "../keywordScan";

test("negative: classic phrasings", () => {
  for (const text of [
    "Unfortunately we will not sponsor visas for this position.",
    "No visa sponsorship is available for this role.",
    "We are unable to sponsor candidates at this time.",
  ]) {
    const result = scanSponsorshipLanguage(text);
    assert.equal(result.mentioned, true, text);
    assert.equal(result.polarity, "negative", text);
    assert.ok(result.snippet, text);
  }
});

test("negative: \"No H1B\" (new pattern)", () => {
  const result = scanSponsorshipLanguage("No H1B candidates please, must be a citizen or green card holder.");
  assert.equal(result.polarity, "negative");
});

test("negative: \"must be authorized to work now and in the future\" (new pattern)", () => {
  const result = scanSponsorshipLanguage(
    "Candidates must be authorized to work in the United States now and in the future."
  );
  assert.equal(result.polarity, "negative");
});

test("negative: \"No visa support\" / \"immigration support\" (found via real-DOL-data verification)", () => {
  for (const text of [
    "No visa support is available for this position.",
    "No immigration support provided.",
    "We do not offer visa support of any kind.", // "do not", not just "does not" — see next test
    "We don't provide visa support for this role.",
  ]) {
    const result = scanSponsorshipLanguage(text);
    assert.equal(result.polarity, "negative", text);
  }
  // A bare, unrelated "support" must never false-trigger — the pattern is scoped to visa/immigration.
  assert.equal(scanSponsorshipLanguage("We offer excellent support to all new hires.").polarity, "none");
});

test("negative: \"do not\" and \"don't\" contractions are recognized, not just \"does not\"", () => {
  // Regression test: the original patterns only matched "does not offer sponsorship" — "We do not
  // offer sponsorship" (first-person plural, grammatically correct, and common in job postings)
  // silently fell through to "none" until this was caught by testing against real postings.
  for (const text of [
    "We do not offer sponsorship for this role.",
    "We don't offer sponsorship for this role.",
    "The company does not offer sponsorship for this position.",
  ]) {
    assert.equal(scanSponsorshipLanguage(text).polarity, "negative", text);
  }
});

test("positive: classic phrasings", () => {
  for (const text of [
    "Visa sponsorship is available for exceptional candidates.",
    "We will sponsor H1B visas for the right candidate.",
    "This role is open to sponsorship.",
  ]) {
    const result = scanSponsorshipLanguage(text);
    assert.equal(result.mentioned, true, text);
    assert.equal(result.polarity, "positive", text);
  }
});

test("positive: \"H1B transfers supported\" (new pattern)", () => {
  const result = scanSponsorshipLanguage("H1B transfers are supported for this role.");
  assert.equal(result.polarity, "positive");
});

test("no sponsorship language found -> none", () => {
  const result = scanSponsorshipLanguage(
    "We are looking for a Senior Data Engineer to join our growing analytics team."
  );
  assert.equal(result.mentioned, false);
  assert.equal(result.polarity, "none");
  assert.equal(result.snippet, null);
});

test("null/empty description text is handled safely", () => {
  assert.deepEqual(scanSponsorshipLanguage(null), { mentioned: false, polarity: "none", snippet: null });
  assert.deepEqual(scanSponsorshipLanguage(undefined), { mentioned: false, polarity: "none", snippet: null });
  assert.deepEqual(scanSponsorshipLanguage(""), { mentioned: false, polarity: "none", snippet: null });
});

test("negative wins when both negative and positive language appear in the same posting", () => {
  const result = scanSponsorshipLanguage(
    "We will not sponsor visas. In the past, this role has had sponsorship available for exceptional cases."
  );
  assert.equal(result.polarity, "negative");
});
