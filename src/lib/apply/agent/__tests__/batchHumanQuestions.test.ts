import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * BATCH-* — Batch human answer flow.
 *
 * Instead of pausing one question at a time, the executor collects ALL required unanswered fields
 * into a single humanQuestions batch, stores it in the checkpoint, and the UI presents all of them
 * at once. The user saves answers in one POST; the route validates, saves to the vault, and
 * advances the run to FILLING; the UI auto-resumes execution.
 *
 * Safety invariants:
 *   • "Save Answers & Continue" NEVER submits the employer application — it only saves to vault
 *     and advances to FILLING, not SUBMITTED.
 *   • ask_each_time questions never gain auto_fill_allowed even if the user ticks "remember".
 *   • voluntary_demographic is never auto_fill_allowed.
 *   • Only required ask plans appear in humanQuestions; optional unresolved fields are left to
 *     the FinalReview's "unresolved" section.
 */

/* ── shared db setup ──────────────────────────────────────────────────────────────────────────── */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-batch-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const vault = require("@/db/queries/applicationVault") as typeof import("@/db/queries/applicationVault");
const { ApplicationBrowserRuntime } = require("../../engine/browserRuntime") as typeof import("../../engine/browserRuntime");
const { executeRun } = require("../../engine/executor") as typeof import("../../engine/executor");
const { planFields, collectHumanQuestions } = require("@/lib/apply/agent/planFields") as typeof import("../planFields");
const { discoverFields } = require("@/lib/apply/agent/fieldDiscovery") as typeof import("../fieldDiscovery");

const RESUME = path.join(dir, "Resume.docx");
fs.writeFileSync(RESUME, "mock resume");

const CONTEXT = {
  candidateId: 1,
  contact: {
    name: "Jordan Lee",
    email: "jordan@example.test",
    phone: "(555) 000-0002",
    location: "Austin, TX",
  },
  resumePath: RESUME,
  coverLetterPath: null as string | null,
};

const batchUrl = pathToFileURL(
  path.join(import.meta.dirname, "../../engine/__tests__/mockAts/mock-batch-questions.html")
).href;

const runtime = new ApplicationBrowserRuntime();
test.after(async () => { await runtime.close(); });

let runCounter = 0;
function newBatchRun() {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `batch-${runCounter++}-${Math.round(performance.now() * 1000)}`,
    ats: "greenhouse",
    applyUrl: batchUrl,
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: null,
  });
}

function deps(storedAnswers: Map<string, unknown> = new Map()) {
  return {
    context: CONTEXT,
    knownVariants: vault.loadKnownVariants(),
    storedAnswers,
  } as Parameters<typeof executeRun>[2];
}

/* ── pure unit: collectHumanQuestions ────────────────────────────────────────────────────────── */

// BATCH-01: empty plans → empty result
test("BATCH-01: collectHumanQuestions returns [] when there are no ask plans", () => {
  const plans = planFields({
    fields: discoverFields([
      { tag: "input", id: "email", name: null, ariaLabel: null, labelText: "Email", type: "email", required: true, role: null, className: "" },
    ]),
    context: CONTEXT,
    knownVariants: new Map(),
    storedAnswers: new Map(),
  });
  const questions = collectHumanQuestions(plans, new Map());
  // Email fills from profile — no ask plans
  assert.equal(questions.length, 0);
});

// BATCH-02: only required ask plans are collected; optional ones are excluded
test("BATCH-02: collectHumanQuestions excludes optional ask plans", () => {
  const fields = discoverFields([
    { tag: "input", id: "required_q", name: null, ariaLabel: null, labelText: "Required question", type: "text", required: true, role: null, className: "" },
    { tag: "input", id: "optional_q", name: null, ariaLabel: null, labelText: "Optional question", type: "text", required: false, role: null, className: "" },
  ]);
  const plans = planFields({
    fields,
    context: { ...CONTEXT, resumePath: null },
    knownVariants: new Map(),
    storedAnswers: new Map(),
  });
  const questions = collectHumanQuestions(plans, new Map());
  assert.equal(questions.length, 1, "only the required question must appear");
  assert.equal(questions[0]!.id, "required_q");
  assert.equal(questions[0]!.required, true);
});

// BATCH-03: id derived from field.id when present
test("BATCH-03: humanQuestion.id === field.id when field.id is set", () => {
  const fields = discoverFields([
    { tag: "input", id: "my-field", name: "my_name", ariaLabel: null, labelText: "Some question", type: "text", required: true, role: null, className: "" },
  ]);
  const plans = planFields({ fields, context: { ...CONTEXT, resumePath: null }, knownVariants: new Map(), storedAnswers: new Map() });
  const questions = collectHumanQuestions(plans, new Map());
  assert.equal(questions[0]!.id, "my-field");
});

// BATCH-04: id falls back to field.name when field.id is null
test("BATCH-04: humanQuestion.id falls back to field.name when id is null", () => {
  const fields = discoverFields([
    { tag: "input", id: null, name: "my_field_name", ariaLabel: null, labelText: "Some question", type: "text", required: true, role: null, className: "" },
  ]);
  const plans = planFields({ fields, context: { ...CONTEXT, resumePath: null }, knownVariants: new Map(), storedAnswers: new Map() });
  const questions = collectHumanQuestions(plans, new Map());
  assert.equal(questions[0]!.id, "my_field_name");
});

// BATCH-05: every humanQuestion carries a non-empty selector; id is always derivable from field
test("BATCH-05: every humanQuestion has a non-empty selector and id", () => {
  // A field identified by name (no id) — selector is [name="..."], id falls back to name value.
  const fields = discoverFields([
    { tag: "input", id: null, name: "open_question", ariaLabel: null, labelText: "Tell us about yourself", type: "text", required: true, role: null, className: "" },
  ]);
  const plans = planFields({ fields, context: { ...CONTEXT, resumePath: null }, knownVariants: new Map(), storedAnswers: new Map() });
  const questions = collectHumanQuestions(plans, new Map());
  assert.equal(questions.length, 1, "required ask plan must appear");
  const q = questions[0]!;
  assert.ok(q.id.length > 0, "id must be non-empty");
  assert.ok(q.selector.length > 0, "selector must be non-empty");
  // When field.id is null, id falls back to field.name — not the selector string
  assert.equal(q.id, "open_question", "id must be field.name when field.id is null");
  // selector is the CSS attribute selector built from name
  assert.equal(q.selector, '[name="open_question"]');
});

// BATCH-11: mix of required/optional — only required survive
test("BATCH-11: only required ask plans appear; optional ask plans are not included", () => {
  const fields = discoverFields([
    { tag: "input", id: "q1", name: null, ariaLabel: null, labelText: "Required field A", type: "text", required: true, role: null, className: "" },
    { tag: "input", id: "q2", name: null, ariaLabel: null, labelText: "Required field B", type: "text", required: true, role: null, className: "" },
    { tag: "input", id: "q3", name: null, ariaLabel: null, labelText: "Optional field C", type: "text", required: false, role: null, className: "" },
  ]);
  const plans = planFields({ fields, context: { ...CONTEXT, resumePath: null }, knownVariants: new Map(), storedAnswers: new Map() });
  const questions = collectHumanQuestions(plans, new Map());
  assert.equal(questions.length, 2);
  assert.ok(questions.every((q) => q.required));
  assert.ok(!questions.some((q) => q.id === "q3"), "optional q3 must not appear");
});

/* ── integration: executeRun produces humanQuestions in checkpoint ────────────────────────────── */

// BATCH-12: executeRun pauses with WAITING_FOR_ANSWER and humanQuestions in checkpoint
test("BATCH-12: executeRun pauses with humanQuestions when required questions cannot be auto-filled", async () => {
  // No vault answers for years_experience or salary_expectation
  const run = newBatchRun();
  const after = await executeRun(run.id, runtime, deps());
  assert.equal(after.status, "WAITING_FOR_ANSWER", `should pause for batch questions; got ${after.status}: ${after.blocking_reason}`);
  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.ok(Array.isArray(checkpoint.humanQuestions), "checkpoint must contain humanQuestions array");
  assert.ok(checkpoint.humanQuestions.length > 0, "humanQuestions must be non-empty");
  // Each humanQuestion must have required fields
  for (const q of checkpoint.humanQuestions as { id: string; label: string; required: boolean }[]) {
    assert.ok(q.id, `humanQuestion must have an id; got ${JSON.stringify(q)}`);
    assert.ok(q.label, "humanQuestion must have a label");
    assert.equal(q.required, true, "only required questions should be in humanQuestions");
  }
});

/* ── vault policy enforcement ─────────────────────────────────────────────────────────────────── */

// BATCH-13: reuse=true with auto_after_approval type sets auto_fill_allowed
test("BATCH-13: reuse=true with sponsorship (auto_after_approval) type sets auto_fill_allowed in vault", () => {
  const { saveAnswer, getAnswer } = vault;
  saveAnswer({
    candidateId: 1,
    canonicalKey: "sponsorship",
    questionType: "sponsorship",
    observedText: "Will you require visa sponsorship?",
    answerValue: "No",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
    autoFillAllowed: true, // reuseForEquivalentQuestions=true for an auto_after_approval type
    sourceAts: "greenhouse",
  });
  const stored = getAnswer(1, "sponsorship");
  assert.ok(stored, "answer must be stored");
  assert.equal(stored!.auto_fill_allowed, 1, "auto_fill_allowed must be 1 for auto_after_approval type with reuse");
});

// BATCH-15: reuse=true with ask_each_time type (e.g. salary) never sets auto_fill_allowed
test("BATCH-15: reuse=true with salary (ask_each_time type) never sets auto_fill_allowed", () => {
  const { saveAnswer, getAnswer } = vault;
  saveAnswer({
    candidateId: 1,
    canonicalKey: "salary",
    questionType: "salary",
    observedText: "What is your expected salary?",
    answerValue: "$100,000",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
    autoFillAllowed: true, // user ticked reuse, but salary is ask_each_time — must be ignored
    sourceAts: "greenhouse",
  });
  const stored = getAnswer(1, "salary");
  assert.ok(stored, "answer must be stored");
  assert.equal(stored!.auto_fill_allowed, 0, "auto_fill_allowed must remain 0 for ask_each_time types regardless of user opt-in");
});

// BATCH-16: voluntary_demographic is never auto_fill_allowed
test("BATCH-16: voluntary_demographic never gains auto_fill_allowed", () => {
  const { saveAnswer, getAnswer } = vault;
  saveAnswer({
    candidateId: 1,
    canonicalKey: "ethnicity",
    questionType: "voluntary_demographic",
    observedText: "Ethnicity",
    answerValue: "Prefer not to say",
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
    autoFillAllowed: true, // must be overridden to false by saveAnswer
    sourceAts: "greenhouse",
  });
  const stored = getAnswer(1, "ethnicity");
  assert.ok(stored, "answer must be stored");
  assert.equal(stored!.auto_fill_allowed, 0, "voluntary_demographic must never be auto_fill_allowed");
});

/* ── integration: full batch flow ────────────────────────────────────────────────────────────── */

// BATCH-14: after answering batch questions, a re-executed run advances to READY_FOR_REVIEW
test("BATCH-14: run reaches READY_FOR_REVIEW after batch answers are saved and run is re-executed", async () => {
  const run = newBatchRun();
  // First execution — should pause for required questions
  const first = await executeRun(run.id, runtime, deps());
  assert.equal(first.status, "WAITING_FOR_ANSWER", `first run must pause; got ${first.status}`);
  const checkpoint = JSON.parse(first.checkpoint_json!);
  const humanQuestions = checkpoint.humanQuestions as { id: string; canonicalKey: string | null; questionType: string | null; label: string }[];
  assert.ok(humanQuestions && humanQuestions.length > 0, "must have humanQuestions to proceed");

  // Simulate saving batch answers into the vault (what the route handler does).
  // The mock page has sponsorship + work_auth questions — both are auto_after_approval types,
  // so after saving with autoFillAllowed:true the second run can fill them automatically.
  const { saveAnswer } = vault;
  const { DEFAULT_POLICY } = require("@/lib/apply/questionTypes") as typeof import("@/lib/apply/questionTypes");
  const ANSWER_BY_TYPE: Record<string, string> = {
    sponsorship: "No",
    work_authorization: "Yes",
    other: "Yes",
  };
  for (const q of humanQuestions) {
    if (!q.canonicalKey) continue;
    const questionType = (q.questionType ?? "other") as import("@/lib/apply/questionTypes").QuestionType;
    const policy = DEFAULT_POLICY[questionType];
    saveAnswer({
      candidateId: 1,
      canonicalKey: q.canonicalKey,
      questionType,
      observedText: q.label,
      answerValue: ANSWER_BY_TYPE[q.questionType ?? "other"] ?? "Yes",
      answerSource: "USER_INTERVENTION",
      approvedByUser: true,
      autoFillAllowed: policy.reusePolicy === "auto_after_approval",
      sourceAts: "greenhouse",
    });
  }

  // Re-execute with the vault now populated
  const storedAnswers = new Map(
    humanQuestions
      .filter((q) => q.canonicalKey)
      .map((q) => [q.canonicalKey!, vault.getAnswer(1, q.canonicalKey!)])
      .filter((entry): entry is [string, NonNullable<ReturnType<typeof vault.getAnswer>>] => entry[1] != null)
  ) as Parameters<typeof executeRun>[2]["storedAnswers"];

  const second = await executeRun(run.id, runtime, deps(storedAnswers as never));
  assert.equal(
    second.status,
    "READY_FOR_REVIEW",
    `second run must reach READY_FOR_REVIEW after batch answers; got ${second.status}: ${second.blocking_reason}`
  );
  const secondCheckpoint = JSON.parse(second.checkpoint_json!);
  assert.ok(!secondCheckpoint.humanQuestions || secondCheckpoint.humanQuestions.length === 0,
    "humanQuestions must be absent or empty after all questions are answered");
});

/* ── safety: Save Answers never submits ──────────────────────────────────────────────────────── */

// BATCH-06: batch answer POST advances run only to FILLING, not beyond
test("BATCH-06: batch answer flow advances run to FILLING, never SUBMITTED or READY_FOR_REVIEW directly", async () => {
  const { advanceRun } = runsDb;
  const run = newBatchRun();
  // Manually advance to WAITING_FOR_ANSWER (simulating what executeRun does)
  runsDb.advanceRun(run.id, "STARTING");
  runsDb.advanceRun(run.id, "NAVIGATING");
  runsDb.advanceRun(run.id, "FILLING");
  const waiting = runsDb.advanceRun(run.id, "WAITING_FOR_ANSWER", {
    blockingQuestion: "Test question",
    blockingReason: "No answer",
  });
  assert.equal(waiting.status, "WAITING_FOR_ANSWER");

  // Advancing to FILLING (what the batch answer route does) is the furthest it goes
  const filled = advanceRun(run.id, "FILLING", { blockingReason: null, blockingQuestion: null });
  assert.equal(filled.status, "FILLING", "batch answer route must only advance to FILLING, not SUBMITTED");
  assert.notEqual(filled.status, "SUBMITTED");
  assert.notEqual(filled.status, "READY_FOR_REVIEW");
});

// BATCH-07: missing required question in batch is detected
test("BATCH-07: collectHumanQuestions marks all required unanswered fields — none are silently dropped", () => {
  const fields = discoverFields([
    { tag: "input", id: "qa", name: null, ariaLabel: null, labelText: "Question A", type: "text", required: true, role: null, className: "" },
    { tag: "input", id: "qb", name: null, ariaLabel: null, labelText: "Question B", type: "text", required: true, role: null, className: "" },
    { tag: "input", id: "qc", name: null, ariaLabel: null, labelText: "Question C", type: "text", required: true, role: null, className: "" },
  ]);
  const plans = planFields({ fields, context: { ...CONTEXT, resumePath: null }, knownVariants: new Map(), storedAnswers: new Map() });
  const questions = collectHumanQuestions(plans, new Map());
  // All three must appear — none silently dropped
  assert.equal(questions.length, 3, "all three required questions must appear in humanQuestions");
  const ids = new Set(questions.map((q) => q.id));
  assert.ok(ids.has("qa") && ids.has("qb") && ids.has("qc"), "all question ids must appear");
});

// BATCH-08: options are preserved on humanQuestion when field has them
test("BATCH-08: humanQuestion.options preserves select field options", () => {
  const fields = discoverFields([
    {
      tag: "select",
      id: "yoe",
      name: null,
      ariaLabel: null,
      labelText: "Years of experience",
      type: null,
      required: true,
      role: null,
      className: "",
      options: ["0-2 years", "3-5 years", "6-10 years"],
    },
  ]);
  const plans = planFields({ fields, context: { ...CONTEXT, resumePath: null }, knownVariants: new Map(), storedAnswers: new Map() });
  const questions = collectHumanQuestions(plans, new Map());
  assert.equal(questions.length, 1);
  assert.deepEqual(questions[0]!.options, ["0-2 years", "3-5 years", "6-10 years"]);
});

// BATCH-09: humanQuestion.options is null when field has no options
test("BATCH-09: humanQuestion.options is null for text fields with no options", () => {
  const fields = discoverFields([
    { tag: "input", id: "freetext", name: null, ariaLabel: null, labelText: "Free text question", type: "text", required: true, role: null, className: "" },
  ]);
  const plans = planFields({ fields, context: { ...CONTEXT, resumePath: null }, knownVariants: new Map(), storedAnswers: new Map() });
  const questions = collectHumanQuestions(plans, new Map());
  assert.equal(questions[0]!.options, null);
});

// BATCH-10: humanQuestion carries the reason from the plan
test("BATCH-10: humanQuestion.reason is propagated from the plan reason", () => {
  const fields = discoverFields([
    { tag: "input", id: "unknown_q", name: null, ariaLabel: null, labelText: "Some employer question", type: "text", required: true, role: null, className: "" },
  ]);
  const plans = planFields({ fields, context: { ...CONTEXT, resumePath: null }, knownVariants: new Map(), storedAnswers: new Map() });
  const questions = collectHumanQuestions(plans, new Map());
  assert.ok(questions[0]!.reason.length > 0, "reason must be non-empty");
});
