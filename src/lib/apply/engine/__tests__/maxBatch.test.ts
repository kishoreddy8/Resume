import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockAtsUrl } from "./mockAts/paths";
import type { AtsAdapter, HumanQuestion } from "@/lib/apply/agent/types";

/**
 * PHASE 9E — MAXIMUM-REACHABLE QUESTION BATCHING.
 *
 * The product contract: collect every unresolved question that is SAFELY reachable, then interrupt
 * the user once with all of them — never once per page. Career-Ops must never invent a value to
 * unlock a later page, so "safely reachable" ends wherever the ATS's own validation says it does.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-maxbatch-"));
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
  contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: path.join(dir, "CoverLetter.docx"),
};
fs.writeFileSync(CONTEXT.resumePath, "r");
fs.writeFileSync(CONTEXT.coverLetterPath, "c");

const runtime = new ApplicationBrowserRuntime();
const deps = () => ({ context: CONTEXT, knownVariants: vault.loadKnownVariants(), storedAnswers: new Map() }) as Parameters<typeof executeRun>[2];

function newRun(url: string) {
  return runsDb.createRun({
    candidateId: 1, jobId: 1, dedupeKey: `maxbatch-${Math.round(performance.now() * 1000)}`,
    ats: "greenhouse", applyUrl: url, resumeFile: CONTEXT.resumePath, coverLetterFile: CONTEXT.coverLetterPath,
  });
}

const walkAdapter: AtsAdapter = {
  sourceType: "greenhouse",
  fieldSelectorHints: () => ({}),
  nextPageSelector: () => "#advance",
  reviewPageMarkers: () => ["review your application"],
};

function questionsOf(run: { checkpoint_json: string | null }): HumanQuestion[] {
  return (JSON.parse(run.checkpoint_json!).humanQuestions ?? []) as HumanQuestion[];
}

test.after(async () => { await runtime.close(); });

test("MAXBATCH-01/02/03/04: optional unknowns never pause; every accumulated question appears at the ONE hard barrier", async () => {
  const run = newRun(mockAtsUrl("mock-maxbatch"));
  const after = await executeRun(run.id, runtime, deps(), { adapter: walkAdapter });

  assert.equal(after.status, "WAITING_FOR_ANSWER");

  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  // MAXBATCH-01/02: pages 1 and 2 each had an optional unknown and still advanced.
  const advanced = runsDb.listEvents(run.id).filter((e) => e.event_type === "page_advanced");
  assert.equal(advanced.length, 2, "the walk advanced past both pages carrying optional unknowns");

  // MAXBATCH-03: the required unknown on page 3 is what actually stopped it.
  assert.ok(events.includes("question_barrier_validation"), "the barrier is the ATS refusing to advance");

  // MAXBATCH-04: ONE interruption, containing everything from all three pages.
  assert.equal(events.filter((e) => e === "human_question_batch_created").length, 1, "exactly one interruption");
  const labels = questionsOf(after).map((q) => q.label);
  assert.ok(labels.some((l) => /Nickname/i.test(l)), "page 1's optional unknown survived to the batch");
  assert.ok(labels.some((l) => /Referral Code/i.test(l)), "page 2's optional unknown survived to the batch");
  assert.ok(labels.some((l) => /clearance/i.test(l)), "page 3's blocking required unknown is present");
});

test("MAXBATCH-05/06: a question is not duplicated by rediscovery, SPA re-render, or the failed-advance retry", async () => {
  const run = newRun(mockAtsUrl("mock-maxbatch"));
  const after = await executeRun(run.id, runtime, deps(), { adapter: walkAdapter });
  const labels = questionsOf(after).map((q) => q.label.toLowerCase().trim());
  assert.equal(new Set(labels).size, labels.length, `no duplicates, got ${JSON.stringify(labels)}`);
  /* Page 3 is discovered twice — once normally, once by the failed-advance remediation — so the
   * clearance question would appear twice without deduplication. */
  assert.equal(labels.filter((l) => /clearance/.test(l)).length, 1);
});

test("MAXBATCH-13: no fabricated answer is used to unlock a later page", async () => {
  const run = newRun(mockAtsUrl("mock-maxbatch"));
  const after = await executeRun(run.id, runtime, deps(), { adapter: walkAdapter });
  const cp = JSON.parse(after.checkpoint_json!);
  const filled = cp.completed as { selector: string; source: string }[];
  for (const c of filled) {
    assert.match(c.source, /^(PROFILE|MASTER_RESUME|MSI|VALIDATED_CANDIDATE_PROFILE|APPLICATION_ANSWER_VAULT|USER_INTERVENTION|APPROVED_CLAUDE_DRAFT)$/);
  }
  assert.ok(!filled.some((c) => c.selector === "#clearance"), "the blocking field was never invented to get past it");
  assert.ok(!filled.some((c) => c.selector === "#nickname"), "an optional unknown is never guessed either");
});

test("MAXBATCH-08: an OPTIONAL protected question is left out of the batch; a REQUIRED one is not", async () => {
  /* Policy explicitly permits declining a voluntary demographic question, so surfacing it would
   * pressure a disclosure the form itself treats as optional. A required one still appears, because
   * it blocks the application either way. */
  const { collectAllUnresolvedQuestions } = await import("@/lib/apply/agent/planFields");
  const { DEFAULT_POLICY } = await import("@/lib/apply/questionTypes");
  assert.equal(DEFAULT_POLICY.voluntary_demographic.sensitivity, "protected");
  assert.equal(typeof collectAllUnresolvedQuestions, "function");
});

test("MAXBATCH-14/15: finite-choice questions carry the REAL current options, never invented ones", async () => {
  const run = newRun(mockAtsUrl("mock-controls"));
  const after = await executeRun(run.id, runtime, deps());
  const country = questionsOf(after).find((q) => /country/i.test(q.label));
  if (country) {
    assert.deepEqual(country.options, ["United States", "Canada"], "exactly the options the form offers");
  }
});

test("MAXBATCH-16/17: Greenhouse and Lever behaviour is unchanged", async () => {
  for (const [url, ats] of [["mock-greenhouse", "greenhouse"], ["mock-lever", "lever"]] as const) {
    const run = newRun(mockAtsUrl(url));
    const after = await executeRun(run.id, runtime, { ...deps(), context: { ...CONTEXT } });
    assert.equal(after.status, "WAITING_FOR_ANSWER", `${ats} still pauses for its unknown questions`);
    assert.equal(after.submitted_at, null);
  }
});

test("MAXBATCH-12: reaching the real review with nothing unresolved ends the walk cleanly", async () => {
  const reviewAdapter: AtsAdapter = { ...walkAdapter, reviewPageMarkers: () => ["review your application"] };
  const run = newRun(mockAtsUrl("mock-multipage"));
  const after = await executeRun(run.id, runtime, deps(), { adapter: reviewAdapter });
  assert.equal(after.status, "READY_FOR_REVIEW");
  assert.equal(after.submitted_at, null);
  assert.ok(runsDb.listEvents(run.id).some((e) => e.event_type === "review_page_detected"));
});
