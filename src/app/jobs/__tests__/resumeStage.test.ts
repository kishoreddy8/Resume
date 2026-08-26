import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { formatQualityScore, summarizeResumeStage } from "../[id]/resumeStage";

/**
 * UI-0 DEFECT 1 — the READY success banner used to render `workflow.latest_overall_score ?? 96`,
 * fabricating a 96/100 score whenever no real score existed. These tests pin the honest
 * replacement: a real score renders exactly, and a missing one never renders any number at all.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("UI-TRUST-01: missing resume quality score never renders a fabricated number", () => {
  const result = formatQualityScore(null);
  assert.doesNotMatch(result, /\d/, `"${result}" must not contain any digit — no fallback number, ever`);
  assert.equal(result, "Quality check unavailable");
});

test("UI-TRUST-02: a real score renders exactly, unmodified", () => {
  assert.equal(formatQualityScore(100), "100/100");
  assert.equal(formatQualityScore(96), "96/100");
  assert.equal(formatQualityScore(0), "0/100", "0 is a real, falsy-but-valid score and must not be treated as missing");
});

test("UI-TRUST-03: READY without a score does not imply 100, 96, or any other number", () => {
  /* A workflow can be READY (status) while latest_overall_score is still null — the two fields are
   * independent, and READY must never be read as "so the score must be near-perfect". */
  for (const maybeMissing of [null]) {
    const result = formatQualityScore(maybeMissing);
    assert.doesNotMatch(result, /100|96|9[0-9]/, "READY-adjacent fallback text must not imply any specific number");
  }
});

test("the fabricated 96 fallback no longer exists anywhere in the resume pipeline source", () => {
  const source = read("src/app/jobs/[id]/ResumeQualityPipeline.tsx");
  assert.doesNotMatch(source, /\?\?\s*96/, "no `?? 96` fallback may remain");
  assert.match(source, /formatQualityScore\(workflow\.latest_overall_score\)/, "the banner must use the honest formatter");
});

test("UI5.1-STAGE-BUG-01: a terminal FAILED workflow with a SAFE_BEST_ATTEMPT disposition is reported as safe-best-attempt, not as a plain blocked failure", () => {
  /* determineFinalDisposition (finalDisposition.ts) can independently return SAFE_BEST_ATTEMPT for a
   * workflow whose own `status` is FAILED — that is in fact the normal outcome whenever every
   * absolute safety/truthfulness guardrail holds but the optimisation bar was never cleared after
   * max iterations. Before this fix, summarizeResumeStage only consulted `disposition` when
   * status === "READY", so this common, real, reachable case fell through to the generic FAILED
   * branch and reported {key:"failed", tone:"blocked"} — indistinguishable, in the shared top-level
   * command-center rail (WorkflowRail.tsx), from a genuinely blocked, unsendable-anything failure.
   * The candidate would see red "Needs attention" for a resume they actually can review and use. */
  const result = summarizeResumeStage({
    status: "FAILED",
    waitingFor: "NOT_WAITING",
    disposition: "SAFE_BEST_ATTEMPT",
    currentIteration: 3,
  });
  assert.equal(result.key, "safe_best_attempt");
  assert.notEqual(result.tone, "blocked", "a safe best attempt must never render with the same tone as a genuine block");
});

test("UI5.1-STAGE-BUG-02: a terminal FAILED workflow with a BLOCKED disposition (or no disposition at all) still reports as genuinely blocked", () => {
  const blocked = summarizeResumeStage({ status: "FAILED", waitingFor: "NOT_WAITING", disposition: "BLOCKED", currentIteration: 3 });
  assert.equal(blocked.tone, "blocked");
  const unknown = summarizeResumeStage({ status: "FAILED", waitingFor: "NOT_WAITING", disposition: null, currentIteration: 3 });
  assert.equal(unknown.tone, "blocked", "an indeterminate disposition on a FAILED workflow must still default to the safe (blocked) reading, never to safe-best-attempt");
});

test("no other component in the repository fabricates a quality-style numeric fallback", () => {
  /* Repository-wide sweep for the same shape of bug: a score-like field defaulting to a specific
   * plausible-looking number (90-100) instead of an honest "unavailable" state. */
  const roots = ["src/app"];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        /* Strip comments first — this test itself documents the fixed `?? 96` bug in prose, and a
         * raw scan would flag its own explanation as a live offender. */
        const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        if (/score[^\n]{0,40}\?\?\s*(9[0-9]|100)\b/i.test(code)) offenders.push(full);
      }
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, [], `fabricated score-shaped fallback found in: ${offenders.join(", ")}`);
});
