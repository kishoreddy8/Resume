import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverFields, type RawControl } from "../fieldDiscovery";
import { planFields } from "../planFields";
import type { AdapterContext } from "../types";
import type { StoredAnswer } from "../../resolveAnswer";
import type { QuestionType } from "../../questionTypes";

/**
 * PHASE 9E — GLOBAL_CANDIDATE answer reuse.
 *
 * FINDING THAT SHAPES THESE TESTS: the Answer Vault is ALREADY candidate-global. `getAnswer` keys
 * on (candidate_id, canonical_key) with no ATS, company, or job dimension, so an approved reusable
 * answer already crosses ATSs for its own candidate and never for anyone else's. RUN_ONLY likewise
 * already exists, as the checkpoint's `runAnswers`. These tests pin that behaviour — and, more
 * importantly, pin the guard that makes global reuse SAFE: a stored answer is only used when the
 * live control offers exactly one exact match for it.
 */

const NO_VARIANTS = new Map<string, { canonicalKey: string; type: QuestionType }>();

function ctx(): AdapterContext {
  return {
    candidateId: 1,
    contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
    resumePath: "/tmp/r.docx",
    coverLetterPath: "/tmp/c.docx",
  };
}
function control(o: Partial<RawControl>): RawControl {
  return { tag: "input", type: "text", id: null, name: null, ariaLabel: null, labelText: null, required: false, ...o };
}
const reusable = (v: string): StoredAnswer => ({
  answer_value: v, answer_source: "USER_INTERVENTION", approved_by_user: 1, auto_fill_allowed: 1,
});

function planOne(field: RawControl, stored: Map<string, StoredAnswer>, options?: string[]) {
  const fields = discoverFields([field]);
  if (options) fields[0].options = options;
  return planFields({ fields, context: ctx(), knownVariants: NO_VARIANTS, storedAnswers: stored })[0];
}

test("GLOBAL-ANSWER-01: a candidate-wide LinkedIn answer reuses regardless of which ATS is rendering the form", () => {
  const stored = new Map([["linkedin_url", reusable("linkedin.com/in/jordan")]]);
  /* The same stored answer, against two differently-shaped forms — the vault lookup has no ATS
   * dimension, so nothing about the ATS enters the decision. */
  for (const field of [
    control({ id: "linkedin", labelText: "LinkedIn Profile" }),
    control({ id: "urls--LinkedIn", labelText: "LinkedIn URL" }),
  ]) {
    const plan = planOne(field, stored);
    assert.equal(plan.action, "fill");
    assert.equal((plan as { value: string }).value, "linkedin.com/in/jordan");
  }
});

test("GLOBAL-ANSWER-02: a candidate-wide sponsorship answer reuses when canonical semantics match", () => {
  const stored = new Map([["sponsorship_required", reusable("No")]]);
  const plan = planOne(control({ id: "sp", labelText: "Will you now or in the future require sponsorship?*", required: true }), stored);
  assert.equal(plan.action, "fill");
  assert.equal((plan as { value: string }).value, "No");
});

test("GLOBAL-ANSWER-03/08: a global answer is NEVER forced when the current options cannot match it", () => {
  const stored = new Map([["referral_source", reusable("LinkedIn")]]);
  const plan = planOne(
    control({ tag: "select", type: null, id: "src", labelText: "How did you hear about us?*", required: true }),
    stored,
    ["Recruiter", "Employee Referral", "Career Fair", "Other"]
  );
  assert.equal(plan.action, "ask", "LinkedIn is not on offer — ask, never fall back to 'Other'");
  assert.doesNotMatch(JSON.stringify(plan), /"value":"Other"/);
});

test("GLOBAL-ANSWER-07: a reusable global answer DOES fill when it is one exact current option", () => {
  /* Uses a canonical key whose policy permits unattended reuse. The rule under test is the option
   * gate: same stored value, and the ONLY difference from GLOBAL-ANSWER-03 is whether the form
   * actually offers it. */
  const stored = new Map([["country_of_residence", reusable("United States")]]);
  const plan = planOne(
    control({ tag: "select", type: null, id: "country", labelText: "Country of residence*", required: true }),
    stored,
    ["United States", "Canada", "Mexico"]
  );
  assert.equal(plan.action, "fill");
  assert.equal((plan as { value: string }).value, "United States");
});

test("GLOBAL-ANSWER-07b: 'How Did You Hear About Us?' is ask-each-time BY DESIGN, not global by default", async () => {
  /* The addendum is explicit: this may become a candidate-wide default ONLY if the operator chooses
   * it, never by assumption. It is typed `other`, whose policy is `ask_each_time`, so even an
   * approved and auto-fill-flagged answer is offered as a suggestion rather than typed — the answer
   * legitimately varies by posting. Making it a true global default would require raising its
   * policy deliberately, which is a separate, explicit decision. */
  const { matchQuestion } = await import("../../questionMatching");
  const { DEFAULT_POLICY } = await import("../../questionTypes");
  const match = matchQuestion("How did you hear about us?*", new Map());
  assert.equal(match?.canonicalKey, "referral_source");
  assert.equal(DEFAULT_POLICY[match!.type].reusePolicy, "ask_each_time");

  const stored = new Map([["referral_source", reusable("LinkedIn")]]);
  const plan = planOne(
    control({ tag: "select", type: null, id: "src", labelText: "How did you hear about us?*", required: true }),
    stored,
    ["LinkedIn", "Indeed", "Employee Referral"]
  );
  assert.equal(plan.action, "ask", "offered to the user each time rather than silently reused");
});

test("GLOBAL-ANSWER-04: a RUN-scoped answer overrides the candidate-wide default for that run", () => {
  /* runAnswers is the narrowest existing scope and is consulted for the current run only; it never
   * writes back to the vault, so the global default survives untouched for the next application. */
  const stored = new Map([["desired_salary", reusable("$150,000")]]);
  const fields = discoverFields([control({ id: "salary", labelText: "Desired Salary", required: true })]);
  const plan = planFields({
    fields,
    context: ctx(),
    knownVariants: NO_VARIANTS,
    storedAnswers: stored,
    runAnswers: {
      salary: { questionId: "salary", selector: "#salary", label: "Desired Salary", answer: "$175,000", canonicalKey: "desired_salary", questionType: "salary" },
    },
  })[0];
  assert.equal(plan.action, "fill");
  assert.equal((plan as { value: string }).value, "$175,000", "the run-scoped answer wins for this run");
});

test("GLOBAL-ANSWER-06 / MULTIUSER: candidate A's global answer never resolves for candidate B", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-global-scope-"));
  process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
  process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
  const vault = await import("../../../../db/queries/applicationVault");
  const { createCandidate } = await import("../../../../db/queries/candidates");
  const other = createCandidate({ firstName: "Other", lastName: "Person" }).id;

  vault.recordQuestion({ canonicalKey: "linkedin_url", questionType: "contact", observedText: "LinkedIn Profile" });
  vault.saveAnswer({
    candidateId: 1, canonicalKey: "linkedin_url", questionType: "contact", observedText: "LinkedIn Profile",
    answerValue: "linkedin.com/in/jordan", answerSource: "USER_INTERVENTION", approvedByUser: true, autoFillAllowed: true,
  });

  assert.equal(vault.getAnswer(1, "linkedin_url")?.answer_value, "linkedin.com/in/jordan");
  assert.equal(vault.getAnswer(other, "linkedin_url"), undefined, "GLOBAL means global across ATSs for ONE candidate — never across candidates");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("GLOBAL-ANSWER-09: protected/never_auto policy overrides global reuse entirely", () => {
  /* Even approved AND marked auto-fillable, a voluntary demographic answer is only ever suggested. */
  const stored = new Map([["gender", reusable("Woman")]]);
  const plan = planOne(control({ id: "gender", labelText: "Gender" }), stored);
  assert.equal(plan.action, "ask", "never_auto beats any reuse scope");
});

test("GLOBAL-ANSWER-10: a free-text answer is not promoted to reusable without an explicit opt-in", async () => {
  /* saveAnswer's autoFillAllowed is supplied by the caller from the user's explicit checkbox AND
   * re-gated by policy; nothing in the fill path can flip it on. */
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "../../../../app/api/candidates/[candidateId]/application-runs/route.ts"),
    "utf8"
  );
  assert.match(
    source,
    /autoFillAllowed:\s*Boolean\(submitted\.reuseForEquivalentQuestions\)\s*&&\s*policy\.reusePolicy === "auto_after_approval"/,
    "reuse requires BOTH the user's explicit opt-in and a policy that permits it"
  );
});
