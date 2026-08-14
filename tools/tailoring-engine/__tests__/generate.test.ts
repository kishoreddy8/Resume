import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FIXTURES } from "../fixtures/index";
import { generateTailoringOutputs, type GenerateInput } from "../generate";

const fixture = FIXTURES[0];

function baseInput(overrides: Partial<GenerateInput> = {}): GenerateInput {
  return {
    company: "Acme Corp",
    jobId: 101,
    resume: fixture.resume,
    coverLetter: fixture.coverLetter,
    ...overrides,
  };
}

test("generateTailoringOutputs: explicit outputDir wins — writes exactly there, not the legacy path", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-generate-explicit-"));
  try {
    const result = await generateTailoringOutputs(baseInput(), { outputDir: tmpDir });
    assert.equal(result.resumePath, path.join(tmpDir, "Resume.docx"));
    assert.equal(result.coverLetterPath, path.join(tmpDir, "CoverLetter.docx"));
    assert.ok(fs.existsSync(result.resumePath), "Resume.docx must actually be written to the explicit outputDir");
    assert.ok(fs.existsSync(result.coverLetterPath), "CoverLetter.docx must actually be written to the explicit outputDir");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("generateTailoringOutputs: legacy fallback — omitting outputDir writes to data/generated/<company-slug>/<jobId>/", async () => {
  const legacyRoot = path.join(process.cwd(), "data", "generated");
  const jobId = `legacy-fallback-test-${Date.now()}`;
  const expectedDir = path.join(legacyRoot, "acme-corp", jobId);
  try {
    const result = await generateTailoringOutputs(baseInput({ jobId }));
    assert.equal(result.resumePath, path.join(expectedDir, "Resume.docx"));
    assert.equal(result.coverLetterPath, path.join(expectedDir, "CoverLetter.docx"));
    assert.ok(fs.existsSync(result.resumePath), "legacy fallback path must still be written to for backward compatibility");
  } finally {
    fs.rmSync(expectedDir, { recursive: true, force: true });
  }
});

test("generateTailoringOutputs: output filenames are always the plain relative names, regardless of outputDir", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-generate-relnames-"));
  try {
    const result = await generateTailoringOutputs(baseInput(), { outputDir: tmpDir });
    assert.equal(path.basename(result.resumePath), "Resume.docx");
    assert.equal(path.basename(result.coverLetterPath), "CoverLetter.docx");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("generateTailoringOutputs: two separate outputDirs (two tailoring runs) never overwrite each other", async () => {
  const runDir1 = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-generate-run1-"));
  const runDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-generate-run2-"));
  try {
    const run1 = await generateTailoringOutputs(baseInput(), { outputDir: runDir1 });
    const run2 = await generateTailoringOutputs(baseInput(), { outputDir: runDir2 });

    assert.notEqual(run1.resumePath, run2.resumePath);
    assert.ok(fs.existsSync(run1.resumePath), "run 1's artifact must still exist after run 2 completes");
    assert.ok(fs.existsSync(run2.resumePath), "run 2's artifact must exist independently of run 1");

    const run1Bytes = fs.statSync(run1.resumePath).size;
    const run2Bytes = fs.statSync(run2.resumePath).size;
    assert.ok(run1Bytes > 0 && run2Bytes > 0, "neither file should have been truncated/emptied by the other run");
  } finally {
    fs.rmSync(runDir1, { recursive: true, force: true });
    fs.rmSync(runDir2, { recursive: true, force: true });
  }
});

test("generateTailoringOutputs: invalid content throws before writing anything (no partial output)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-generate-invalid-"));
  try {
    await assert.rejects(
      () => generateTailoringOutputs(baseInput({ resume: { ...fixture.resume, name: "" } }), { outputDir: tmpDir }),
      /resume\.name is required/
    );
    assert.deepEqual(fs.readdirSync(tmpDir), [], "no files should be written when input validation fails");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
