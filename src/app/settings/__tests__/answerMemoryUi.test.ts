import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { presentReusePolicy } from "../answers/reusePolicyPresentation";
import { DEFAULT_POLICY } from "@/lib/apply/questionTypes";

/**
 * UI-AM — Answer Memory.
 *
 * Same convention as the rest of this repo (no jsdom/component-rendering harness exists — see
 * questionUiControls.test.ts): behavioral tests against the real pure presentation function,
 * source-verification against the real route/page/settings files where there is no extractable
 * pure function.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const ROUTE = read("src/app/api/candidates/[candidateId]/answer-memory/route.ts");
const PAGE = read("src/app/settings/answers/page.tsx");
const SETTINGS_PAGE = read("src/app/settings/page.tsx");
const VAULT = read("src/db/queries/applicationVault.ts");

// ── UIAM-ARCH — one canonical answer-memory authority ────────────────────────────────────────────

test("UIAM-ARCH-01: the new route reads and writes through the existing vault functions only — no parallel store", () => {
  assert.match(ROUTE, /from "@\/db\/queries\/applicationVault"/);
  assert.match(ROUTE, /listAnswersForCandidate\(candidateId\)/);
  assert.match(ROUTE, /editAnswer\(candidateId, parsed\.data\.id/);
  assert.doesNotMatch(ROUTE, /INSERT INTO|UPDATE application_answers|DELETE FROM/i, "the route must never touch SQL directly — only through applicationVault.ts");
});

test("UIAM-ARCH-02: editAnswer is built on saveAnswer — the exact same write path the Question Center batch/single-answer routes already use", () => {
  const editSource = VAULT.slice(VAULT.indexOf("export function editAnswer"));
  assert.match(editSource, /return saveAnswer\(\{/);
  assert.doesNotMatch(editSource, /INSERT INTO application_answers|UPDATE application_answers/, "editAnswer must delegate to saveAnswer, never write application_answers directly itself");
});

// ── UIAM-POLICY — truthful, non-fabricated reuse semantics ───────────────────────────────────────

test("UIAM-POLICY-01: the raw reuse-policy enum value is never rendered as candidate-facing text", () => {
  const banned = /auto_after_approval|ask_each_time|never_auto/;
  assert.doesNotMatch(PAGE, banned);
});

test("UIAM-POLICY-02: each candidate label accurately maps to the real backend semantics, and only auto_after_approval is ever editable", () => {
  const auto = presentReusePolicy("auto_after_approval", true);
  assert.equal(auto.editable, true);
  assert.match(auto.label, /automatically/i);

  const askFirst = presentReusePolicy("auto_after_approval", false);
  assert.equal(askFirst.editable, true);
  assert.match(askFirst.label, /ask/i);

  const askEachTime = presentReusePolicy("ask_each_time", false);
  assert.equal(askEachTime.editable, false, "ask_each_time has no candidate-controllable toggle — the type's own policy always decides");

  const neverAuto = presentReusePolicy("never_auto", false);
  assert.equal(neverAuto.editable, false, "never_auto (voluntary/demographic) must never offer a toggle that implies control that does not exist");
});

test("UIAM-POLICY-04: the API route shows the LIVE DEFAULT_POLICY value, not the stored reuse_policy column, because that is what actually governs fill-time behavior", () => {
  // Checkpoint finding: the stored `application_questions.reuse_policy` column is written once by
  // recordQuestion() and never read again by anything real — resolveAnswer.ts and retryContext.ts
  // both re-derive the policy fresh from DEFAULT_POLICY[questionType] every time. Showing the
  // stored column instead would be truthful about the database but false about what will actually
  // happen the next time this question appears — a subtle, easy mistake worth pinning permanently.
  assert.match(ROUTE, /DEFAULT_POLICY\[row\.question_type\]\?\.reusePolicy \?\? row\.reuse_policy/);
  const resolveAnswer = read("src/lib/apply/resolveAnswer.ts");
  const retryContext = read("src/lib/apply/retryContext.ts");
  assert.match(resolveAnswer, /const policy = DEFAULT_POLICY\[questionType\]/, "ground truth: resolveAnswer never reads a stored reuse_policy column");
  assert.match(retryContext, /const policy = DEFAULT_POLICY\[/, "ground truth: retryContext never reads a stored reuse_policy column either");
});

test("UIAM-POLICY-03: no fabricated per-answer scope (company-only / job-only) is ever rendered — the engine has no such concept", () => {
  const banned = /use everywhere|this company only|this job only/i;
  assert.doesNotMatch(stripComments(PAGE), banned);
  // Ground truth: saveAnswer/resolveAnswer take no company or job parameter at all.
  assert.doesNotMatch(VAULT, /companyId|jobId/i);
});

// ── UIAM-QUESTION — Question Center reuse checkbox reflects the real policy ──────────────────────

test("UIAM-QUESTION-01: the Question Center's reuse checkbox is only offered for question types whose real policy is auto_after_approval", () => {
  const detail = read("src/app/applications/[id]/ApplicationDetail.tsx");
  assert.match(detail, /canOfferAutomaticReuse\(q\.questionType\)/);
  const helperSource = detail.slice(detail.indexOf("function canOfferAutomaticReuse"), detail.indexOf("function canOfferAutomaticReuse") + 400);
  assert.match(helperSource, /DEFAULT_POLICY\[questionType as QuestionType\]\?\.reusePolicy === "auto_after_approval"/);
  // Cross-check against the real policy table itself, not just the pattern.
  const autoTypes = Object.entries(DEFAULT_POLICY).filter(([, p]) => p.reusePolicy === "auto_after_approval").map(([t]) => t);
  const nonAutoTypes = Object.entries(DEFAULT_POLICY).filter(([, p]) => p.reusePolicy !== "auto_after_approval").map(([t]) => t);
  assert.ok(autoTypes.includes("contact"));
  assert.ok(nonAutoTypes.includes("salary"));
  assert.ok(nonAutoTypes.includes("voluntary_demographic"));
});

test("UIAM.1-QUESTION-03: the legacy single-question fallback path never offers a reuse/automatic-fill control it cannot truthfully evaluate", () => {
  // Checkpoint finding: this path (run.status === "WAITING_FOR_ANSWER" && run.question, reached when
  // a live control mismatch is discovered only at fill time — see executor.ts's fillFromPlans) has
  // no questionType anywhere in its API payload (RunDetail.question is a plain string), so
  // canOfferAutomaticReuse cannot be evaluated for it the way the batch path's QuestionField can.
  // The same "checkbox with no real effect for most question types" bug the batch path already had
  // fixed existed here too, ungated — removed rather than left promising an unverifiable effect.
  const detail = read("src/app/applications/[id]/ApplicationDetail.tsx");
  const legacyBlock = detail.slice(detail.indexOf('run.status === "WAITING_FOR_ANSWER" && run.question ?'), detail.indexOf('verificationState ?'));
  assert.doesNotMatch(legacyBlock, /Reuse this answer|reuseForEquivalentQuestions/i);
  assert.doesNotMatch(legacyBlock, /type="checkbox"/);
});

// ── UIAM-SENSITIVE / UIAM-SECRET — protected data boundaries preserved ───────────────────────────

test("UIAM-SENSITIVE-01: voluntary/demographic answers are never presented as auto-fillable, and the existing exclusion from the Question Center's reuse checkbox is preserved", () => {
  const p = presentReusePolicy("never_auto", true /* even if somehow true, must not be presented as automatic */);
  assert.equal(p.editable, false);
  assert.doesNotMatch(p.label, /automatic/i);
});

test("UIAM-SECRET-01: no password/secret field can ever reach Answer Memory — verified at the engine's own discovery boundary, not re-implemented in the UI", () => {
  const discovery = read("src/lib/apply/agent/fieldDiscovery.ts");
  assert.match(discovery, /raw\.type === "password"/);
  assert.doesNotMatch(PAGE, /type=["']password["']/);
  assert.doesNotMatch(ROUTE, /password/i);
});

// ── UIAM-EDIT / UIAM-FORGET ───────────────────────────────────────────────────────────────────────

test("UIAM-EDIT-UI-01: the edit control writes through the real PATCH endpoint, never a client-only optimistic write", () => {
  assert.match(PAGE, /method: "PATCH"/);
  assert.match(PAGE, /\/api\/candidates\/\$\{candidateId\}\/answer-memory/);
});

test("UIAM-FORGET-01: no forget/delete action is offered — no delete API exists in the vault yet, and none was fabricated here", () => {
  assert.doesNotMatch(PAGE, /Forget|Delete|Remove/i);
  assert.doesNotMatch(ROUTE, /export async function DELETE/);
  assert.doesNotMatch(VAULT, /export function (delete|forget|remove)Answer/i);
});

// ── UIAM-EMPTY — no unsupported claim ─────────────────────────────────────────────────────────────

test("UIAM-EMPTY-01: the empty state makes no claim beyond what the product actually does", () => {
  const emptyBlock = PAGE.slice(PAGE.indexOf("answers.length === 0"), PAGE.indexOf("answers.length === 0") + 400);
  assert.doesNotMatch(emptyBlock, /AI|automatically generates|instantly/i);
});

// ── UIAM-A11Y ────────────────────────────────────────────────────────────────────────────────────

test("UIAM-A11Y-01: interactive controls (Edit, Save, Cancel, the auto-fill checkbox) all have real accessible names", () => {
  assert.match(PAGE, />\s*Edit\s*</);
  assert.match(PAGE, /Use this answer automatically next time/);
  assert.doesNotMatch(PAGE, /<button[^>]*>\s*<\/button>/, "no icon-only unlabelled button");
});

test("UIAM-A11Y-02: interactive controls meet the 44px (min-h-11) mobile target contract", () => {
  // Checked directly rather than via a generic tag-matching regex: a naive `[^>]*>` stops at the
  // first literal `>`, which an arrow function like `onChange={(e) => ...}` inside the same JSX
  // element contains — cutting the match off mid-element and producing false negatives.
  assert.match(PAGE, /Edit\s*\n\s*<\/button>/);
  assert.match(PAGE, /className={`\$\{BTN_QUIET\} min-h-11`}/);
  assert.match(PAGE, /className={`\$\{BTN_PRIMARY\} min-h-11 text-\[13\.5px\]`}/);
  assert.match(PAGE, /className={`\$\{BTN_SECONDARY\} min-h-11 text-\[13\.5px\]`}/);
  assert.match(PAGE, /type="checkbox"[\s\S]{0,120}className="h-5 w-5/);
  assert.match(SETTINGS_PAGE, /href="\/settings\/answers" className={`\$\{BTN_SECONDARY\} min-h-11/);
});

// ── UIAM-MOBILE — no new bottom-nav tab ──────────────────────────────────────────────────────────

test("UIAM-MOBILE-01: no Answer Memory tab was added to MobileBottomNav", () => {
  const nav = read("src/components/MobileBottomNav.tsx");
  assert.doesNotMatch(nav, /Answer Memory|Saved Answers/i);
});

// ── UIAM-ENGINE / UIAM-DB — boundaries respected ─────────────────────────────────────────────────

test("UIAM-ENGINE-01: none of the new/touched files import from the application-submission engine internals", () => {
  for (const [name, source] of [["route.ts", ROUTE], ["answers/page.tsx", PAGE], ["applicationVault.ts", VAULT]] as const) {
    assert.doesNotMatch(source, /from\s*["']@\/lib\/apply\/(agent|engine)/, `${name} must not import apply engine internals`);
  }
});

test("UIAM-DB-01: no schema/migration change — the new query functions read/write the SAME existing tables", () => {
  assert.doesNotMatch(VAULT, /CREATE TABLE|ALTER TABLE|DROP TABLE/);
});

// ── Settings integration ────────────────────────────────────────────────────────────────────────

test("the settings Applications panel always links to Answer Memory (even at zero saved answers, per the UI-AM.1 discoverability decision), using a working (not merely decorative) query parameter", () => {
  assert.match(SETTINGS_PAGE, /href="\/settings\/answers"/);
  assert.match(SETTINGS_PAGE, /isSettingsCategory\(requested\)/, "the ?category= deep link must actually be read, not just written by a link that goes nowhere");
  // The link renders whenever savedAnswers is a real number (including 0) — only the `null`
  // ("not yet loaded" / "not available") case has no link at all. `savedAnswers === 0` may still
  // switch the TEXT ("No reusable answers saved yet." vs "N answers saved."), but must not gate
  // the <Link> itself into a second, link-less branch.
  const fieldBlock = SETTINGS_PAGE.slice(SETTINGS_PAGE.indexOf('label="Saved application answers"'), SETTINGS_PAGE.indexOf('</Field>', SETTINGS_PAGE.indexOf('label="Saved application answers"')));
  assert.match(fieldBlock, /savedAnswers === null \? \(/);
  assert.equal((fieldBlock.match(/<Link href="\/settings\/answers"/g) ?? []).length, 1, "exactly one Link, reached regardless of whether savedAnswers is 0 or a positive count");
});

test("no rendered JobHunt string remains in the touched settings files", () => {
  assert.doesNotMatch(SETTINGS_PAGE, /JobHunt/);
  assert.doesNotMatch(read("src/app/settings/categories.ts"), /JobHunt/);
});
