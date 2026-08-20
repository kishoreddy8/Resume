import test from "node:test";
import assert from "node:assert/strict";
import { matchQuestion, normalizeQuestion } from "../questionMatching";
import { resolveAnswer, mayFill, type StoredAnswer } from "../resolveAnswer";
import { DEFAULT_POLICY } from "../questionTypes";

const NONE = new Map<string, { canonicalKey: string; type: never }>() as never;

test("VAULT-1 sponsorship and work authorization are never confused", () => {
  /* These share almost all their vocabulary and mean opposite things. Matching one as the other
   * puts a backwards answer into a real application, which is the worst failure this file has. */
  const sponsorship = [
    "Will you now or in the future require sponsorship for employment visa status?",
    "Do you require employment sponsorship?",
    "Will visa sponsorship be required?",
  ];
  for (const q of sponsorship) {
    assert.equal(matchQuestion(q, NONE)?.canonicalKey, "sponsorship_required", q);
  }

  const authorization = [
    "Are you legally authorized to work in the United States?",
    "Are you authorized to work in the US?",
  ];
  for (const q of authorization) {
    assert.equal(matchQuestion(q, NONE)?.canonicalKey, "work_authorization_us", q);
  }
});

test("VAULT-2 a combined question does not silently pick one side", () => {
  // "Authorized to work without sponsorship" contains BOTH vocabularies. Guessing is not allowed.
  const m = matchQuestion("Are you authorized to work in the US without sponsorship now or in the future?", NONE);
  assert.notEqual(m?.canonicalKey, "sponsorship_required", "must not answer the sponsorship question backwards");
});

test("VAULT-3 an unrecognised question returns null so the user is asked", () => {
  assert.equal(matchQuestion("What is your favourite deployment topology?", NONE), null);
  assert.equal(matchQuestion("   ", NONE), null);
});

test("VAULT-4 an exact previously-seen wording beats a pattern", () => {
  const known = new Map([["custom internal question", { canonicalKey: "custom_thing", type: "other" as const }]]);
  const m = matchQuestion("Custom internal question?", known);
  assert.equal(m?.canonicalKey, "custom_thing");
  assert.equal(m?.via, "exact_variant");
});

test("VAULT-5 normalization is textual only and never changes meaning", () => {
  assert.equal(normalizeQuestion("Desired Salary (Optional) *"), "desired salary");
  assert.equal(normalizeQuestion("  LinkedIn   Profile  "), "linkedin profile");
});

test("VAULT-6 demographic questions are protected and never auto-filled", () => {
  for (const q of ["What is your gender?", "Race / Ethnicity", "Are you a protected veteran?", "Disability status"]) {
    const m = matchQuestion(q, NONE);
    assert.equal(m?.type, "voluntary_demographic", q);
    assert.equal(DEFAULT_POLICY[m!.type].sensitivity, "protected");
    assert.equal(DEFAULT_POLICY[m!.type].reusePolicy, "never_auto");
  }
});

const approved = (over: Partial<StoredAnswer> = {}): StoredAnswer => ({
  answer_value: "Yes",
  answer_source: "APPLICATION_ANSWER_VAULT",
  approved_by_user: 1,
  auto_fill_allowed: 1,
  ...over,
});

test("VAULT-7 a protected question is never filled, even with a saved approved answer", () => {
  const r = resolveAnswer("voluntary_demographic", approved());
  assert.equal(r.action, "suggest", "an explicit saved response may be offered, never typed unattended");
});

test("VAULT-8 nothing stored means ask — never a derived or inferred value", () => {
  assert.equal(resolveAnswer("sponsorship", undefined).action, "ask");
  const protectedAsk = resolveAnswer("voluntary_demographic", undefined);
  assert.equal(protectedAsk.action, "ask");
  assert.match(protectedAsk.action === "ask" ? protectedAsk.reason : "", /never infers/i);
});

test("VAULT-9 approval alone does not authorise unattended filling", () => {
  const r = resolveAnswer("sponsorship", approved({ auto_fill_allowed: 0 }));
  assert.equal(r.action, "suggest", "approving a value is not consent to type it into every future form");
  assert.equal(resolveAnswer("sponsorship", approved()).action, "fill");
});

test("VAULT-10 an unapproved answer is only ever a suggestion", () => {
  const r = resolveAnswer("contact", approved({ approved_by_user: 0, auto_fill_allowed: 1 }));
  assert.equal(r.action, "suggest");
});

test("VAULT-11 salary and open-ended answers are confirmed every time", () => {
  for (const t of ["salary", "open_ended", "experience", "security_clearance"] as const) {
    assert.equal(resolveAnswer(t, approved()).action, "suggest", `${t} must not fill unattended`);
  }
});

test("VAULT-12 a field with unknown provenance is never filled", () => {
  assert.equal(mayFill(null), false);
  assert.equal(mayFill(undefined), false);
  assert.equal(mayFill("SOMETHING_ELSE" as never), false);
  assert.equal(mayFill("USER_INTERVENTION"), true);
  assert.equal(mayFill("APPROVED_CLAUDE_DRAFT"), true);
});
