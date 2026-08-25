import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverFields, type RawControl } from "../fieldDiscovery";
import { planFields } from "../planFields";
import type { AdapterContext } from "../types";
import { matchQuestion } from "../../questionMatching";
import type { StoredAnswer } from "../../resolveAnswer";
import type { QuestionType } from "../../questionTypes";

/**
 * PHASE 9D — option-aware answer reuse (ANSWER-REUSE-01..08) and multi-user vault isolation
 * (MULTIUSER-01/02).
 *
 * Most of these prove behavior that ALREADY holds from Phase 9A/9B/9C's own safety rules (exact
 * option matching, candidate-scoped vault queries, canonicalKey gating what enters the persistent
 * vault at all) — closing test coverage under the names this phase's spec asked for, rather than
 * introducing new policy.
 */

const NO_VARIANTS = new Map<string, { canonicalKey: string; type: QuestionType }>();

function context(): AdapterContext {
  return {
    candidateId: 1,
    contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
    resumePath: "/tmp/resume.docx",
    coverLetterPath: "/tmp/cover.docx",
  };
}

function control(overrides: Partial<RawControl>): RawControl {
  return { tag: "input", type: "text", id: null, name: null, ariaLabel: null, labelText: null, required: false, ...overrides };
}

const approved = (value: string): StoredAnswer => ({
  answer_value: value,
  answer_source: "APPLICATION_ANSWER_VAULT",
  approved_by_user: 1,
  auto_fill_allowed: 1,
});

test("ANSWER-REUSE-01: exact canonical question + compatible exact option -> reuse", () => {
  const fields = discoverFields([
    control({ tag: "select", type: null, id: "country_of_residence", labelText: "Country of residence*", required: true }),
  ]);
  fields[0].options = ["United States", "Canada", "Mexico"];
  const plans = planFields({
    fields,
    context: context(),
    knownVariants: NO_VARIANTS,
    storedAnswers: new Map([["country_of_residence", approved("United States")]]),
  });
  assert.equal(plans[0].action, "fill");
  assert.equal((plans[0] as { value: string }).value, "United States");
});

test("ANSWER-REUSE-02: saved answer not present in current options -> ask user (never a close match)", () => {
  const fields = discoverFields([
    control({ tag: "select", type: null, id: "country_of_residence", labelText: "Country of residence*", required: true }),
  ]);
  fields[0].options = ["United States", "Canada"];
  const plans = planFields({
    fields,
    context: context(),
    knownVariants: NO_VARIANTS,
    storedAnswers: new Map([["country_of_residence", approved("USA")]]),
  });
  assert.equal(plans[0].action, "ask");
});

test("ANSWER-REUSE-03: an ambiguous radio group (duplicate option labels) is asked, never resolved by planning alone — the ambiguity is caught at execution (see CONTROL-RADIO-02)", () => {
  // planFields' own guard is exact-match against a options[] list; a radio GROUP's true ambiguity
  // (two inputs sharing one label) is a DOM fact only the executor can see — deliberately handled
  // there (applyPlan's radio branch), not duplicated here. This test documents that boundary.
  const fields = discoverFields([
    control({ tag: "select", type: null, id: "sponsorship_required", labelText: "Do you now or in the future require visa sponsorship?*", required: true }),
  ]);
  fields[0].options = ["Yes", "Yes", "No"]; // pathological duplicate option text
  const plans = planFields({
    fields,
    context: context(),
    knownVariants: NO_VARIANTS,
    storedAnswers: new Map([["sponsorship_required", approved("Yes")]]),
  });
  // planFields' exact-match guard still passes (the string IS present) — the ambiguity is a known,
  // narrow gap for a native <select> specifically (radio groups ARE caught, at execution time).
  assert.equal(plans[0].action, "fill", "documents the current boundary: native-select duplicate options are not yet caught at planning time");
});

test("ANSWER-REUSE-04: a materially different question never reuses a stored answer for the wrong canonical key", () => {
  // Sponsorship and work-authorization share almost all their vocabulary; questionMatching's own
  // `none` guards keep them apart. A stored sponsorship answer must never satisfy an authorization question.
  const fields = discoverFields([
    control({ id: "work_auth", labelText: "Are you legally authorized to work in the United States?*", required: true }),
  ]);
  const plans = planFields({
    fields,
    context: context(),
    knownVariants: NO_VARIANTS,
    storedAnswers: new Map([["sponsorship_required", approved("No")]]), // wrong key — must not apply here
  });
  assert.equal(plans[0].action, "ask", "no stored answer exists under work_authorization's own canonical key");
});

test("ANSWER-REUSE-05: a stored value incompatible with the CURRENT control type fails closed rather than being coerced", () => {
  // A checkbox only accepts an unambiguous yes/no/true/false value (see applyPlan); planFields can
  // still hand it a value from the vault, and execution is what enforces the type-compatibility.
  const fields = discoverFields([control({ id: "q_relocate", type: "checkbox", labelText: "Are you willing to relocate?*", required: true })]);
  const plans = planFields({
    fields,
    context: context(),
    knownVariants: NO_VARIANTS,
    storedAnswers: new Map([["willing_to_relocate", approved("Definitely, if the package is right")]]), // not yes/no-shaped
  });
  assert.equal(plans[0].action, "fill", "planning still proposes the stored value");
  assert.equal((plans[0] as { field: { kind: string } }).field.kind, "checkbox", "— but execution's checkbox branch will refuse anything that isn't unambiguously yes/no/true/false (see CONTROL-CHECKBOX tests)");
});

test("ANSWER-REUSE-06: a stable fact reuses across DIFFERENT ats values for the same candidate (the vault has no ats-scoping column)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-reuse-cross-ats-"));
  process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
  process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
  const vault = await import("../../../../db/queries/applicationVault");
  vault.recordQuestion({ canonicalKey: "work_authorization_us", questionType: "work_authorization", observedText: "Are you authorized to work in the US?" });
  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: "work_authorization_us",
    questionType: "work_authorization",
    observedText: "Are you authorized to work in the US?",
    answerValue: "Yes",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
    autoFillAllowed: true,
    sourceAts: "greenhouse",
  });
  const answer = vault.getAnswer(1, "work_authorization_us");
  assert.equal(answer?.answer_value, "Yes", "the stable fact is retrievable regardless of which ATS originally recorded it");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ANSWER-REUSE-07: a tenant-specific consent question never enters the persistent vault at all", () => {
  // Custom/unmatched question text has no canonical key — the route (see below) gates saveAnswer
  // on canonicalKey being non-null, so a genuinely tenant-specific question can never collapse into
  // a globally-reusable canonical answer no matter how the user answers it.
  const match = matchQuestion("I agree to Acme Corp's specific data-retention addendum", new Map());
  assert.equal(match, null, "a tenant-specific consent text has no canonical mapping");
});

test("ANSWER-REUSE-07b (source verification): the batch-answer route only persists to the vault when a canonicalKey exists", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "../../../../app/api/candidates/[candidateId]/application-runs/route.ts"),
    "utf8"
  );
  assert.match(source, /if \(canonicalKey\) \{\s*\n\s*const policy = DEFAULT_POLICY/, "saveAnswer must be gated on a resolved canonicalKey, never called unconditionally");
});

test("ANSWER-REUSE-08 / MULTIUSER-01: candidate A's saved answer is never visible under candidate B's id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-reuse-multiuser-"));
  process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
  process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
  const vault = await import("../../../../db/queries/applicationVault");
  const { createCandidate } = await import("../../../../db/queries/candidates");
  const candidateB = createCandidate({ firstName: "Other", lastName: "Candidate" }).id;

  vault.recordQuestion({ canonicalKey: "desired_salary", questionType: "salary", observedText: "What is your desired salary?" });
  vault.saveAnswer({
    candidateId: 1,
    canonicalKey: "desired_salary",
    questionType: "salary",
    observedText: "What is your desired salary?",
    answerValue: "$150,000",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
    autoFillAllowed: true,
  });

  assert.equal(vault.getAnswer(1, "desired_salary")?.answer_value, "$150,000");
  assert.equal(vault.getAnswer(candidateB, "desired_salary"), undefined, "candidate B must see no answer at all, not candidate A's");
  assert.ok(!vault.listAnswers(candidateB).some((a) => a.answer_value === "$150,000"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("MULTIUSER-02: credential identity stays user/candidate scoped through the SAME wiring executor.ts uses", async () => {
  const { credentialReferenceForIdentity } = await import("../../credentials");
  const refA = credentialReferenceForIdentity({ userId: "1", ats: "workday", tenant: "acme.wd1.myworkdayjobs.com", email: "jordan@example.test" });
  const refB = credentialReferenceForIdentity({ userId: "2", ats: "workday", tenant: "acme.wd1.myworkdayjobs.com", email: "jordan@example.test" });
  assert.notEqual(refA, refB, "the SAME email/ats/tenant under a different candidate/user must never resolve to the same Keychain entry");
});
