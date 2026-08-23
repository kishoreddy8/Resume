import assert from "node:assert/strict";
import { test } from "node:test";
import { isPatchEligibleRepairPlan, reconstructFromPatchOperations } from "../patchRepair";
import type { CoverLetterContent, ResumeContent } from "../../types";

/**
 * PATCH-BASED TARGETED_REPAIR (2026-08-23) — pure-function tests. No DB, no filesystem, no Claude.
 * repairPreservation.ts's own comparator (already tested exhaustively in repairPreservation.test.ts)
 * remains the final authority on whether a repaired document is acceptable; these tests only cover
 * the NEW layer in front of it: does a patch response get turned into the SAME shape a legacy
 * full-document response would have produced, and does an unauthorized/malformed one get refused
 * before it ever reaches that comparator.
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
        bullets: ["Engineered supported PySpark pipelines on Azure Databricks.", "Automated data quality checks with GitHub Actions."],
      },
      {
        title: "Data Engineer",
        company: "Beta LLC",
        dates: "2017 - 2020",
        bullets: ["Built ETL pipelines with Informatica IICS.", "Maintained SQL Server reporting datasets."],
      },
    ],
    education: ["MS, Example University - 2017"],
    certifications: ["Azure Fundamentals"],
  };
}

function baselineCoverLetter(): CoverLetterContent {
  return {
    name: "Alice Smith",
    location: "Remote, US",
    phone: "555-0100",
    email: "alice@example.com",
    salutation: "Dear Hiring Team,",
    paragraphs: ["I am excited to apply. At Acme Corp, I built Azure Databricks pipelines. These experiences prepared me for the role."],
    closing: "Sincerely,\nAlice Smith",
  };
}

// --- isPatchEligibleRepairPlan --------------------------------------------------------------------

test("1. a summary-only repair plan is patch-eligible", () => {
  assert.equal(isPatchEligibleRepairPlan(["resume.summary[0]"]), true);
});

test("2. a one-bullet repair plan is patch-eligible", () => {
  assert.equal(isPatchEligibleRepairPlan(["resume.experience[0].bullets[1]"]), true);
});

test("4. a multiple-employer bullet repair plan is patch-eligible", () => {
  assert.equal(isPatchEligibleRepairPlan(["resume.experience[0].bullets[0]", "resume.experience[1].bullets[1]"]), true);
});

test("5. a skillGroups (whole-array) repair plan is patch-eligible", () => {
  assert.equal(isPatchEligibleRepairPlan(["resume.skillGroups"]), true);
});

test("6. a project-description repair plan is patch-eligible", () => {
  assert.equal(isPatchEligibleRepairPlan(["resume.experience[1].projectDescription"]), true);
});

test("7. a certification repair plan is patch-eligible", () => {
  assert.equal(isPatchEligibleRepairPlan(["resume.certifications[0]"]), true);
});

test("8. a cover-letter (sentence-level) path disqualifies the WHOLE plan, even mixed with safe resume paths", () => {
  assert.equal(isPatchEligibleRepairPlan(["resume.summary[0]", "coverLetter.paragraphs[0].sentences[0]"]), false);
});

test("empty or absent editablePaths is never patch-eligible", () => {
  assert.equal(isPatchEligibleRepairPlan([]), false);
  assert.equal(isPatchEligibleRepairPlan(undefined), false);
});

test("an unrecognized path shape disqualifies the whole plan", () => {
  assert.equal(isPatchEligibleRepairPlan(["resume.someNewField[0].nested"]), false);
});

// --- reconstructFromPatchOperations: happy paths -------------------------------------------------

test("3. multiple bullets at the same employer reconstruct correctly", () => {
  const result = reconstructFromPatchOperations(
    baselineResume(),
    undefined,
    [
      { document: "resume", path: "experience[0].bullets[0]", replacement: "Rewritten bullet A." },
      { document: "resume", path: "experience[0].bullets[1]", replacement: "Rewritten bullet B." },
    ],
    ["resume.experience[0].bullets[0]", "resume.experience[0].bullets[1]"]
  );
  assert.deepEqual(result.violations, []);
  assert.equal(result.resume.experience[0].bullets[0], "Rewritten bullet A.");
  assert.equal(result.resume.experience[0].bullets[1], "Rewritten bullet B.");
  assert.deepEqual(result.resume.experience[1], baselineResume().experience[1], "the untouched employer must be deep-equal to baseline");
});

test("summary-only repair reconstructs and freezes everything else", () => {
  const baseline = baselineResume();
  const result = reconstructFromPatchOperations(baseline, undefined, [{ document: "resume", path: "summary[0]", replacement: "New summary sentence." }], ["resume.summary[0]"]);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.resume.summary, ["New summary sentence."]);
  assert.deepEqual(result.resume.experience, baseline.experience);
  assert.deepEqual(result.resume.skillGroups, baseline.skillGroups);
});

test("18. untouched employer stays deep-equal to baseline after a patch touching only a different employer", () => {
  const baseline = baselineResume();
  const result = reconstructFromPatchOperations(baseline, undefined, [{ document: "resume", path: "experience[1].bullets[0]", replacement: "New Beta LLC bullet." }], ["resume.experience[1].bullets[0]"]);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.resume.experience[0], baseline.experience[0], "untouched Acme Corp entry must be byte-for-byte identical");
});

test("19. untouched bullet at the SAME employer stays deep-equal to baseline", () => {
  const baseline = baselineResume();
  const result = reconstructFromPatchOperations(baseline, undefined, [{ document: "resume", path: "experience[0].bullets[0]", replacement: "New bullet 0." }], ["resume.experience[0].bullets[0]", "resume.experience[0].bullets[1]"]);
  assert.deepEqual(result.violations, []);
  assert.equal(result.resume.experience[0].bullets[1], baseline.experience[0].bullets[1], "bullet 1 was editable but not patched — must stay unchanged");
});

test("22. an editable path with NO matching operation leaves the baseline value unchanged, never deleted", () => {
  const baseline = baselineResume();
  const result = reconstructFromPatchOperations(baseline, undefined, [{ document: "resume", path: "summary[0]", replacement: "Only the summary changed." }], ["resume.summary[0]", "resume.experience[0].bullets[0]"]);
  assert.deepEqual(result.violations, []);
  assert.equal(result.resume.experience[0].bullets[0], baseline.experience[0].bullets[0]);
});

test("5b. skillGroups replacement applies the whole array atomically", () => {
  const baseline = baselineResume();
  const newGroups = [{ label: "Cloud & Data Platforms", items: ["Azure Data Factory", "Databricks", "Delta Lake"] }];
  const result = reconstructFromPatchOperations(baseline, undefined, [{ document: "resume", path: "skillGroups", replacement: newGroups }], ["resume.skillGroups"]);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.resume.skillGroups, newGroups);
});

// --- reconstructFromPatchOperations: authorization / fail-closed ----------------------------------

test("9. a path not in editablePaths is rejected", () => {
  const result = reconstructFromPatchOperations(baselineResume(), undefined, [{ document: "resume", path: "experience[1].bullets[0]", replacement: "x" }], ["resume.experience[0].bullets[0]"]);
  assert.ok(result.violations.some((v) => v.includes("not in editablePaths")));
});

test("10. duplicate operations for the same path are rejected", () => {
  const result = reconstructFromPatchOperations(
    baselineResume(),
    undefined,
    [
      { document: "resume", path: "summary[0]", replacement: "A" },
      { document: "resume", path: "summary[0]", replacement: "B" },
    ],
    ["resume.summary[0]"]
  );
  assert.ok(result.violations.some((v) => v.includes("duplicate operation")));
});

test("11. conflicting/duplicate operations reject the WHOLE reconstruction, not just the second one", () => {
  const baseline = baselineResume();
  const result = reconstructFromPatchOperations(
    baseline,
    undefined,
    [
      { document: "resume", path: "experience[0].bullets[0]", replacement: "authorized change" },
      { document: "resume", path: "summary[0]", replacement: "A" },
      { document: "resume", path: "summary[0]", replacement: "B" },
    ],
    ["resume.experience[0].bullets[0]", "resume.summary[0]"]
  );
  assert.ok(result.violations.length > 0);
  assert.deepEqual(result.resume, baseline, "an authorized operation riding alongside a rejected one must not be partially applied");
});

test("12. parent-path escalation is rejected (whole employer object, not an authorized leaf)", () => {
  const result = reconstructFromPatchOperations(baselineResume(), undefined, [{ document: "resume", path: "experience[0]", replacement: {} }], ["resume.experience[0].bullets[0]"]);
  assert.ok(result.violations.some((v) => v.includes("not in editablePaths") || v.includes("wrong type")));
});

test("13. child-path escalation is rejected when only the parent-level path is safe/authorized", () => {
  // skillGroups is authorized as a whole array; a sub-path into it is a DIFFERENT path and must be
  // rejected rather than silently accepted as "close enough".
  const result = reconstructFromPatchOperations(baselineResume(), undefined, [{ document: "resume", path: "skillGroups[0].items[0]", replacement: "x" }], ["resume.skillGroups"]);
  assert.ok(result.violations.some((v) => v.includes("not in editablePaths")));
});

test("14. array append is impossible — a new bullet index beyond the authorized ones is rejected", () => {
  const result = reconstructFromPatchOperations(baselineResume(), undefined, [{ document: "resume", path: "experience[0].bullets[2]", replacement: "a new fourth bullet" }], ["resume.experience[0].bullets[0]"]);
  assert.ok(result.violations.some((v) => v.includes("not in editablePaths")));
});

test("15. array deletion is impossible — there is no delete operation kind, only replace", () => {
  // Proven structurally: RepairPatchOperation has no "delete"/"remove" operation kind at all, and
  // reconstructFromPatchOperations never shrinks an array — every replacement is a same-shape
  // setValueAt on an already-existing index. An operation with replacement: undefined is rejected as
  // the wrong type, never treated as "delete this element".
  const result = reconstructFromPatchOperations(baselineResume(), undefined, [{ document: "resume", path: "experience[0].bullets[0]", replacement: undefined }], ["resume.experience[0].bullets[0]"]);
  assert.ok(result.violations.some((v) => v.includes("wrong type")));
});

test("16. reorder is impossible — operations only ever set a value at a fixed index, never move one", () => {
  const baseline = baselineResume();
  const result = reconstructFromPatchOperations(
    baseline,
    undefined,
    [
      { document: "resume", path: "experience[0].bullets[0]", replacement: baseline.experience[0].bullets[1] },
      { document: "resume", path: "experience[0].bullets[1]", replacement: baseline.experience[0].bullets[0] },
    ],
    ["resume.experience[0].bullets[0]", "resume.experience[0].bullets[1]"]
  );
  // This is a content SWAP the writer explicitly authorized via two legitimate operations on two
  // legitimately editable paths — allowed, because nothing about array SHAPE changed (still 2
  // elements at the same indices) and every touched path was pre-authorized. What's structurally
  // impossible is an operation that inserts/removes/moves an element the allowlist never named.
  assert.deepEqual(result.violations, []);
  assert.equal(result.resume.experience[0].bullets.length, 2);
});

test("17. an employer/title/date change is impossible — those fields have no patch-safe path pattern at all", () => {
  assert.equal(isPatchEligibleRepairPlan(["resume.experience[0].company"]), false);
  assert.equal(isPatchEligibleRepairPlan(["resume.experience[0].dates"]), false);
  assert.equal(isPatchEligibleRepairPlan(["resume.experience[0].title"]), false);
});

test("20. malformed patch JSON (operations not an array) is rejected", () => {
  const result = reconstructFromPatchOperations(baselineResume(), undefined, "not an array" as unknown, ["resume.summary[0]"]);
  assert.ok(result.violations.some((v) => v.includes("must be an array")));
});

test("20b. a malformed individual operation (not an object) is rejected", () => {
  const result = reconstructFromPatchOperations(baselineResume(), undefined, ["not an object"], ["resume.summary[0]"]);
  assert.ok(result.violations.some((v) => v.includes("not an object")));
});

test("21. wrong replacement type (number for a string leaf) is rejected", () => {
  const result = reconstructFromPatchOperations(baselineResume(), undefined, [{ document: "resume", path: "summary[0]", replacement: 42 }], ["resume.summary[0]"]);
  assert.ok(result.violations.some((v) => v.includes("wrong type")));
});

test("21b. wrong replacement shape for skillGroups (array of strings instead of {label, items}) is rejected", () => {
  const result = reconstructFromPatchOperations(baselineResume(), undefined, [{ document: "resume", path: "skillGroups", replacement: ["Azure", "Databricks"] }], ["resume.skillGroups"]);
  assert.ok(result.violations.some((v) => v.includes("wrong type")));
});

test("an empty operations array is rejected rather than silently reconstructing to an unchanged baseline", () => {
  const result = reconstructFromPatchOperations(baselineResume(), undefined, [], ["resume.summary[0]"]);
  assert.ok(result.violations.some((v) => v.includes("must not be empty")));
});

test("an unsupported document value is rejected", () => {
  const result = reconstructFromPatchOperations(baselineResume(), undefined, [{ document: "somethingElse", path: "summary[0]", replacement: "x" }], ["resume.summary[0]"]);
  assert.ok(result.violations.some((v) => v.includes("unsupported document")));
});

test("8b. a coverLetter-document operation is always rejected by reconstructFromPatchOperations itself, independent of isPatchEligibleRepairPlan's own pre-filter", () => {
  const result = reconstructFromPatchOperations(baselineResume(), baselineCoverLetter(), [{ document: "coverLetter", path: "paragraphs[0]", replacement: "x" }], ["coverLetter.paragraphs[0]"]);
  assert.ok(result.violations.some((v) => v.includes("not patch-eligible")));
});

test("on any violation, the returned resume/coverLetter are the untouched baseline, never a partial reconstruction", () => {
  const baseline = baselineResume();
  const cover = baselineCoverLetter();
  const result = reconstructFromPatchOperations(
    baseline,
    cover,
    [
      { document: "resume", path: "experience[0].bullets[0]", replacement: "would have applied" },
      { document: "resume", path: "experience[9].bullets[0]", replacement: "unauthorized" },
    ],
    ["resume.experience[0].bullets[0]"]
  );
  assert.ok(result.violations.length > 0);
  assert.deepEqual(result.resume, baseline);
  assert.deepEqual(result.coverLetter, cover);
});
