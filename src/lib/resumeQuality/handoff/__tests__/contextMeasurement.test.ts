import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareHandoffContext, measureHandoffContext } from "../contextMeasurement";

function makeFixtureDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-measure-"));
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
  }
  return dir;
}

test("a file writer_prompt.md never names is measured but marked not read by the writer", () => {
  const dir = makeFixtureDir({
    "writer_prompt.md": "Read `job_description.md` and `extracted_job_requirements.json` for context.",
    "job_description.md": "# Senior Data Engineer\nFull posting text.",
    "extracted_job_requirements.json": "[]",
    // Never named inside writer_prompt.md's text above — real files this package writes for
    // CareerOps's own bookkeeping, not for the writer to read.
    "writer_input.json": "{}",
    "workflow_status.json": "{}",
  });
  const result = measureHandoffContext(dir);

  const byName = new Map(result.files.map((f) => [f.filename, f]));
  assert.equal(byName.get("job_description.md")?.readByWriter, true);
  assert.equal(byName.get("extracted_job_requirements.json")?.readByWriter, true);
  assert.equal(byName.get("writer_prompt.md")?.readByWriter, true, "the prompt itself is always read");
  assert.equal(byName.get("writer_input.json")?.readByWriter, false);
  assert.equal(byName.get("workflow_status.json")?.readByWriter, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("writer_output.json is never counted as read context, even though it's named in the prompt's output schema", () => {
  const dir = makeFixtureDir({
    "writer_prompt.md": "Read `a.json`. When finished, create the file `writer_output.json` matching this schema: {...}",
    "a.json": "{}",
    // A prior iteration's real output, present on disk because this measures an already-completed
    // historical directory — must never be double-counted as if the writer read it as INPUT.
    "writer_output.json": "x".repeat(9999),
  });
  const result = measureHandoffContext(dir);
  const byName = new Map(result.files.map((f) => [f.filename, f]));
  assert.equal(byName.get("writer_output.json")?.readByWriter, false);
  assert.ok(result.totalReadBytes < 9999, "the large prior-output file must not inflate totalReadBytes");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("totalReadBytes only sums files the writer actually reads, never the whole package", () => {
  const dir = makeFixtureDir({
    "writer_prompt.md": "Read `a.md`.",
    "a.md": "x".repeat(100),
    "b.md": "y".repeat(9000), // never referenced — large bookkeeping file
  });
  const result = measureHandoffContext(dir);
  const promptBytes = fs.statSync(path.join(dir, "writer_prompt.md")).size;

  assert.equal(result.totalReadBytes, promptBytes + 100);
  assert.equal(result.totalPackageBytes, promptBytes + 100 + 9000);
  assert.ok(result.totalReadBytes < result.totalPackageBytes, "read total must be strictly smaller when an unread file exists");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("estimated token counts are always non-negative integers derived from real byte counts", () => {
  const dir = makeFixtureDir({
    "writer_prompt.md": "Read `a.json`.",
    "a.json": JSON.stringify({ hello: "world" }),
  });
  const result = measureHandoffContext(dir);

  for (const f of result.files) {
    assert.ok(Number.isInteger(f.estimatedTokens), `${f.filename} estimatedTokens must be an integer`);
    assert.ok(f.estimatedTokens >= 0, `${f.filename} estimatedTokens must never be negative`);
    assert.ok(f.bytes >= 0, `${f.filename} bytes must never be negative`);
  }
  assert.ok(result.totalReadEstimatedTokens >= 0);
  assert.ok(result.totalPackageEstimatedTokens >= 0);
  assert.ok(result.totalReadEstimatedTokens <= result.totalPackageEstimatedTokens);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("an empty/nonexistent handoff directory measures as all-zero, never throws", () => {
  const result = measureHandoffContext("/tmp/this-handoff-dir-does-not-exist-12345");
  assert.deepEqual(result.files, []);
  assert.equal(result.totalPackageBytes, 0);
  assert.equal(result.totalReadBytes, 0);
  assert.equal(result.totalPackageEstimatedTokens, 0);
  assert.equal(result.totalReadEstimatedTokens, 0);
});

test("section accounting is stable — measuring the same unchanged directory twice returns identical results", () => {
  const dir = makeFixtureDir({
    "writer_prompt.md": "Read `a.json` and `b.md`.",
    "a.json": "{}",
    "b.md": "content",
    "c.json": "unreferenced",
  });
  const first = measureHandoffContext(dir);
  const second = measureHandoffContext(dir);
  assert.deepEqual(first, second);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("compareHandoffContext computes a real before/after reduction from totalReadBytes only", () => {
  const beforeDir = makeFixtureDir({
    "writer_prompt.md": "Read `evidence.md`.",
    "evidence.md": "x".repeat(1000),
  });
  const afterDir = makeFixtureDir({
    "writer_prompt.md": "Read `evidence.md`.",
    "evidence.md": "x".repeat(400),
  });
  const before = measureHandoffContext(beforeDir);
  const after = measureHandoffContext(afterDir);
  const comparison = compareHandoffContext(before, after);

  assert.equal(comparison.beforeBytes, before.totalReadBytes);
  assert.equal(comparison.afterBytes, after.totalReadBytes);
  assert.equal(comparison.absoluteReductionBytes, before.totalReadBytes - after.totalReadBytes);
  assert.ok(comparison.absoluteReductionBytes > 0, "the fixture is deliberately smaller after");
  assert.ok(comparison.percentageReduction > 0 && comparison.percentageReduction <= 100);

  fs.rmSync(beforeDir, { recursive: true, force: true });
  fs.rmSync(afterDir, { recursive: true, force: true });
});

test("compareHandoffContext never divides by zero when the before measurement is empty", () => {
  const before = measureHandoffContext("/tmp/this-handoff-dir-does-not-exist-67890");
  const after = measureHandoffContext("/tmp/this-handoff-dir-does-not-exist-67890");
  const comparison = compareHandoffContext(before, after);
  assert.equal(comparison.percentageReduction, 0);
  assert.equal(comparison.absoluteReductionBytes, 0);
});

test("two materially different fixture shapes (INITIAL_GENERATION-like vs TARGETED_REPAIR-like) both measure correctly", () => {
  const initialGen = makeFixtureDir({
    "writer_prompt.md": "Read `job_description.md`, `master_resume_reference.json`, `master_skills_inventory.md`, `extracted_job_requirements.json`, `resume_tailoring_instructions.md`.",
    "job_description.md": "x".repeat(500),
    "master_resume_reference.json": "x".repeat(2000),
    "master_skills_inventory.md": "x".repeat(50),
    "extracted_job_requirements.json": "x".repeat(300),
    "resume_tailoring_instructions.md": "x".repeat(1500),
    "writer_input.json": "x".repeat(9999), // bookkeeping-only, must not inflate totalReadBytes
  });
  const targetedRepair = makeFixtureDir({
    "writer_prompt.md": "Read `master_resume_reference.json`, `master_skills_inventory.md`, `resume_tailoring_instructions.md`, `previous_resume_content.json`, `previous_cover_letter_content.json`.",
    "master_resume_reference.json": "x".repeat(2000),
    "master_skills_inventory.md": "x".repeat(50),
    "resume_tailoring_instructions.md": "x".repeat(1500),
    "previous_resume_content.json": "x".repeat(800),
    "previous_cover_letter_content.json": "x".repeat(200),
    "review.json": "x".repeat(9999), // bookkeeping-only
  });

  const initialResult = measureHandoffContext(initialGen);
  const repairResult = measureHandoffContext(targetedRepair);

  assert.ok(initialResult.totalReadBytes > 0);
  assert.ok(repairResult.totalReadBytes > 0);
  // Neither fixture's large bookkeeping-only file should count toward totalReadBytes.
  assert.ok(initialResult.totalReadBytes < initialResult.totalPackageBytes);
  assert.ok(repairResult.totalReadBytes < repairResult.totalPackageBytes);

  fs.rmSync(initialGen, { recursive: true, force: true });
  fs.rmSync(targetedRepair, { recursive: true, force: true });
});
