import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateDeepRewrite } from "../reviewers/deepRewriteCheck";
import { allChecksPass, isComplianceBlocking } from "../instructionCompliance";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES, type InstructionComplianceChecks } from "../types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * Regression suite for the Stage 28 / deep-rewrite contradiction.
 *
 * THE DEFECT. repairScope.ts instructs the writer "TARGETED REPAIR — CHANGE ONLY WHAT IS LISTED
 * HERE" and emits that header for every scope, FULL included. deepRewriteCheck then judged the
 * result as if a full rewrite had been required and failed it for preserving >=80% of bullets, so a
 * correctly executed narrow repair became unsendable for obeying its instructions. Two real
 * workflows showed the signature — one RESUME_ONLY, one FULL — which is why these tests assert on
 * the CONTRACT and never on the scope value, the score, the correction count or the iteration.
 *
 * Every test below builds its own fixture. Nothing reads the live database or the real workspace.
 */

/** A resume whose experience bullets can be varied precisely. */
function resumeWith(bullets: string[]): ResumeContent {
  return {
    name: "Sai Kishore Reddy",
    tagline: "Data Engineer",
    location: "Dallas, TX",
    phone: "555-0000",
    email: "candidate@example.com",
    linkedin: "linkedin.com/in/example",
    summary: ["Data engineer working across Snowflake and dbt."],
    skillGroups: [{ label: "Data", items: ["Snowflake", "dbt", "Python"] }],
    experience: [{ title: "Data Engineer", company: "Comerica Bank", dates: "2025-02 - Present", bullets }],
    education: [],
    certifications: [],
  } as unknown as ResumeContent;
}

/** 25 bullets, of which `changedCount` differ from the prior version. 21/25 unchanged = 84%. */
function pair(changedCount: number): { prior: ResumeContent; current: ResumeContent } {
  const priorBullets = Array.from({ length: 25 }, (_, i) => `Built pipeline number ${i} on Snowflake.`);
  const currentBullets = priorBullets.map((b, i) => (i < changedCount ? `${b} Rewritten variant ${i}.` : b));
  return { prior: resumeWith(priorBullets), current: resumeWith(currentBullets) };
}

const UNCHANGED_84 = pair(4); // 21 of 25 identical = 84%, above the 80% FAIL threshold

/* ── 1. Full rewrite expected + 84% unchanged → FAIL (behaviour unchanged) ─────────────────── */

test("full rewrite expected: 84% unchanged bullets still FAIL", () => {
  const result = evaluateDeepRewrite({
    resume: UNCHANGED_84.current,
    priorResume: UNCHANGED_84.prior,
    rewriteExpectation: "FULL_REWRITE",
  });
  assert.equal(result.status, "FAIL");
  assert.match(result.evidence[0]!, /84% of experience bullets are byte-identical/);
});

/* ── 2. Scoped repair + 84% unchanged → NOT_APPLICABLE, and does not block ─────────────────── */

test("targeted repair: 84% unchanged bullets is NOT_APPLICABLE, not a failure", () => {
  const result = evaluateDeepRewrite({
    resume: UNCHANGED_84.current,
    priorResume: UNCHANGED_84.prior,
    rewriteExpectation: "TARGETED_REPAIR",
  });
  assert.equal(result.status, "NOT_APPLICABLE");
  assert.equal(isComplianceBlocking(result.status), false, "an inapplicable check must not block READY");
  assert.match(result.evidence[0]!, /targeted repair plan/i);
  assert.doesNotMatch(
    result.evidence.join(" "),
    /\d+% of experience bullets/,
    "the comparison must not be run and reported when it was never the contract"
  );
});

test("targeted repair does not fabricate PASS", () => {
  const result = evaluateDeepRewrite({
    resume: UNCHANGED_84.current,
    priorResume: UNCHANGED_84.prior,
    rewriteExpectation: "TARGETED_REPAIR",
  });
  assert.notEqual(result.status, "PASS", "recording PASS would claim a requirement was met that was never evaluated");
});

/* ── 9. Missing contract → fail closed to the full-rewrite rule ────────────────────────────── */

test("absent rewriteExpectation falls back to full-rewrite enforcement", () => {
  const result = evaluateDeepRewrite({ resume: UNCHANGED_84.current, priorResume: UNCHANGED_84.prior });
  assert.equal(result.status, "FAIL", "an unknown contract must never be read as permission to skip the check");
});

test("an unresolvable writer_input.json resolves to FULL_REWRITE", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deeprewrite-"));
  try {
    process.env.CAREER_OPS_GENERATED_DIR = dir;
    const { resolveDeterministicReviewContext } = await import("../reviewInputContext");
    const ctx = resolveDeterministicReviewContext({
      candidateId: 1,
      location: { candidateId: 1, dedupeKey: "fixture:none", runId: 1, workflowId: 1 },
      iterationNumber: 2,
      dedupeKey: "fixture:none",
    });
    assert.equal(ctx.rewriteExpectation, "FULL_REWRITE");
  } finally {
    delete process.env.CAREER_OPS_GENERATED_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 8. The reviewer receives the exact persisted RepairPlan scope ─────────────────────────── */

test("a persisted repair plan of ANY scope resolves to TARGETED_REPAIR", async () => {
  /* Both real workflows are covered here: wf 10 was RESUME_ONLY and wf 11 was FULL, and both were
   * told to change only the listed findings. Scope says which documents may be touched, never how
   * much of them must be rewritten — so scope must not be the discriminator. */
  for (const scope of ["FULL", "RESUME_ONLY", "COVER_LETTER_ONLY"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deeprewrite-scope-"));
    try {
      process.env.CAREER_OPS_GENERATED_DIR = dir;
      const { getHandoffDirectory } = await import("../workspace");
      const location = { candidateId: 1, dedupeKey: "fixture:scope", runId: 3, workflowId: 4 };
      const handoff = getHandoffDirectory(location, 2);
      fs.mkdirSync(handoff, { recursive: true });
      fs.writeFileSync(
        path.join(handoff, "writer_input.json"),
        JSON.stringify({ repairPlan: { scope, reason: "fixture", resumeFindings: [], coverLetterFindings: [], unattributedFindings: [] } })
      );
      const { resolveDeterministicReviewContext } = await import("../reviewInputContext");
      const ctx = resolveDeterministicReviewContext({
        candidateId: 1,
        location,
        iterationNumber: 2,
        dedupeKey: "fixture:scope",
      });
      assert.equal(ctx.rewriteExpectation, "TARGETED_REPAIR", `${scope} instructs a targeted repair`);
    } finally {
      delete process.env.CAREER_OPS_GENERATED_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a handoff with no repair plan resolves to FULL_REWRITE", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deeprewrite-noplan-"));
  try {
    process.env.CAREER_OPS_GENERATED_DIR = dir;
    const { getHandoffDirectory } = await import("../workspace");
    const location = { candidateId: 1, dedupeKey: "fixture:noplan", runId: 3, workflowId: 5 };
    const handoff = getHandoffDirectory(location, 1);
    fs.mkdirSync(handoff, { recursive: true });
    fs.writeFileSync(path.join(handoff, "writer_input.json"), JSON.stringify({ repairPlan: null }));
    const { resolveDeterministicReviewContext } = await import("../reviewInputContext");
    const ctx = resolveDeterministicReviewContext({
      candidateId: 1,
      location,
      iterationNumber: 1,
      dedupeKey: "fixture:noplan",
    });
    assert.equal(ctx.rewriteExpectation, "FULL_REWRITE");
  } finally {
    delete process.env.CAREER_OPS_GENERATED_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 3–5, 7. Other checks remain blocking; deepRewrite alone still blocks a full rewrite ───── */

function checksAllPass(): InstructionComplianceChecks {
  const c = {} as InstructionComplianceChecks;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) c[name] = "PASS";
  return c;
}

test("scoped repair + every other check passing: compliance no longer blocks", () => {
  const checks = checksAllPass();
  checks.deepRewrite = "NOT_APPLICABLE";
  assert.equal(allChecksPass({ instructionVersion: "v", instructionHash: "h", checks, notes: [] }), true);
});

test("full rewrite + deepRewrite FAIL: compliance still blocks", () => {
  const checks = checksAllPass();
  checks.deepRewrite = "FAIL";
  assert.equal(allChecksPass({ instructionVersion: "v", instructionHash: "h", checks, notes: [] }), false);
});

test("scoped repair does NOT excuse any other failing check", () => {
  /* The applicability state is scoped to one check. Every other guardrail keeps its teeth — this is
   * the assertion that the fix did not become a general weakening of the gate. */
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) {
    if (name === "deepRewrite") continue;
    for (const failing of ["FAIL", "REVIEW"] as const) {
      const checks = checksAllPass();
      checks.deepRewrite = "NOT_APPLICABLE";
      checks[name] = failing;
      assert.equal(
        allChecksPass({ instructionVersion: "v", instructionHash: "h", checks, notes: [] }),
        false,
        `${name}=${failing} must still block even under a targeted repair`
      );
    }
  }
});

test("isComplianceBlocking: only FAIL and REVIEW block", () => {
  assert.equal(isComplianceBlocking("PASS"), false);
  assert.equal(isComplianceBlocking("NOT_APPLICABLE"), false);
  assert.equal(isComplianceBlocking("FAIL"), true);
  assert.equal(isComplianceBlocking("REVIEW"), true);
});
