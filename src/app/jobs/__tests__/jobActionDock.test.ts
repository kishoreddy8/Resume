import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDockState } from "../[id]/JobActionDock";
import type { JobMatch } from "../[id]/useJobMatch";
import type { JobMatchResult } from "@/lib/match/types";

/**
 * The dock decides which single action a job offers. It is presentation only — it reads the Phase 2
 * decision, the tailoring mark and whether generated files exist, and never recomputes or
 * reinterprets any of them. These tests pin that mapping, because the failure mode is silent and
 * serious: offering "Approve Tailoring" on a BLOCKED posting would invite exactly the action the
 * engine says must not happen.
 */

function match(partial: Partial<JobMatchResult> & { decision: JobMatchResult["decision"] }): JobMatch {
  return {
    state: "ok",
    reason: null,
    evaluate: async () => {},
    result: { insufficientJdSignal: false, overallScore: 90, ...partial } as JobMatchResult,
  };
}
const unevaluated: JobMatch = { state: "none", reason: null, result: null, evaluate: async () => {} };
const loading: JobMatch = { state: "loading", reason: null, result: null, evaluate: async () => {} };
const unmarked = { marked_for_tailoring: 0 as const };
const marked = { marked_for_tailoring: 1 as const };

test("DOCK-1 an unevaluated job offers evaluation, not tailoring", () => {
  const s = resolveDockState(unevaluated, unmarked, 0);
  assert.equal(s.phase, "unevaluated");
  assert.equal(s.label, "Evaluate Match");
  assert.equal(s.actionable, true);
});

test("DOCK-2 a loading match offers nothing actionable", () => {
  const s = resolveDockState(loading, unmarked, 0);
  assert.equal(s.phase, "checking");
  assert.equal(s.actionable, false);
});

test("DOCK-3 BLOCKED never offers tailoring, marked or not", () => {
  for (const job of [unmarked, marked]) {
    const s = resolveDockState(match({ decision: "BLOCKED" }), job, 0);
    assert.equal(s.phase, "blocked");
    assert.equal(s.actionable, false, "a blocked job must offer no primary action");
    assert.ok(!/tailor/i.test(s.label), `blocked label must not invite tailoring, got "${s.label}"`);
  }
});

test("DOCK-4 NEEDS_REVIEW sends the user to the reasons, not to tailoring", () => {
  const s = resolveDockState(match({ decision: "NEEDS_REVIEW" }), unmarked, 0);
  assert.equal(s.phase, "needs-review");
  assert.equal(s.label, "Review Issues");
  assert.ok(!/approve/i.test(s.label));
});

test("DOCK-5 READY_FOR_TAILORING is the one place approval becomes the primary action", () => {
  const s = resolveDockState(match({ decision: "READY_FOR_TAILORING" }), unmarked, 0);
  assert.equal(s.phase, "ready-to-approve");
  assert.equal(s.label, "Approve Tailoring");
  assert.equal(s.actionable, true);
});

test("DOCK-6 an approved job states that nothing runs on its own — the writer is off", () => {
  const s = resolveDockState(match({ decision: "READY_FOR_TAILORING" }), marked, 0);
  assert.equal(s.phase, "approved-awaiting-resume");
  assert.equal(s.actionable, false, "approval must not present as work in progress");
  assert.ok(/Resume Writer is off/i.test(s.hint), "must say plainly that nothing generates automatically");
  assert.ok(!/generating/i.test(s.label), "must not claim generation is underway");
});

test("DOCK-7 existing generated files take precedence and offer review", () => {
  for (const decision of ["READY_FOR_TAILORING", "NEEDS_REVIEW"] as const) {
    const s = resolveDockState(match({ decision }), marked, 2);
    assert.equal(s.phase, "resume-ready");
    assert.equal(s.label, "Review Resume");
    assert.ok(/2 generated files/.test(s.hint));
  }
});

test("DOCK-8 every phase yields exactly one label and one hint", () => {
  const cases: JobMatch[] = [
    unevaluated,
    loading,
    match({ decision: "BLOCKED" }),
    match({ decision: "NEEDS_REVIEW" }),
    match({ decision: "READY_FOR_TAILORING" }),
  ];
  for (const m of cases) {
    for (const job of [unmarked, marked]) {
      for (const files of [0, 1]) {
        const s = resolveDockState(m, job, files);
        assert.ok(s.label.length > 0, "every state needs a label");
        assert.ok(s.hint.length > 0, "every state needs an explanation");
      }
    }
  }
});
