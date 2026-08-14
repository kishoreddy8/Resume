import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpGeneratedDir: string;

let getQualityWorkflowDirectory: typeof import("../workspace").getQualityWorkflowDirectory;
let getWorkspaceDirectory: typeof import("../workspace").getWorkspaceDirectory;
let getIterationDirectory: typeof import("../workspace").getIterationDirectory;
let getFinalDirectory: typeof import("../workspace").getFinalDirectory;
let finalResumeFilename: typeof import("../workspace").finalResumeFilename;
let finalCoverLetterFilename: typeof import("../workspace").finalCoverLetterFilename;
let getTailoringArtifactDirectory: typeof import("@/lib/tailoringArtifacts").getTailoringArtifactDirectory;

before(async () => {
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-quality-workspace-"));
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  ({ getQualityWorkflowDirectory, getWorkspaceDirectory, getIterationDirectory, getFinalDirectory, finalResumeFilename, finalCoverLetterFilename } =
    await import("../workspace"));
  ({ getTailoringArtifactDirectory } = await import("@/lib/tailoringArtifacts"));
});

after(() => {
  fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
  delete process.env.CAREER_OPS_GENERATED_DIR;
});

const dedupeKeyX = "greenhouse:1:job-x";
const dedupeKeyY = "greenhouse:1:job-y";

test("the quality workflow directory nests under Stage 4's own run directory, not a competing root", () => {
  const runDir = getTailoringArtifactDirectory({ candidateId: 1, dedupeKey: dedupeKeyX, runId: 1 });
  const qualityDir = getQualityWorkflowDirectory({ candidateId: 1, dedupeKey: dedupeKeyX, runId: 1, workflowId: 1 });
  assert.ok(qualityDir.startsWith(runDir + path.sep), `${qualityDir} must be nested under ${runDir}`);
  assert.equal(qualityDir, path.join(runDir, "quality", "1"));
});

test("workspace/iterations/final all nest under the same quality workflow directory", () => {
  const location = { candidateId: 1, dedupeKey: dedupeKeyX, runId: 1, workflowId: 1 };
  const base = getQualityWorkflowDirectory(location);
  assert.equal(getWorkspaceDirectory(location), path.join(base, "workspace"));
  assert.equal(getIterationDirectory(location, 1), path.join(base, "iterations", "1"));
  assert.equal(getFinalDirectory(location), path.join(base, "final"));
});

test("candidate isolation: candidate 1 and candidate 2, same job/run/workflow numbers, resolve to different directories", () => {
  const dirA = getQualityWorkflowDirectory({ candidateId: 1, dedupeKey: dedupeKeyX, runId: 1, workflowId: 1 });
  const dirB = getQualityWorkflowDirectory({ candidateId: 2, dedupeKey: dedupeKeyX, runId: 1, workflowId: 1 });
  assert.notEqual(dirA, dirB);
});

test("job isolation: different dedupe_key values resolve to different directories, and the raw dedupe_key never appears in the path", () => {
  const dirX = getQualityWorkflowDirectory({ candidateId: 1, dedupeKey: dedupeKeyX, runId: 1, workflowId: 1 });
  const dirY = getQualityWorkflowDirectory({ candidateId: 1, dedupeKey: dedupeKeyY, runId: 1, workflowId: 1 });
  assert.notEqual(dirX, dirY);
  assert.ok(!dirX.includes(dedupeKeyX), "the raw dedupe_key must never appear in the resolved path");
  assert.ok(!dirX.includes("job-x"));
});

test("run isolation: different runId values resolve to different quality-workflow directories", () => {
  const run1 = getQualityWorkflowDirectory({ candidateId: 1, dedupeKey: dedupeKeyX, runId: 1, workflowId: 1 });
  const run2 = getQualityWorkflowDirectory({ candidateId: 1, dedupeKey: dedupeKeyX, runId: 2, workflowId: 1 });
  assert.notEqual(run1, run2);
});

test("workflow isolation: different workflowId values (e.g. re-running the pipeline against the same run) resolve to different directories", () => {
  const wf1 = getQualityWorkflowDirectory({ candidateId: 1, dedupeKey: dedupeKeyX, runId: 1, workflowId: 1 });
  const wf2 = getQualityWorkflowDirectory({ candidateId: 1, dedupeKey: dedupeKeyX, runId: 1, workflowId: 2 });
  assert.notEqual(wf1, wf2);
});

test("iteration isolation: different iteration numbers resolve to different directories, never overwriting each other", () => {
  const location = { candidateId: 1, dedupeKey: dedupeKeyX, runId: 1, workflowId: 1 };
  const iter1 = getIterationDirectory(location, 1);
  const iter2 = getIterationDirectory(location, 2);
  const iter3 = getIterationDirectory(location, 3);
  assert.notEqual(iter1, iter2);
  assert.notEqual(iter2, iter3);
  assert.notEqual(iter1, iter3);
});

test("workflowId must be a positive integer — rejects zero, negative, and non-integer values", () => {
  const base = { candidateId: 1, dedupeKey: dedupeKeyX, runId: 1 };
  assert.throws(() => getQualityWorkflowDirectory({ ...base, workflowId: 0 }), /Invalid workflowId/);
  assert.throws(() => getQualityWorkflowDirectory({ ...base, workflowId: -1 }), /Invalid workflowId/);
  assert.throws(() => getQualityWorkflowDirectory({ ...base, workflowId: 1.5 }), /Invalid workflowId/);
});

test("iterationNumber must be a positive integer — rejects zero, negative, and non-integer values (traversal-adjacent inputs structurally rejected)", () => {
  const location = { candidateId: 1, dedupeKey: dedupeKeyX, runId: 1, workflowId: 1 };
  assert.throws(() => getIterationDirectory(location, 0), /Invalid iterationNumber/);
  assert.throws(() => getIterationDirectory(location, -1), /Invalid iterationNumber/);
  assert.throws(() => getIterationDirectory(location, 1.5), /Invalid iterationNumber/);
});

test("every resolved path stays inside the generated-artifact root (inherited from Stage 4's own assertion)", () => {
  const dir = getFinalDirectory({ candidateId: 3, dedupeKey: dedupeKeyX, runId: 4, workflowId: 5 });
  const resolvedRoot = path.resolve(tmpGeneratedDir) + path.sep;
  assert.ok(path.resolve(dir).startsWith(resolvedRoot));
});

test("finalResumeFilename/finalCoverLetterFilename sanitize the candidate's first name to a safe single path segment", () => {
  assert.equal(finalResumeFilename("Saikishore"), "Saikishore_Resume.docx");
  assert.equal(finalCoverLetterFilename("Saikishore"), "Saikishore_CoverLetter.docx");
});

test("filename sanitization strips spaces, punctuation, and path-unsafe characters", () => {
  assert.equal(finalResumeFilename("Mary Jane"), "MaryJane_Resume.docx");
  assert.equal(finalResumeFilename("O'Brien"), "OBrien_Resume.docx");
  assert.equal(finalResumeFilename("../../etc/passwd"), "etcpasswd_Resume.docx");
  assert.ok(!finalResumeFilename("../../etc/passwd").includes("/"));
  assert.ok(!finalResumeFilename("../../etc/passwd").includes(".."));
});

test("filename sanitization never produces an empty filename — falls back to a safe default", () => {
  assert.equal(finalResumeFilename(""), "Candidate_Resume.docx");
  assert.equal(finalResumeFilename("!!!"), "Candidate_Resume.docx");
  assert.equal(finalResumeFilename("   "), "Candidate_Resume.docx");
});

test("finalResumeFilename never hardcodes any specific candidate name globally — it is always derived from the argument", () => {
  assert.notEqual(finalResumeFilename("Alex"), finalResumeFilename("Jordan"));
  assert.ok(!finalResumeFilename("Alex").toLowerCase().includes("saikishore"));
});
