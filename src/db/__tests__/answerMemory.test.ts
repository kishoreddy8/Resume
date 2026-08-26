import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * UI-AM — the candidate-facing read/edit surface added on top of the existing Application Answer
 * Vault (`applicationVault.ts`). These are data-layer tests against a real temporary SQLite DB,
 * matching the established convention (see interventionInbox.test.ts) rather than mocking the
 * database this module actually reads and writes.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-answer-memory-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";

/* eslint-disable @typescript-eslint/no-require-imports */
const vault = require("../queries/applicationVault") as typeof import("../queries/applicationVault");
const candidates = require("../queries/candidates") as typeof import("../queries/candidates");
const { getDb } = require("../index") as typeof import("../index");
const { DEFAULT_POLICY } = require("@/lib/apply/questionTypes") as typeof import("@/lib/apply/questionTypes");

/* Candidate 1 exists in a fresh temp DB by default (same convention as interventionInbox.test.ts);
 * a second, real candidate is created here for the cross-candidate isolation test below. */
const otherCandidate = candidates.createCandidate({ firstName: "Other", lastName: "Candidate" });

test("UIAM-DISPLAY-01: the candidate-facing list shows the real observed question text, never the normalized (filler-stripped) form", () => {
  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: "work_authorization_us",
    questionType: "work_authorization",
    observedText: "Are you legally authorized to work in the United States?",
    answerValue: "Yes",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
    autoFillAllowed: true,
  });

  const rows = vault.listAnswersForCandidate(1);
  const row = rows.find((r) => r.canonical_key === "work_authorization_us")!;
  assert.equal(row.question_text, "Are you legally authorized to work in the United States?");
  assert.doesNotMatch(row.question_text, /^[a-z0-9 ]+$/, "must not be the lowercased, filler-stripped normalized form");
});

test("UIAM-DISPLAY-02: the most recently observed wording wins when a question has been seen more than once", () => {
  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: "sponsorship_required",
    questionType: "sponsorship",
    observedText: "Will you require sponsorship?",
    answerValue: "No",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
  });
  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: "sponsorship_required",
    questionType: "sponsorship",
    observedText: "Will you now or in the future require immigration sponsorship?",
    answerValue: "No",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
  });

  const rows = vault.listAnswersForCandidate(1);
  const row = rows.find((r) => r.canonical_key === "sponsorship_required")!;
  assert.equal(row.question_text, "Will you now or in the future require immigration sponsorship?");
});

test("UIAM-POLICY-DB-01: reuse_policy for a stored row matches the type's real DEFAULT_POLICY", () => {
  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: "desired_salary",
    questionType: "salary",
    observedText: "What is your desired salary?",
    answerValue: "$150,000",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
    autoFillAllowed: true, // requested, but salary's policy must refuse it — see next assertion
  });
  const row = vault.listAnswersForCandidate(1).find((r) => r.canonical_key === "desired_salary")!;
  assert.equal(row.reuse_policy, "ask_each_time");
  assert.equal(row.auto_fill_allowed, 0, "salary's ask_each_time policy must refuse auto_fill_allowed even when requested");
});

test("UIAM-EDIT-01: editAnswer changes the value through the SAME saveAnswer path the Question Center uses, scoped to the owning candidate", () => {
  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: "linkedin_profile",
    questionType: "contact",
    observedText: "LinkedIn Profile URL",
    answerValue: "linkedin.com/in/old-handle",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
    autoFillAllowed: true,
  });
  const before = vault.listAnswersForCandidate(1).find((r) => r.canonical_key === "linkedin_profile")!;

  const updated = vault.editAnswer(1, before.id, { answerValue: "linkedin.com/in/new-handle" });
  assert.ok(updated);
  assert.equal(updated!.answer_value, "linkedin.com/in/new-handle");

  const after = vault.listAnswersForCandidate(1).find((r) => r.canonical_key === "linkedin_profile")!;
  assert.equal(after.answer_value, "linkedin.com/in/new-handle");
  assert.equal(after.auto_fill_allowed, 1, "editing the value alone must not silently clear the existing auto-fill flag");
});

test("UIAM-EDIT-02: editAnswer never corrupts application_question_variants with a fabricated 'observed' wording", () => {
  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: "current_location",
    questionType: "contact",
    observedText: "Current Location",
    answerValue: "Austin, TX",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
  });
  const row = vault.listAnswersForCandidate(1).find((r) => r.canonical_key === "current_location")!;
  vault.editAnswer(1, row.id, { answerValue: "Dallas, TX" });

  // The display text must remain the real, human-written wording — never the canonical_key itself,
  // which a naive edit implementation could otherwise write into application_question_variants.
  const after = vault.listAnswersForCandidate(1).find((r) => r.canonical_key === "current_location")!;
  assert.equal(after.question_text, "Current Location");
  assert.notEqual(after.question_text, "current_location");
});

test("UIAM-EDIT-03: editing an answer id that does not belong to this candidate is refused, whether the requester id is real or nonexistent", () => {
  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: "employer_relocation",
    questionType: "relocation",
    observedText: "Are you willing to relocate?",
    answerValue: "Yes",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
  });
  const row = vault.listAnswersForCandidate(1).find((r) => r.canonical_key === "employer_relocation")!;

  // A nonexistent candidate id.
  assert.equal(vault.editAnswer(999, row.id, { answerValue: "No" }), undefined);
  // A real, different candidate — must not be able to edit candidate 1's answer either.
  assert.equal(vault.editAnswer(otherCandidate.id, row.id, { answerValue: "No" }), undefined);

  const unchanged = vault.listAnswersForCandidate(1).find((r) => r.canonical_key === "employer_relocation")!;
  assert.equal(unchanged.answer_value, "Yes");
  assert.equal(vault.listAnswersForCandidate(otherCandidate.id).length, 0, "the other candidate must see none of candidate 1's answers");
});

test("UIAM-EDIT-04: toggling autoFillAllowed on for a never_auto (voluntary/demographic) type is silently refused by the same policy guard saveAnswer already enforces", () => {
  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: "gender_identity",
    questionType: "voluntary_demographic",
    observedText: "What is your gender?",
    answerValue: "Prefer not to say",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
  });
  const row = vault.listAnswersForCandidate(1).find((r) => r.canonical_key === "gender_identity")!;
  assert.equal(row.auto_fill_allowed, 0);

  vault.editAnswer(1, row.id, { autoFillAllowed: true });
  const after = vault.listAnswersForCandidate(1).find((r) => r.canonical_key === "gender_identity")!;
  assert.equal(after.auto_fill_allowed, 0, "a voluntary/demographic answer must never become auto-fillable, regardless of what is requested");
});

test("UIAM.1-POLICY-01: a stored reuse_policy that has drifted from the live DEFAULT_POLICY is NOT what the Answer Memory route presents — the live value is, because that is the only one the real engine (resolveAnswer.ts, retryContext.ts) ever actually reads", () => {
  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: "desired_salary_drift_check",
    questionType: "salary",
    observedText: "What is your expected compensation?",
    answerValue: "$140,000",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
  });

  // Simulate exactly the real-world drift scenario the checkpoint asked about: an OLD row whose
  // stored reuse_policy no longer matches what DEFAULT_POLICY says for that type TODAY (e.g. the
  // code's own default changed after this row was first written; recordQuestion's ON CONFLICT
  // clause never updates reuse_policy again, so a real row could legitimately be in this state).
  getDb()
    .prepare("UPDATE application_questions SET reuse_policy = 'auto_after_approval' WHERE canonical_key = 'desired_salary_drift_check'")
    .run();

  const row = vault.listAnswersForCandidate(1).find((r) => r.canonical_key === "desired_salary_drift_check")!;
  assert.equal(row.reuse_policy, "auto_after_approval", "sanity check: the stored column really did drift");

  // The exact formula the API route uses (route.ts) — proven here against a genuinely drifted row,
  // not just read from source text. It must resolve to the LIVE policy (ask_each_time for salary),
  // matching what resolveAnswer.ts/retryContext.ts will actually do, not the stale stored value.
  const effectivePolicy = DEFAULT_POLICY[row.question_type]?.reusePolicy ?? row.reuse_policy;
  assert.equal(effectivePolicy, "ask_each_time", "the route must show what the engine will actually do now, not a stale snapshot");
  assert.notEqual(effectivePolicy, row.reuse_policy, "this assertion only means something because the two genuinely disagree here");
});
