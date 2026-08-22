import fs from "node:fs";
import path from "node:path";
import { generateCoverLetterDocx } from "./cover-letter-template";
import { generateResumeDocx } from "./resume-template";
import type { CoverLetterContent, ResumeContent } from "./types";
import { formatValidationReport, validateDocx } from "./validate-docx";
// Relative path back into the app's src/ — this is the same repo, just a different tree used by
// the tailoring skill runner (Claude Code or Codex) rather than the Next.js build, so a plain
// relative import is fine. tools/tailoring-engine/ is two levels below the repo root.
import { slugify } from "../../src/lib/slugify";

export interface GenerateInput {
  company: string;
  jobId: string | number;
  resume: ResumeContent;
  coverLetter: CoverLetterContent;
  /** See resume-template.ts's GenerateResumeDocxOptions — the candidate's own Master Resume .docx,
   *  when the caller has resolved one (tailoringExecution.ts does, from a trusted candidateId; the
   *  legacy direct-CLI path below has no candidate identity to resolve one from, and simply omits
   *  it). Never part of the writer-produced content.json shape. */
  masterResumeDocxPath?: string;
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

export interface GenerateOptions {
  /** Phase 3 Stage 4: an explicit, already-validated directory (see
   *  src/lib/tailoringArtifacts.ts's resolveTailoringArtifactPaths) always wins when supplied. This
   *  generator does not itself decide the candidate/job/run storage hierarchy anymore — it only
   *  writes wherever it's told, trusting the caller to have resolved a safe path. Omitting it falls
   *  back to the legacy company+job-slug directory below, for backward compatibility with existing
   *  callers (the job detail UI's generatedFilesDir(), the tailor-resume skill invoked with no 2nd
   *  CLI arg) that don't yet know about candidate/run scoping. */
  outputDir?: string;
}

export interface GenerateResult {
  resumePath: string;
  coverLetterPath: string;
}

/**
 * Renders, validates, and writes both documents for one tailoring attempt. Throws (never exits the
 * process itself) on invalid input or a failed layout check, so it's safe to call directly as well
 * as from the CLI wrapper below — never leaves a questionable document in place silently.
 */
export async function generateTailoringOutputs(input: GenerateInput, options: GenerateOptions = {}): Promise<GenerateResult> {
  const inputProblems = validateInput(input);
  if (inputProblems.length > 0) {
    throw new Error(`Content JSON failed validation — fix these and re-run:\n${inputProblems.map((p) => `  - ${p}`).join("\n")}`);
  }

  // Legacy fallback: data/generated/<company-slug>/<job-id>/ — kept only for callers that haven't
  // been updated to pass an explicit, candidate/run-scoped outputDir yet (see GenerateOptions above).
  const outDir = options.outputDir
    ? path.resolve(options.outputDir)
    : path.join(process.cwd(), "data", "generated", slugify(input.company), String(input.jobId));

  const resumePath = path.join(outDir, "Resume.docx");
  const coverLetterPath = path.join(outDir, "CoverLetter.docx");

  await generateResumeDocx(input.resume, resumePath, { masterResumeDocxPath: input.masterResumeDocxPath });
  await generateCoverLetterDocx(input.coverLetter, coverLetterPath);

  const resumeCheck = await validateDocx(resumePath, "resume");
  const coverLetterCheck = await validateDocx(coverLetterPath, "coverLetter");

  console.log(formatValidationReport("Resume.docx", resumeCheck));
  console.log(formatValidationReport("CoverLetter.docx", coverLetterCheck));

  if (!resumeCheck.valid || !coverLetterCheck.valid) {
    throw new Error("Output failed layout validation — critical ATS-layout rule(s) violated. Not marking this run successful.");
  }

  return { resumePath, coverLetterPath };
}

/**
 * CLI: npx tsx tools/tailoring-engine/generate.ts <content.json> [outputDir]
 * <content.json> is written by the tailoring skill itself with the fully rewritten, reordered
 * content — this script only renders it. [outputDir] is optional; omitting it preserves the legacy
 * data/generated/<company-slug>/<job-id>/ behavior. Fails (non-zero exit) if input is incomplete or
 * the rendered output fails layout validation.
 */
async function main() {
  const inputPath = process.argv[2];
  const outputDirArg = process.argv[3];
  if (!inputPath) {
    console.error("Usage: tsx generate.ts <content.json> [outputDir]");
    process.exit(1);
  }

  const input = JSON.parse(fs.readFileSync(inputPath, "utf-8")) as GenerateInput;

  try {
    const { resumePath, coverLetterPath } = await generateTailoringOutputs(input, { outputDir: outputDirArg });
    console.log(`\nWrote ${resumePath}`);
    console.log(`Wrote ${coverLetterPath}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Only auto-run when executed directly (npx tsx generate.ts ...), not when imported as a module —
// lets tests import generateTailoringOutputs() without triggering a CLI run as a side effect.
const isDirectlyExecuted = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectlyExecuted) {
  main().catch((err) => {
    console.error("generate.ts failed:", err);
    process.exit(1);
  });
}
