import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { groupSummaryLabel, groupTimelineEvents, type TimelineEvent } from "../eventLabels";
import { groupForStatus } from "../grouping";

/**
 * UI-A — Spatial Premium Applications + Human Question Center.
 *
 * Same convention as the rest of this suite (no jsdom/component-rendering harness exists in this
 * repo — see questionUiControls.test.ts): behavioral tests wherever a pure function exists to call
 * directly (grouping, timeline), source-verification against the real JSX where there is no
 * extractable pure function.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

const DETAIL = read("src/app/applications/[id]/ApplicationDetail.tsx");
const PAGE = read("src/app/applications/page.tsx");
const GROUPING = read("src/app/applications/grouping.ts");

// ── UIA-GROUP — the five frozen candidate groups ─────────────────────────────────────────────────

test("UIA-GROUP-01: every real run status maps into exactly one of the five frozen groups", () => {
  const ALL_STATUSES = [
    "QUEUED", "STARTING", "NAVIGATING", "ACCOUNT_REQUIRED", "FILLING", "WAITING_FOR_ANSWER",
    "WAITING_FOR_CAPTCHA", "WAITING_FOR_MFA", "WAITING_FOR_EMAIL_VERIFICATION", "READY_FOR_REVIEW",
    "WAITING_FOR_SUBMIT_APPROVAL", "SUBMITTING", "SUBMITTED", "SUBMISSION_UNCONFIRMED", "FAILED", "CANCELLED",
  ];
  const FROZEN = new Set(["needs-you", "in-progress", "ready-for-review", "submitted", "needs-attention"]);
  for (const status of ALL_STATUSES) {
    assert.ok(FROZEN.has(groupForStatus(status)), `${status} produced an unexpected group`);
  }
});

test("UIA-GROUP-02: the raw status value is never rendered as visible candidate-facing TEXT — only ever compared against, passed to a presentation function as a prop, or read through presentStatus/detailPhase", () => {
  // `run.status === "X"` and `status={run.status}` (a prop handed to a component that itself
  // presents it truthfully, e.g. ApplicationProgress) are both fine. `>{run.status}<` — the raw
  // value sitting directly as JSX TEXT CONTENT — is the actual leak this guards against. The one
  // legitimate exception is already inside the explicit Technical Details disclosure, covered
  // separately by failureRendering.test.ts's own disclosure-scoped assertions.
  const primarySource = DETAIL.slice(0, DETAIL.indexOf('<Disclosure title="Technical details">'));
  assert.doesNotMatch(primarySource, />\{run\.status\}/);
  assert.doesNotMatch(PAGE, />\{run\.status\}/);
  assert.doesNotMatch(GROUPING, /"Issues"|"Workflow"|"Execution"|"Adapter"|"Checkpoint"/);
});

test("UIA-GROUP-03: a parallel grouping model was not introduced — grouping.ts remains the sole authority the list and detail both import", () => {
  assert.match(PAGE, /from "\.\/grouping"/);
  assert.match(DETAIL, /from "\.\.\/grouping"/);
  assert.doesNotMatch(fs.readdirSync("src/app/applications").join(","), /grouping2|groupingV2/i);
});

// ── UIA-QUESTION — batch question form ───────────────────────────────────────────────────────────

test("UIA-QUESTION-04: required and optional groups both stay visible and editable — neither is ever conditionally hidden or collapsed away", () => {
  const formSource = DETAIL.slice(DETAIL.indexOf("function BatchQuestionForm"));
  // Both groups render from a real filter of the SAME humanQuestions array (never a second list),
  // and neither group's block is gated on anything but "does this group have any questions at all".
  assert.match(formSource, /requiredQuestions = humanQuestions\.filter\(\(q\) => q\.required\)/);
  assert.match(formSource, /optionalQuestions = humanQuestions\.filter\(\(q\) => !q\.required\)/);
  assert.match(formSource, /requiredQuestions\.length > 0/);
  assert.match(formSource, /optionalQuestions\.length > 0/);
  assert.doesNotMatch(formSource, /display:\s*none|\.collapse\(/i);
});

test("UIA-QUESTION-05: no internal selector or canonical key is ever rendered to the candidate", () => {
  const formSource = DETAIL.slice(DETAIL.indexOf("function QuestionField"), DETAIL.indexOf("function BatchQuestionForm"));
  assert.doesNotMatch(formSource, /\{q\.selector\}|\{q\.canonicalKey\}/);
});

test("UIA-QUESTION-06: password fields cannot reach the Human Question Center — verified at the engine's own discovery boundary", () => {
  // fieldDiscovery.ts is the ONE place DiscoveredField rows are produced from the real DOM; it
  // explicitly drops any input of type="password" before a HumanQuestion can ever be built from it.
  // This is read-only verification of an existing engine guarantee, not new UI-side filtering — the
  // guarantee already holds structurally, so no redundant client-side password check is added here.
  const discovery = read("src/lib/apply/agent/fieldDiscovery.ts");
  assert.match(discovery, /raw\.type === "password"/);
  assert.doesNotMatch(DETAIL, /type=["']password["']/);
});

test("UIA-QUESTION-07: voluntary/sensitive questions get distinct framing, never implying they are required", () => {
  const fieldSource = DETAIL.slice(DETAIL.indexOf("function QuestionField"), DETAIL.indexOf("function BatchQuestionForm"));
  assert.match(fieldSource, /voluntary_demographic/);
  assert.match(fieldSource, />Voluntary</);
});

// ── UIA-CONTINUE — save-then-resume, no false continuation ──────────────────────────────────────

test("UIA-CONTINUE-01: the continuation message is set only after BOTH the save and resume network calls genuinely succeed", () => {
  const onSaveSource = DETAIL.slice(DETAIL.indexOf("onSave={async () => {"), DETAIL.indexOf("justResumed ? ("));
  const setTrueIndex = onSaveSource.indexOf("setJustResumed(true)");
  const saveOkIndex = onSaveSource.indexOf("!saveRes.ok");
  const resumeOkIndex = onSaveSource.indexOf("!resumeRes.ok");
  assert.ok(setTrueIndex > saveOkIndex && setTrueIndex > resumeOkIndex, "setJustResumed(true) must occur after both ok-checks, never before");
});

test("UIA-CONTINUE-02: a failed save or resume never shows the continuation message — the function returns before setting it", () => {
  const onSaveSource = DETAIL.slice(DETAIL.indexOf("onSave={async () => {"), DETAIL.indexOf("justResumed ? ("));
  assert.match(onSaveSource, /if \(!saveRes\.ok\) \{[\s\S]*?return;\s*\}/);
  assert.match(onSaveSource, /if \(!resumeRes\.ok\) \{[\s\S]*?return;\s*\}/);
});

test("UIA-CONTINUE-03: no second answer-persistence path was created — batch save still uses the one existing application-runs endpoint", () => {
  const onSaveSource = DETAIL.slice(DETAIL.indexOf("onSave={async () => {"), DETAIL.indexOf("justResumed ? ("));
  assert.match(onSaveSource, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/application-runs`/);
  assert.match(onSaveSource, /fetch\(`\/api\/candidates\/\$\{candidateId\}\/application-runs\/start`/);
});

// ── UIA-POLL — existing polling helper reused, not duplicated ────────────────────────────────────

test("UIA-POLL-01: exactly one polling loop remains, still gated by the existing shouldPollRunStatus helper", () => {
  assert.equal((DETAIL.match(/setInterval\(/g) ?? []).length, 1);
  assert.match(DETAIL, /shouldPollRunStatus\(runStatus\)/);
});

// ── UIA-SUBMIT — final submit stays explicit, gated, and visually distinct ──────────────────────

test("UIA-SUBMIT-01: the submit control only renders inside FinalReview, itself gated on the real review/approval status", () => {
  assert.match(DETAIL, /reviewState = run\.status === "READY_FOR_REVIEW" \|\| run\.status === "WAITING_FOR_SUBMIT_APPROVAL"/);
  assert.match(DETAIL, /reviewState && review \? \(\s*\n\s*<FinalReview/);
});

test("UIA-SUBMIT-02: submit's own button label states the real consequence explicitly, and the control is visually distinct from the shared BTN_PRIMARY used everywhere else on this page", () => {
  const finalReviewSource = DETAIL.slice(DETAIL.indexOf("function FinalReview"), DETAIL.indexOf("const CONTROL_CLASS"));
  assert.match(finalReviewSource, /Submit application to \$\{company\}/);
  assert.match(finalReviewSource, /SUBMIT_BTN/);
  assert.doesNotMatch(finalReviewSource, /className=\{`\$\{BTN_PRIMARY\}/, "the submit button must not reuse the ordinary next-step button class");
});

test("UIA.1-SUBMIT-05: no second, stacked confirmation sits on top of the existing FinalReview approval boundary — a window.confirm here was tried and deliberately removed on checkpoint review", () => {
  const finalReviewSource = DETAIL.slice(DETAIL.indexOf("function FinalReview"), DETAIL.indexOf("const CONTROL_CLASS"));
  const rendered = finalReviewSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(rendered, /window\.confirm/, "the FinalReview screen and its explicitly-worded button are already the one confirmation boundary");
  assert.match(rendered, /onClick=\{onSubmit\}/, "the button must call onSubmit directly, with no intermediate dialog");
});

test("UIA-SUBMIT-03: submit_attempted is never rendered as a Submitted state, and SUBMISSION_UNCONFIRMED never reads as success", () => {
  assert.match(DETAIL, /run\.status === "SUBMISSION_UNCONFIRMED" \?/);
  const unconfirmedBlock = DETAIL.slice(DETAIL.indexOf('run.status === "SUBMISSION_UNCONFIRMED" ?'), DETAIL.indexOf('run.status === "FAILED"'));
  assert.doesNotMatch(unconfirmedBlock, />Submitted</);
});

test("UIA-SUBMIT-04: no automatic submit path exists — every fetch to application-runs/start with action \"submit\" originates from the one explicit, confirmed button click", () => {
  const submitCallSites = [...DETAIL.matchAll(/action: "submit"/g)];
  assert.equal(submitCallSites.length, 1, "exactly one place in this file constructs a submit action");
  assert.match(DETAIL, /onSubmit=\{\(\) => post\(\{ action: "submit", runId: run\.id, approvedRunId: run\.id \}, "submit"\)\}/);
});

// ── UIA-A11Y — sticky action position ────────────────────────────────────────────────────────────

test("UIA-A11Y-03: the mobile sticky Save Answers & Continue bar sits above MobileBottomNav using the established safe-area convention, and reserves scroll space for itself", () => {
  const formSource = DETAIL.slice(DETAIL.indexOf("function BatchQuestionForm"));
  assert.match(formSource, /bottom-\[calc\(56px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(formSource, /lg:hidden/);
  assert.match(formSource, /h-\[84px\] lg:hidden/, "a spacer must reserve room so the sticky bar never covers the last question");
});

// ── UIA-METRIC — no predictive metrics ───────────────────────────────────────────────────────────

test("UIA-METRIC-01: no interview/offer predictive language anywhere in the touched Applications files", () => {
  const banned = /interview\s*(rate|probability|likelihood|chance|score)|offer\s*(rate|probability|chance)|hiring\s*probability|predicted\s*(interview|offer|recruiter)/i;
  for (const source of [DETAIL, PAGE, GROUPING]) {
    assert.doesNotMatch(source, banned);
  }
});

// ── UIA-ENGINE — no application-engine involvement ──────────────────────────────────────────────

test("UIA-ENGINE-01: none of the touched Applications files import from the application-submission engine", () => {
  for (const [name, source] of [["ApplicationDetail.tsx", DETAIL], ["page.tsx", PAGE], ["grouping.ts", GROUPING]] as const) {
    assert.doesNotMatch(source, /from\s*["']@\/lib\/apply\/(agent|engine)/, `${name} must not import from the apply engine internals`);
  }
});

test("UIA-NAMING-01: no rendered JobHunt string remains in the touched Applications files", () => {
  assert.doesNotMatch(DETAIL, /JobHunt/);
  assert.doesNotMatch(GROUPING, /JobHunt/);
});

// ── UIA.1 checkpoint — save/resume partial-failure truthfulness ─────────────────────────────────

test("UIA.1-CONTINUE-04: a resume failure after a successful save states plainly that the answers were saved — never implying they were lost", () => {
  const onSaveSource = DETAIL.slice(DETAIL.indexOf("onSave={async () => {"), DETAIL.indexOf("justResumed ? ("));
  const resumeFailureBlock = onSaveSource.slice(onSaveSource.indexOf("if (!resumeRes.ok)"));
  assert.match(resumeFailureBlock, /Your answers were saved, but Career-Ops couldn't continue the application/);
  // The form must not be reloaded/cleared here — load() is only called on the success path below,
  // never inside this failure branch — so nothing the candidate typed appears to disappear.
  assert.doesNotMatch(resumeFailureBlock.slice(0, resumeFailureBlock.indexOf("return;")), /await load\(\)/);
});

// ── UIA.1 checkpoint — review count claims must never over-attribute to automation ──────────────

test("UIA.1-REVIEW-02: the review's answer/document count claim never says Career-Ops completed them automatically — some answers are candidate-supplied (AnswerSource includes USER_INTERVENTION / APPLICATION_ANSWER_VAULT)", () => {
  const finalReviewSource = DETAIL.slice(DETAIL.indexOf("function FinalReview"), DETAIL.indexOf("const CONTROL_CLASS"));
  const rendered = finalReviewSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(rendered, /completed.{0,40}automatically/i, "the count line must not claim full automation over a count that can include candidate-supplied answers");
  assert.match(rendered, /This review includes \{review\.answers\.length\}/);
  // Ground truth: buildFinalReview's own AnswerSource type is the reason this claim would be false.
  const answerSourceType = read("src/lib/apply/questionTypes.ts");
  assert.match(answerSourceType, /"USER_INTERVENTION"/);
  assert.match(answerSourceType, /"APPLICATION_ANSWER_VAULT"/);
});

// ── Timeline grouping — behavioral tests against the real pure function ─────────────────────────

function ev(id: number, type: string, detail: string | null = null): TimelineEvent {
  return { id, event_type: type, detail, created_at: new Date(2026, 0, 1, 0, 0, id).toISOString() };
}

test("UIA-TIMELINE-01: a short run of repetitive events (below the threshold) stays as individual rows", () => {
  const events = [ev(1, "run_created"), ev(2, "field_filled"), ev(3, "field_filled")];
  const items = groupTimelineEvents(events);
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.kind === "single"));
});

test("UIA-TIMELINE-02: a long run of the SAME repetitive type collapses into one group with the real, exact count — no event is lost", () => {
  const fills = Array.from({ length: 12 }, (_, i) => ev(i + 2, "field_filled"));
  const events = [ev(1, "run_created"), ...fills, ev(99, "page_advanced")];
  const items = groupTimelineEvents(events);
  assert.equal(items.length, 3);
  assert.equal(items[0]!.kind, "single");
  assert.equal(items[1]!.kind, "group");
  if (items[1]!.kind === "group") {
    assert.equal(items[1].events.length, 12, "every one of the 12 real events must still be present in the group");
    assert.equal(items[1].eventType, "field_filled");
  }
  assert.equal(items[2]!.kind, "single");
});

test("UIA-TIMELINE-03: a milestone event is never grouped, no matter how many repeat", () => {
  const submits = Array.from({ length: 5 }, (_, i) => ev(i + 1, "submit_attempted"));
  const items = groupTimelineEvents(submits);
  assert.equal(items.length, 5, "milestone events must never collapse, even if the same type repeats");
  assert.ok(items.every((i) => i.kind === "single"));
});

test("UIA-TIMELINE-04: two different collapsible types back-to-back never merge into one group", () => {
  const events = [
    ...Array.from({ length: 4 }, (_, i) => ev(i + 1, "field_filled")),
    ...Array.from({ length: 4 }, (_, i) => ev(i + 5, "document_uploaded")),
  ];
  const items = groupTimelineEvents(events);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.kind, "group");
  assert.equal(items[1]!.kind, "group");
  if (items[0]!.kind === "group" && items[1]!.kind === "group") {
    assert.equal(items[0].eventType, "field_filled");
    assert.equal(items[1].eventType, "document_uploaded");
  }
});

test("UIA-TIMELINE-05: the group summary sentence carries the real count, never a rounded or estimated figure", () => {
  assert.equal(groupSummaryLabel("field_filled", 12), "Filled in 12 fields");
  assert.equal(groupSummaryLabel("document_uploaded", 2), "Attached 2 documents");
  assert.equal(groupSummaryLabel("unknown_type", 7), "7 similar updates");
});
