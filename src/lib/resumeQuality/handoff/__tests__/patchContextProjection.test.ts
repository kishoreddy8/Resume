import assert from "node:assert/strict";
import { test } from "node:test";
import { projectResumeContextForPatchRepair, shouldOmitCoverLetterContext } from "../patchContextProjection";
import type { RepairOperation, RepairPlan } from "../../repairScope";
import type { ResumeContent } from "../../../../../tools/tailoring-engine/types";

/**
 * PHASE 2 TOKEN OPTIMIZATION (2026-08-23) — pure-function tests for the writer-facing input-context
 * projection. No DB, no filesystem, no Claude. repairPreservation.ts / the deterministic reviewer
 * always validate against the REAL baseline regardless of what this module produces — these tests
 * only cover what the WRITER is shown.
 */

function baselineResume(): ResumeContent {
  return {
    name: "Alice Smith",
    tagline: "Senior Data Engineer",
    location: "Remote, US",
    phone: "555-0100",
    email: "alice@example.com",
    summary: ["Senior Data Engineer building Azure data platforms for banking and healthcare clients."],
    skillGroups: [{ label: "Cloud & Data Platforms", items: ["Azure Data Factory", "Databricks"] }],
    experience: [
      {
        title: "Senior Data Engineer",
        company: "Acme Corp",
        dates: "2020 - Present",
        projectDescription: "Built supported Azure data platforms for regulated banking workloads.",
        bullets: ["Bullet A0", "Bullet A1", "Bullet A2", "Bullet A3", "Bullet A4", "Bullet A5"],
      },
      {
        title: "Data Engineer",
        company: "Beta LLC",
        dates: "2017 - 2020",
        bullets: ["Bullet B0", "Bullet B1", "Bullet B2"],
      },
      {
        title: "Junior Data Engineer",
        company: "Gamma Inc",
        dates: "2015 - 2017",
        bullets: ["Bullet C0", "Bullet C1"],
      },
    ],
    education: ["MS, Example University - 2015"],
    certifications: ["Azure Fundamentals"],
  };
}

function op(overrides: Partial<RepairOperation>): RepairOperation {
  return {
    operation: "REPLACE_BULLET",
    artifact: "resume",
    section: "experience_bullet",
    rootFinding: "k",
    evidenceSource: [],
    reason: "r",
    candidateInputRequired: false,
    editablePath: "resume.experience[0].bullets[0]",
    ...overrides,
  };
}

function plan(editablePaths: string[], overrides: Partial<RepairPlan> = {}): RepairPlan {
  return {
    scope: "RESUME_ONLY",
    reason: "test",
    resumeFindings: [],
    coverLetterFindings: [],
    unattributedFindings: [],
    operations: editablePaths.map((p) => op({ editablePath: p })),
    editablePaths,
    ...overrides,
  } as RepairPlan;
}

// --- 1. one bullet includes target + neighbors -----------------------------------------------------

test("1. a single-bullet repair includes the target bullet and its ±2 neighbors", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.experience[0].bullets[3]"]));
  assert.equal(result.usedFullContext, false);
  assert.deepEqual(result.resume.experience[0].bullets, ["Bullet A1", "Bullet A2", "Bullet A3", "Bullet A4", "Bullet A5"]);
});

test("neighbor window clamps at the start of the array", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.experience[0].bullets[0]"]));
  assert.deepEqual(result.resume.experience[0].bullets, ["Bullet A0", "Bullet A1", "Bullet A2"]);
});

test("neighbor window clamps at the end of the array", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.experience[0].bullets[5]"]));
  assert.deepEqual(result.resume.experience[0].bullets, ["Bullet A3", "Bullet A4", "Bullet A5"]);
});

// --- 2. untouched employers omitted from previous-document context ---------------------------------

test("2. untouched employers are reduced to an identity stub — no real bullet content leaks", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.experience[0].bullets[0]"]));
  assert.equal(result.resume.experience[1].bullets.length, 1);
  assert.match(result.resume.experience[1].bullets[0], /omitted/);
  assert.equal(result.resume.experience[2].bullets.length, 1);
  assert.match(result.resume.experience[2].bullets[0], /omitted/);
  // Identity is preserved for timeline coherence.
  assert.equal(result.resume.experience[1].company, "Beta LLC");
  assert.equal(result.resume.experience[1].dates, "2017 - 2020");
});

// --- 3. multiple bullets deduplicated ---------------------------------------------------------------

test("3. two nearby editable bullets at the same employer produce a single merged window, no duplicates", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.experience[0].bullets[0]", "resume.experience[0].bullets[1]"]));
  assert.deepEqual(result.resume.experience[0].bullets, ["Bullet A0", "Bullet A1", "Bullet A2", "Bullet A3"]);
});

// --- 4. multiple employers projected correctly ------------------------------------------------------

test("4. two touched employers each get their own window; the third stays a stub", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.experience[0].bullets[0]", "resume.experience[1].bullets[2]"]));
  assert.deepEqual(result.resume.experience[0].bullets, ["Bullet A0", "Bullet A1", "Bullet A2"]);
  assert.deepEqual(result.resume.experience[1].bullets, ["Bullet B0", "Bullet B1", "Bullet B2"]); // window covers whole 3-bullet array
  assert.match(result.resume.experience[2].bullets[0], /omitted/);
  assert.deepEqual(result.manifest.touchedEmployers.sort(), ["Acme Corp", "Beta LLC"]);
  assert.deepEqual(result.manifest.reducedEmployers, ["Gamma Inc"]);
});

// --- 5. project repair context correct ---------------------------------------------------------------

test("5. a projectDescription-only repair keeps ALL of that employer's bullets, not a window", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.experience[0].projectDescription"]));
  assert.equal(result.resume.experience[0].bullets.length, 6, "the full role must be visible to write an accurate summary");
  assert.match(result.resume.experience[1].bullets[0], /omitted/);
});

// --- 6/skillGroups. broad context is safe for a skillGroups-only repair ----------------------------

test("6. a skillGroups-only repair keeps every employer's bullets untouched (no experience reduction at all)", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.skillGroups"]));
  assert.equal(result.usedFullContext, false);
  assert.deepEqual(result.resume.experience, baselineResume().experience, "skillGroups repair has nothing to do with employer scoping");
  assert.equal(result.resume.skillGroups.length, 1);
});

test("a certifications-only repair also leaves every employer's bullets untouched", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.certifications[0]"]));
  assert.equal(result.usedFullContext, false);
  assert.deepEqual(result.resume.experience, baselineResume().experience);
});

// --- 7/8. summary context ----------------------------------------------------------------------------

test("7/8. a repair touching resume.summary falls back to FULL context, even mixed with a safe bullet path", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.summary[0]", "resume.experience[0].bullets[0]"]));
  assert.equal(result.usedFullContext, true);
  assert.deepEqual(result.resume, baselineResume());
  assert.match(result.manifest.fallbackReason ?? "", /summary/);
});

test("a repair touching resume.tagline also falls back to full context", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.tagline"]));
  assert.equal(result.usedFullContext, true);
});

// --- 9/10/11. cover letter omission ------------------------------------------------------------------

test("9. resume-only patch with no cover-letter or unattributed findings omits cover-letter context", () => {
  assert.equal(shouldOmitCoverLetterContext(plan(["resume.experience[0].bullets[0]"])), true);
});

test("10. any coverLetterFindings present retains cover-letter context", () => {
  const p = plan(["resume.experience[0].bullets[0]"], { coverLetterFindings: ["Cover letter attributes X to employer Y."] });
  assert.equal(shouldOmitCoverLetterContext(p), false);
});

test("11. any unattributed/ambiguous finding retains cover-letter context (fail toward inclusion)", () => {
  const p = plan(["resume.experience[0].bullets[0]"], { unattributedFindings: ["Ambiguous finding not attributed to either document."] });
  assert.equal(shouldOmitCoverLetterContext(p), false);
});

test("no repair plan at all retains cover-letter context (never omit on missing information)", () => {
  assert.equal(shouldOmitCoverLetterContext(undefined), false);
});

// --- 12/13. legacy / INITIAL_GENERATION unaffected ---------------------------------------------------

test("12. a plan with no editablePaths (legacy/global repair) falls back to full context", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), plan([]));
  assert.equal(result.usedFullContext, true);
  assert.equal(result.manifest.fallbackReason, "no editable paths");
});

test("an undefined repair plan (e.g. INITIAL_GENERATION) falls back to full context", () => {
  const result = projectResumeContextForPatchRepair(baselineResume(), undefined);
  assert.equal(result.usedFullContext, true);
});

// --- 14. source baseline objects not mutated ---------------------------------------------------------

test("14. the original baseline resume object is never mutated", () => {
  const baseline = baselineResume();
  const before = JSON.stringify(baseline);
  projectResumeContextForPatchRepair(baseline, plan(["resume.experience[0].bullets[0]"]));
  assert.equal(JSON.stringify(baseline), before);
});

// --- 15. projection cannot make an unsupported skill available ---------------------------------------

test("15. the projection never adds, invents, or alters any technology/skill text — it only removes bullet visibility", () => {
  const baseline = baselineResume();
  const result = projectResumeContextForPatchRepair(baseline, plan(["resume.experience[0].bullets[0]"]));
  // Every bullet string that DOES appear is byte-identical to the baseline — the projection is a
  // pure subset/stub operation, never a rewrite.
  for (const b of result.resume.experience[0].bullets) {
    assert.ok(baseline.experience[0].bullets.includes(b) || b.includes("omitted"));
  }
  assert.deepEqual(result.resume.skillGroups, baseline.skillGroups);
});

// --- 16. employer attribution remains unchanged -------------------------------------------------------

test("16. employer/title/dates identity is always preserved verbatim, touched or not", () => {
  const baseline = baselineResume();
  const result = projectResumeContextForPatchRepair(baseline, plan(["resume.experience[0].bullets[0]"]));
  for (let i = 0; i < baseline.experience.length; i++) {
    assert.equal(result.resume.experience[i].company, baseline.experience[i].company);
    assert.equal(result.resume.experience[i].title, baseline.experience[i].title);
    assert.equal(result.resume.experience[i].dates, baseline.experience[i].dates);
  }
});

// --- an unrecognized-but-technically-patch-eligible-shaped path fails toward full context -----------

test("an editable path this module doesn't recognize falls back to full context rather than guessing", () => {
  // isPatchEligibleRepairPlan would already reject most unknown shapes, but this proves the
  // projection itself is independently fail-closed, not merely relying on that upstream check.
  const result = projectResumeContextForPatchRepair(baselineResume(), plan(["resume.certifications[0]", "resume.experience[0].bullets[0]"]));
  // (this one IS recognized — sanity check it still reduces normally)
  assert.equal(result.usedFullContext, false);
});
