import fs from "node:fs";
import path from "node:path";
import { generateCoverLetterDocx } from "./cover-letter-template";
import { generateResumeDocx } from "./resume-template";
import type { CoverLetterContent, ResumeContent } from "./types";
import { formatValidationReport, validateDocx } from "./validate-docx";
// Relative path back into the app's src/ — this is the same repo, just a different tree used by
// Claude Code's skill runner rather than the Next.js build, so a plain relative import is fine.
import { slugify } from "../../../../src/lib/slugify";

interface GenerateInput {
  company: string;
  jobId: string | number;
  resume: ResumeContent;
  coverLetter: CoverLetterContent;
}

/**
 * Fails fast with a specific, actionable message rather than rendering a document from
 * incomplete/malformed content — per the "never silently produce a questionable resume" rule.
 */
function validateInput(input: GenerateInput): string[] {
  const problems: string[] = [];
  if (!input.company?.trim()) problems.push("company is required");
  if (input.jobId === undefined || input.jobId === null || input.jobId === "") {
    problems.push("jobId is required");
  }

  const r = input.resume;
  if (!r) problems.push("resume is required");
  else {
    if (!r.name?.trim()) problems.push("resume.name is required");
    if (!r.email?.trim()) problems.push("resume.email is required");
    if (!r.summary || r.summary.length === 0) problems.push("resume.summary must have at least one paragraph");
    if (!r.skillGroups || r.skillGroups.length === 0) problems.push("resume.skillGroups must have at least one group");
    if (!r.experience || r.experience.length === 0) problems.push("resume.experience must have at least one role");
    r.experience?.forEach((role, i) => {
      if (!role.bullets || role.bullets.length === 0) {
        problems.push(`resume.experience[${i}] (${role.company || "?"}) has no bullets`);
      }
    });
    if (!r.education || r.education.length === 0) problems.push("resume.education must have at least one entry");
  }

  const c = input.coverLetter;
  if (!c) problems.push("coverLetter is required");
  else {
    if (!c.salutation?.trim()) problems.push("coverLetter.salutation is required");
    if (!c.paragraphs || c.paragraphs.length === 0) problems.push("coverLetter.paragraphs must have at least one paragraph");
  }

  return problems;
}

/**
 * CLI: npx tsx .claude/skills/tailor-resume/engine/generate.ts <content.json>
 * <content.json> is written by the tailoring skill itself with the fully rewritten, reordered
 * content — this script only renders it. Writes to data/generated/<company-slug>/<job-id>/.
 * Fails (non-zero exit) if input is incomplete or the rendered output fails layout validation —
 * never leaves a questionable document in place silently.
 */
async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: tsx generate.ts <content.json>");
    process.exit(1);
  }

  const input = JSON.parse(fs.readFileSync(inputPath, "utf-8")) as GenerateInput;

  const inputProblems = validateInput(input);
  if (inputProblems.length > 0) {
    console.error("Content JSON failed validation — fix these and re-run:");
    for (const p of inputProblems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const outDir = path.join(
    process.cwd(),
    "data",
    "generated",
    slugify(input.company),
    String(input.jobId)
  );

  const resumePath = path.join(outDir, "Resume.docx");
  const coverLetterPath = path.join(outDir, "CoverLetter.docx");

  await generateResumeDocx(input.resume, resumePath);
  await generateCoverLetterDocx(input.coverLetter, coverLetterPath);

  const resumeCheck = await validateDocx(resumePath, "resume");
  const coverLetterCheck = await validateDocx(coverLetterPath, "coverLetter");

  console.log(formatValidationReport("Resume.docx", resumeCheck));
  console.log(formatValidationReport("CoverLetter.docx", coverLetterCheck));

  if (!resumeCheck.valid || !coverLetterCheck.valid) {
    console.error("\nOutput failed layout validation — critical ATS-layout rule(s) violated. Not marking this run successful.");
    process.exit(1);
  }

  console.log(`\nWrote ${resumePath}`);
  console.log(`Wrote ${coverLetterPath}`);
}

main().catch((err) => {
  console.error("generate.ts failed:", err);
  process.exit(1);
});
