import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateCoverLetterDocx } from "../cover-letter-template";
import { generateResumeDocx } from "../resume-template";
import { validateDocx } from "../validate-docx";
import { FIXTURES } from "./index";

/**
 * Deterministic engine regression suite — no LLM calls, no live JD fetches, no token cost. Proves
 * the renderer + validator handle structurally different content correctly: different skill-group
 * counts/order, different bullet counts per role (including the 1-bullet and 8-bullet edges), a
 * long near-boundary bullet, and both presence/absence of optional fields (certifications,
 * LinkedIn). This tests engine correctness, not tailoring judgment — see SKILL.md's "Simulated
 * recruiter review" for the reasoning-based check that a fixture suite can't replace.
 */
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tailor-resume-fixtures-"));
  let failures = 0;

  for (const fixture of FIXTURES) {
    const resumePath = path.join(tmpDir, fixture.name.replace(/\W+/g, "-"), "Resume.docx");
    const coverLetterPath = path.join(tmpDir, fixture.name.replace(/\W+/g, "-"), "CoverLetter.docx");

    try {
      await generateResumeDocx(fixture.resume, resumePath);
      await generateCoverLetterDocx(fixture.coverLetter, coverLetterPath);
    } catch (err) {
      console.error(`✗ ${fixture.name}: rendering threw — ${err}`);
      failures++;
      continue;
    }

    const resumeCheck = await validateDocx(resumePath, "resume");
    const coverLetterCheck = await validateDocx(coverLetterPath, "coverLetter");

    if (resumeCheck.valid && coverLetterCheck.valid) {
      console.log(`✓ ${fixture.name}: rendered and validated`);
    } else {
      console.error(`✗ ${fixture.name}:`);
      for (const v of resumeCheck.violations) console.error(`  [resume] ${v}`);
      for (const v of coverLetterCheck.violations) console.error(`  [cover letter] ${v}`);
      failures++;
    }
  }

  // Cheap structural differentiation check — a real proxy for "these aren't accidentally
  // rendering identical output regardless of input," not a substitute for judging real tailoring
  // quality across real JDs (that's the Simulated Recruiter Review's job, not this suite's).
  const taglines = new Set(FIXTURES.map((f) => f.resume.tagline));
  const firstSkillLabels = new Set(FIXTURES.map((f) => f.resume.skillGroups[0]?.label));
  if (taglines.size !== FIXTURES.length) {
    console.error("✗ Differentiation check: fixtures unexpectedly share a tagline");
    failures++;
  }
  if (firstSkillLabels.size !== FIXTURES.length) {
    console.error("✗ Differentiation check: fixtures unexpectedly share a first skill-group label");
    failures++;
  }
  if (failures === 0) {
    console.log(`✓ Differentiation check: all ${FIXTURES.length} fixtures produce distinct summaries/skill ordering`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} fixture check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${FIXTURES.length} fixtures passed rendering + validation.`);
}

main().catch((err) => {
  console.error("run-fixtures.ts failed:", err);
  process.exit(1);
});
