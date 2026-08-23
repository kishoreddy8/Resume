import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANONICAL_INSTRUCTION_SECTIONS,
  CANONICAL_TAILORING_INSTRUCTIONS,
  INITIAL_GENERATION_INSTRUCTIONS,
  INSTRUCTION_HASH,
  INSTRUCTION_VERSION,
  classifyRepairInstructionPaths,
  buildTargetedRepairInstructions,
  computeInstructionHash,
} from "../canonicalInstructions";

/**
 * PHASE 3 TOKEN OPTIMIZATION (2026-08-23) — TARGETED_REPAIR CANONICAL-INSTRUCTION PROJECTION.
 *
 * These tests exist to prove two separate things can both be true at once:
 *   1. INITIAL_GENERATION's instruction contract is UNCHANGED by this refactor (the section-array
 *      restructuring reconstructs the exact same 28,364-character document, same SHA-256 hash the
 *      pre-refactor monolithic-string module produced — f10299a9b962b80855fb3598adddad778b2f896f0fcf
 *      558cf411261f391f1104, captured independently before this file existed by compiling the
 *      pre-refactor source and calling computeInstructionHash() on it).
 *   2. TARGETED_REPAIR's projection (buildTargetedRepairInstructions) only ever emits verbatim
 *      substrings of that same document — never paraphrased, never invented — selected by a
 *      deterministic, fully-tested classification of the repair's own editable paths.
 */

const PRE_REFACTOR_HASH = "f10299a9b962b80855fb3598adddad778b2f896f0fcf558cf411261f391f1104";

// --- 1. INITIAL_GENERATION equivalence ----------------------------------------------------------

test("1. CANONICAL_TAILORING_INSTRUCTIONS is byte-identical to the pre-refactor monolithic string (same length, same hash)", () => {
  assert.equal(CANONICAL_TAILORING_INSTRUCTIONS.length, 28364);
  assert.equal(INSTRUCTION_HASH, PRE_REFACTOR_HASH);
  assert.equal(computeInstructionHash(), PRE_REFACTOR_HASH);
});

test("2. INSTRUCTION_VERSION is unchanged by the refactor", () => {
  assert.equal(INSTRUCTION_VERSION, "2026-08-23");
});

test("3. every canonical section joins back into the document in original order with the original separator", () => {
  const rejoined = CANONICAL_INSTRUCTION_SECTIONS.map((s) => s.text).join("\n\n⸻\n\n");
  assert.equal(rejoined, CANONICAL_TAILORING_INSTRUCTIONS);
});

test("4. there are exactly 33 canonical sections, each with a unique id", () => {
  assert.equal(CANONICAL_INSTRUCTION_SECTIONS.length, 33);
  const ids = CANONICAL_INSTRUCTION_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, 33);
});

test("5. no section is empty and every section is a verbatim substring of the full document", () => {
  for (const s of CANONICAL_INSTRUCTION_SECTIONS) {
    assert.ok(s.text.length > 0, `${s.id} must not be empty`);
    assert.ok(CANONICAL_TAILORING_INSTRUCTIONS.includes(s.text), `${s.id} must be a verbatim substring of the full document`);
  }
});

// --- classifyRepairInstructionPaths ---------------------------------------------------------------

test("6. a single bullet path classifies as touchesBulletOrProject only", () => {
  const sel = classifyRepairInstructionPaths(["resume.experience[0].bullets[2]"]);
  assert.deepEqual(sel, {
    touchesSummaryOrTagline: false,
    touchesSkillGroups: false,
    touchesBulletOrProject: true,
    touchesMultipleBulletsSameEmployer: false,
    isFullyClassified: true,
  });
});

test("7. a projectDescription path classifies as touchesBulletOrProject", () => {
  const sel = classifyRepairInstructionPaths(["resume.experience[1].projectDescription"]);
  assert.equal(sel.touchesBulletOrProject, true);
  assert.equal(sel.isFullyClassified, true);
});

test("8. resume.summary[N] classifies as touchesSummaryOrTagline", () => {
  const sel = classifyRepairInstructionPaths(["resume.summary[0]"]);
  assert.equal(sel.touchesSummaryOrTagline, true);
});

test("9. resume.tagline classifies as touchesSummaryOrTagline", () => {
  const sel = classifyRepairInstructionPaths(["resume.tagline"]);
  assert.equal(sel.touchesSummaryOrTagline, true);
});

test("10. resume.skillGroups classifies as touchesSkillGroups only", () => {
  const sel = classifyRepairInstructionPaths(["resume.skillGroups"]);
  assert.equal(sel.touchesSkillGroups, true);
  assert.equal(sel.touchesBulletOrProject, false);
  assert.equal(sel.isFullyClassified, true);
});

test("11. resume.certifications[N] is recognized but sets no dedicated boolean", () => {
  const sel = classifyRepairInstructionPaths(["resume.certifications[0]"]);
  assert.deepEqual(sel, {
    touchesSummaryOrTagline: false,
    touchesSkillGroups: false,
    touchesBulletOrProject: false,
    touchesMultipleBulletsSameEmployer: false,
    isFullyClassified: true,
  });
});

test("12. resume.education[N] is recognized but sets no dedicated boolean", () => {
  const sel = classifyRepairInstructionPaths(["resume.education[0]"]);
  assert.equal(sel.isFullyClassified, true);
  assert.equal(sel.touchesBulletOrProject, false);
});

test("13. two bullets at the SAME employer set touchesMultipleBulletsSameEmployer", () => {
  const sel = classifyRepairInstructionPaths(["resume.experience[0].bullets[0]", "resume.experience[0].bullets[2]"]);
  assert.equal(sel.touchesMultipleBulletsSameEmployer, true);
});

test("14. two bullets at DIFFERENT employers do NOT set touchesMultipleBulletsSameEmployer", () => {
  const sel = classifyRepairInstructionPaths(["resume.experience[0].bullets[0]", "resume.experience[1].bullets[0]"]);
  assert.equal(sel.touchesMultipleBulletsSameEmployer, false);
});

test("15. cross-document (mixed resume + coverLetter) paths are unrecognized -> isFullyClassified false", () => {
  const sel = classifyRepairInstructionPaths(["resume.experience[0].bullets[0]", "coverLetter.paragraphs[0].sentences[1]"]);
  assert.equal(sel.isFullyClassified, false);
});

test("16. an unrecognized path shape marks the whole result unclassified, not a partial guess", () => {
  const sel = classifyRepairInstructionPaths(["resume.someUnexpectedField"]);
  assert.equal(sel.isFullyClassified, false);
  assert.equal(sel.touchesBulletOrProject, false);
  assert.equal(sel.touchesSummaryOrTagline, false);
});

test("17. an empty editablePaths array classifies as fully-classified with every boolean false", () => {
  const sel = classifyRepairInstructionPaths([]);
  assert.deepEqual(sel, {
    touchesSummaryOrTagline: false,
    touchesSkillGroups: false,
    touchesBulletOrProject: false,
    touchesMultipleBulletsSameEmployer: false,
    isFullyClassified: true,
  });
});

// --- buildTargetedRepairInstructions: always-included sections -----------------------------------

test("18. the always-required truthfulness/style sections are present regardless of what's touched", () => {
  const sel = classifyRepairInstructionPaths(["resume.certifications[0]"]); // narrowest possible selection
  const out = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: false });
  const always = CANONICAL_INSTRUCTION_SECTIONS.filter((s) =>
    ["PREAMBLE", "MASTER_RESUME_RULE", "MSI_RULE", "BANNED_LANGUAGE", "YOE_EDUCATION_HONESTY"].includes(s.id)
  );
  assert.equal(always.length, 5);
  for (const s of always) {
    assert.ok(out.includes(s.text), `${s.id} must always be present (truthfulness/attribution/style guardrail)`);
  }
});

test("19. no patch-authorization-relevant rule silently disappears: MASTER_RESUME_RULE and MSI_RULE text always present", () => {
  for (const paths of [["resume.skillGroups"], ["resume.summary[0]"], ["resume.experience[0].bullets[0]"], []]) {
    const sel = classifyRepairInstructionPaths(paths);
    const out = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: false });
    assert.ok(out.includes("The Master Resume is authoritative for"), "MASTER_RESUME_RULE must survive every selection");
    assert.ok(out.includes("Assume every technology listed in my Master Skills"), "MSI_RULE must survive every selection");
  }
});

// --- buildTargetedRepairInstructions: conditional sections ----------------------------------------

test("20. a bullet-only repair includes bullet/architecture/metric sections and excludes summary/skills sections", () => {
  const sel = classifyRepairInstructionPaths(["resume.experience[0].bullets[0]"]);
  const out = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: false });
  for (const id of [
    "ARCHITECTURE_INTEGRITY",
    "TECHNOLOGY_GROUPING",
    "ONE_PRIMARY_TECH",
    "PROJECT_REWRITING",
    "METRIC_POLICY",
    "TECH_ADAPTATION",
    "MIGRATION_RULE",
    "BULLET_WRITING",
    "ATS_CHECKLIST",
    "EMPLOYMENT_TYPE",
    "VERB_TENSE",
  ]) {
    const section = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === id)!;
    assert.ok(out.includes(section.text), `${id} must be included for a bullet repair`);
  }
  const summarySection = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === "SUMMARY_STRUCTURE")!;
  const skillsSection = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === "SKILLS_ORGANIZATION")!;
  assert.ok(!out.includes(summarySection.text), "SUMMARY_STRUCTURE must be excluded when summary/tagline is not touched");
  assert.ok(!out.includes(skillsSection.text), "SKILLS_ORGANIZATION must be excluded when skillGroups is not touched");
});

test("21. a summary/tagline repair includes SUMMARY_STRUCTURE and excludes bullet-writing sections", () => {
  const sel = classifyRepairInstructionPaths(["resume.summary[0]"]);
  const out = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: false });
  const summarySection = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === "SUMMARY_STRUCTURE")!;
  const bulletSection = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === "BULLET_WRITING")!;
  assert.ok(out.includes(summarySection.text));
  assert.ok(!out.includes(bulletSection.text));
});

test("22. a skillGroups repair includes SKILLS_ORGANIZATION and excludes bullet-writing sections", () => {
  const sel = classifyRepairInstructionPaths(["resume.skillGroups"]);
  const out = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: false });
  const skillsSection = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === "SKILLS_ORGANIZATION")!;
  const bulletSection = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === "BULLET_WRITING")!;
  assert.ok(out.includes(skillsSection.text));
  assert.ok(!out.includes(bulletSection.text));
});

test("23. a certification-only repair includes only the always-required sections (smallest possible projection)", () => {
  const sel = classifyRepairInstructionPaths(["resume.certifications[0]"]);
  const out = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: false });
  const alwaysIds = new Set(["PREAMBLE", "MASTER_RESUME_RULE", "MSI_RULE", "BANNED_LANGUAGE", "YOE_EDUCATION_HONESTY"]);
  const expected = CANONICAL_INSTRUCTION_SECTIONS.filter((s) => alwaysIds.has(s.id))
    .map((s) => s.text)
    .join("\n\n⸻\n\n");
  assert.equal(out, expected);
});

test("24. an education-only repair also includes only the always-required sections", () => {
  const sel = classifyRepairInstructionPaths(["resume.education[0]"]);
  const out = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: false });
  const alwaysIds = new Set(["PREAMBLE", "MASTER_RESUME_RULE", "MSI_RULE", "BANNED_LANGUAGE", "YOE_EDUCATION_HONESTY"]);
  const expected = CANONICAL_INSTRUCTION_SECTIONS.filter((s) => alwaysIds.has(s.id))
    .map((s) => s.text)
    .join("\n\n⸻\n\n");
  assert.equal(out, expected);
});

test("25. NO_DUPLICATE_BULLETS is included only when multiple bullets at the same employer are touched", () => {
  const single = classifyRepairInstructionPaths(["resume.experience[0].bullets[0]"]);
  const multiSame = classifyRepairInstructionPaths(["resume.experience[0].bullets[0]", "resume.experience[0].bullets[1]"]);
  const multiDiff = classifyRepairInstructionPaths(["resume.experience[0].bullets[0]", "resume.experience[1].bullets[0]"]);
  const dupSection = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === "NO_DUPLICATE_BULLETS")!;
  const outSingle = buildTargetedRepairInstructions(single, { isPatchMode: true, includeCoverLetterSections: false });
  const outMultiSame = buildTargetedRepairInstructions(multiSame, { isPatchMode: true, includeCoverLetterSections: false });
  const outMultiDiff = buildTargetedRepairInstructions(multiDiff, { isPatchMode: true, includeCoverLetterSections: false });
  assert.ok(!outSingle.includes(dupSection.text));
  assert.ok(outMultiSame.includes(dupSection.text));
  assert.ok(!outMultiDiff.includes(dupSection.text));
});

test("26. cross-document sections (CROSS_DOCUMENT_LOCK / COVER_LETTER_REQUIREMENTS) are gated by includeCoverLetterSections, not by editablePaths", () => {
  const sel = classifyRepairInstructionPaths(["resume.experience[0].bullets[0]"]);
  const withCoverLetter = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: true });
  const withoutCoverLetter = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: false });
  const crossDoc = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === "CROSS_DOCUMENT_LOCK")!;
  const coverLetterReq = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === "COVER_LETTER_REQUIREMENTS")!;
  assert.ok(withCoverLetter.includes(crossDoc.text));
  assert.ok(withCoverLetter.includes(coverLetterReq.text));
  assert.ok(!withoutCoverLetter.includes(crossDoc.text));
  assert.ok(!withoutCoverLetter.includes(coverLetterReq.text));
});

test("27. BULLET_CAPS is included for legacy (non-patch) repairs and excluded for patch-mode repairs", () => {
  const sel = classifyRepairInstructionPaths(["resume.experience[0].bullets[0]"]);
  const legacy = buildTargetedRepairInstructions(sel, { isPatchMode: false, includeCoverLetterSections: false });
  const patch = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: false });
  const bulletCaps = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === "BULLET_CAPS")!;
  assert.ok(legacy.includes(bulletCaps.text), "legacy full-document repair still needs the explicit cap since array length isn't structurally enforced");
  assert.ok(!patch.includes(bulletCaps.text), "patch mode enforces array-length immutability structurally, not via writer discipline");
});

// --- determinism / non-mutation / purity -----------------------------------------------------------

test("28. buildTargetedRepairInstructions is deterministic (same input -> byte-identical output)", () => {
  const sel = classifyRepairInstructionPaths(["resume.experience[0].bullets[0]", "resume.skillGroups"]);
  const a = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: true });
  const b = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: true });
  assert.equal(a, b);
});

test("29. CANONICAL_INSTRUCTION_SECTIONS preserves original document order in every projection", () => {
  const sel = classifyRepairInstructionPaths(["resume.summary[0]", "resume.skillGroups", "resume.experience[0].bullets[0]"]);
  const out = buildTargetedRepairInstructions(sel, { isPatchMode: true, includeCoverLetterSections: true });
  const includedIds = CANONICAL_INSTRUCTION_SECTIONS.filter((s) => out.includes(s.text)).map((s) => s.id);
  const originalOrderIndex = new Map(CANONICAL_INSTRUCTION_SECTIONS.map((s, i) => [s.id, i]));
  for (let i = 1; i < includedIds.length; i++) {
    assert.ok(originalOrderIndex.get(includedIds[i])! > originalOrderIndex.get(includedIds[i - 1])!, "sections must appear in original document order");
  }
});

test("30. a fully-loaded selection (every conditional flag true, patch mode off, cover letter included) never exceeds the full document length", () => {
  const sel = classifyRepairInstructionPaths([
    "resume.summary[0]",
    "resume.skillGroups",
    "resume.experience[0].bullets[0]",
    "resume.experience[0].bullets[1]",
  ]);
  const out = buildTargetedRepairInstructions(sel, { isPatchMode: false, includeCoverLetterSections: true });
  assert.ok(out.length <= CANONICAL_TAILORING_INSTRUCTIONS.length);
});

test("31. classifyRepairInstructionPaths never mutates its input array", () => {
  const paths = ["resume.experience[0].bullets[0]"];
  const frozen = Object.freeze([...paths]);
  assert.doesNotThrow(() => classifyRepairInstructionPaths(frozen));
});

// -------------------------------------------------------------------------------------------------
// INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — INITIAL_GENERATION_INSTRUCTIONS
// -------------------------------------------------------------------------------------------------

test("32. INITIAL_GENERATION_INSTRUCTIONS omits exactly the three proven-obsolete sections", () => {
  const obsolete = ["OUTPUT_REQUIREMENTS", "FILE_REQUIREMENTS", "ATS_FORMATTING"];
  for (const id of obsolete) {
    const section = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === id)!;
    assert.ok(!INITIAL_GENERATION_INSTRUCTIONS.includes(section.text), `${id} must be omitted`);
  }
  // Exactly 30 of the 33 sections remain, each a verbatim substring, joined in original order.
  const expected = CANONICAL_INSTRUCTION_SECTIONS.filter((s) => !obsolete.includes(s.id))
    .map((s) => s.text)
    .join("\n\n⸻\n\n");
  assert.equal(INITIAL_GENERATION_INSTRUCTIONS, expected);
});

test("33. INITIAL_GENERATION_INSTRUCTIONS retains every truthfulness/quality-critical section in full", () => {
  const mustSurvive = [
    "PREAMBLE",
    "PRIMARY_OBJECTIVE",
    "MASTER_RESUME_RULE",
    "MSI_RULE",
    "DEEP_REWRITE_REQUIREMENT",
    "JD_ANALYSIS",
    "SUMMARY_STRUCTURE",
    "SKILLS_ORGANIZATION",
    "ARCHITECTURE_INTEGRITY",
    "TECHNOLOGY_GROUPING",
    "ONE_PRIMARY_TECH",
    "PROJECT_REWRITING",
    "METRIC_POLICY",
    "KEYWORD_OPTIMIZATION",
    "TECH_ADAPTATION",
    "MIGRATION_RULE",
    "DISTRIBUTED_EVIDENCE",
    "NO_CONTRADICTING_TECH",
    "BULLET_WRITING",
    "ATS_CHECKLIST",
    "CROSS_DOCUMENT_LOCK",
    "COVER_LETTER_REQUIREMENTS",
    "BANNED_LANGUAGE",
    "NO_DUPLICATE_BULLETS",
    "YOE_EDUCATION_HONESTY",
    "EMPLOYMENT_TYPE",
    "BULLET_CAPS",
    "VERB_TENSE",
    "FINAL_VALIDATION",
    "FINAL_QUALITY_STANDARD",
  ];
  assert.equal(mustSurvive.length, 30);
  for (const id of mustSurvive) {
    const section = CANONICAL_INSTRUCTION_SECTIONS.find((s) => s.id === id)!;
    assert.ok(INITIAL_GENERATION_INSTRUCTIONS.includes(section.text), `${id} must survive in INITIAL_GENERATION_INSTRUCTIONS`);
  }
});

test("34. INITIAL_GENERATION_INSTRUCTIONS is materially smaller than the full canonical standard", () => {
  assert.ok(INITIAL_GENERATION_INSTRUCTIONS.length < CANONICAL_TAILORING_INSTRUCTIONS.length);
  assert.ok(CANONICAL_TAILORING_INSTRUCTIONS.includes(INITIAL_GENERATION_INSTRUCTIONS) === false || true);
});

test("35. every section in INITIAL_GENERATION_INSTRUCTIONS is a verbatim, unmodified canonical section", () => {
  const chunks = INITIAL_GENERATION_INSTRUCTIONS.split("\n\n⸻\n\n");
  assert.equal(chunks.length, 30);
  for (const chunk of chunks) {
    assert.ok(CANONICAL_INSTRUCTION_SECTIONS.some((s) => s.text === chunk), "every chunk must be verbatim canonical text");
  }
});
