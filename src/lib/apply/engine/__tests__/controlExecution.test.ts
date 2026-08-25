import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockAtsUrl } from "./mockAts/paths";
import { discoverFields, type RawControl } from "@/lib/apply/agent/fieldDiscovery";
import { planFields } from "@/lib/apply/agent/planFields";
import type { StoredAnswer } from "@/lib/apply/resolveAnswer";
import type { QuestionType } from "@/lib/apply/questionTypes";

/**
 * PHASE 9B — form-control support: checkboxes, radio groups, native selects, dates.
 *
 * The rules under test are the FORM CONTROL SUPPORT contract: never toggle blindly, map to a
 * normalized question first, authoritative/saved answers only, exact option matching, no
 * first-option defaults, sensitive questions never inferred. Local mock pages only.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-controls-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const vault = require("@/db/queries/applicationVault") as typeof import("@/db/queries/applicationVault");
const { ApplicationBrowserRuntime } = require("../browserRuntime") as typeof import("../browserRuntime");
const { executeRun } = require("../executor") as typeof import("../executor");

const CONTEXT = {
  candidateId: 1,
  contact: {
    name: "Jordan Rivera",
    email: "jordan@example.test",
    phone: "(214) 555-0100",
    location: "Dallas, TX",
  },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: path.join(dir, "CoverLetter.docx"),
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");
fs.writeFileSync(CONTEXT.coverLetterPath, "mock cover letter");

const runtime = new ApplicationBrowserRuntime();

const approved = (value: string): StoredAnswer => ({
  answer_value: value,
  answer_source: "APPLICATION_ANSWER_VAULT",
  approved_by_user: 1,
  auto_fill_allowed: 1,
});

function deps(storedAnswers: Map<string, StoredAnswer>) {
  return {
    context: CONTEXT,
    knownVariants: vault.loadKnownVariants(),
    storedAnswers,
  } as Parameters<typeof executeRun>[2];
}

function newRun(url: string) {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `mock-controls-${Math.round(performance.now() * 1000)}`,
    ats: "greenhouse",
    applyUrl: url,
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: CONTEXT.coverLetterPath,
  });
}

test.after(async () => {
  await runtime.close();
});

// ── browser: the mock-controls page ─────────────────────────────────────────────────────────────

test("CONTROL-CHECKBOX-01 / CONTROL-RADIO-01 / CONTROL-DROPDOWN-01 / CONTROL-CHECKBOX-02: saved answers fill, sensitive checkbox pauses untouched", async () => {
  const stored = new Map<string, StoredAnswer>([
    ["willing_to_relocate", approved("Yes")],
    ["sponsorship_required", approved("No")],
    ["country_of_residence", approved("United States")],
  ]);
  const run = newRun(mockAtsUrl("mock-controls"));
  const after = await executeRun(run.id, runtime, deps(stored));

  // CONTROL-CHECKBOX-02 — the required disability checkbox has no answer and is PROTECTED:
  // the run pauses for the user instead of toggling anything.
  assert.equal(after.status, "WAITING_FOR_ANSWER", `expected the disability pause, got ${after.status}`);
  const checkpoint = JSON.parse(after.checkpoint_json!);
  const questions = checkpoint.humanQuestions as { label: string; reason: string }[];
  assert.ok(questions.some((q) => /disability/i.test(q.label)), "the sensitive checkbox becomes a user question");
  assert.ok(
    questions.some((q) => /voluntary demographic/i.test(q.reason)),
    "and the reason says WHY: never inferred"
  );

  const completed = checkpoint.completed as { selector: string; canonicalKey: string | null; source: string }[];

  // CONTROL-CHECKBOX-01 — the known safe boolean answer checked the relocation checkbox.
  const relocate = completed.find((c) => c.selector === "#q_relocate");
  assert.ok(relocate, "the relocation checkbox must be filled");
  assert.equal(relocate!.canonicalKey, "willing_to_relocate");
  assert.equal(relocate!.source, "APPLICATION_ANSWER_VAULT");

  // CONTROL-RADIO-01 — the authoritative "No" selected exactly one option of the sponsorship
  // group: one completed entry for the whole group, never one per input.
  const sponsorship = completed.filter((c) => c.canonicalKey === "sponsorship_required");
  assert.equal(sponsorship.length, 1, "one answer decides one radio group exactly once");

  // CONTROL-DROPDOWN-01 — the exact option label filled the select.
  const country = completed.find((c) => c.selector === "#q_country");
  assert.ok(country, "the country select must be filled");

  // The sensitive checkbox was never acted on.
  assert.ok(!completed.some((c) => c.selector === "#q_disability"), "the protected checkbox is untouched");
});

test("CONTROL-RADIO-02: duplicate option labels make an authoritative answer ambiguous — pause, never guess", async () => {
  const stored = new Map<string, StoredAnswer>([["sponsorship_required", approved("Yes")]]);
  const run = newRun(mockAtsUrl("mock-controls-ambiguous"));
  const after = await executeRun(run.id, runtime, deps(stored));

  assert.equal(after.status, "WAITING_FOR_ANSWER", `expected a pause, got ${after.status}`);
  assert.match(after.blocking_reason ?? "", /More than one option/, "the reason names the ambiguity");
  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.equal(checkpoint.completed.length, 0, "nothing was selected in the ambiguous group");
});

// ── pure: planner-level option and date rules ───────────────────────────────────────────────────

const NO_VARIANTS = new Map<string, { canonicalKey: string; type: QuestionType }>();

function control(overrides: Partial<RawControl>): RawControl {
  return { tag: "input", type: "text", id: null, name: null, ariaLabel: null, labelText: null, required: false, ...overrides };
}

test("CONTROL-DROPDOWN-02: a saved answer that is not literally one of the offered options pauses for the user", () => {
  const fields = discoverFields([
    control({ tag: "select", type: null, id: "q_country", labelText: "Country of residence*", required: true }),
  ]);
  fields[0].options = ["United States", "Canada"];
  const plans = planFields({
    fields,
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: new Map([["country_of_residence", approved("USA")]]),
  });
  assert.equal(plans[0].action, "ask", "\"USA\" is not \"United States\" — never a close match, never the first option");
  assert.match((plans[0] as { reason: string }).reason, /not one of the options/);
});

test("CONTROL-DATE-01: a candidate-approved date fills verbatim; absent, it is asked for — never fabricated", () => {
  const dateField = control({ type: "month", id: "avail_start", labelText: "Start date*", required: true });

  // With a run-scoped candidate answer: the value fills exactly as approved — no reformatting.
  const filled = planFields({
    fields: discoverFields([dateField]),
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: new Map(),
    runAnswers: {
      avail_start: {
        questionId: "avail_start",
        selector: "#avail_start",
        label: "Start date",
        answer: "2025-09",
        canonicalKey: null,
        questionType: null,
      },
    },
  });
  assert.equal(filled[0].action, "fill");
  assert.equal((filled[0] as { value: string }).value, "2025-09", "the approved date is preserved verbatim");
  assert.equal((filled[0] as { source: string }).source, "USER_INTERVENTION");

  // Without one: a question, never an invented date.
  const asked = planFields({
    fields: discoverFields([dateField]),
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: new Map(),
  });
  assert.equal(asked[0].action, "ask", "a date Career-Ops does not know is a question, not a guess");
});
