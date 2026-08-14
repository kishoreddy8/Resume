import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { GENERATED_ROOT } from "@/lib/generatedFiles";
import { getTailoringArtifactDirectory, hashJobIdentity, resolveTailoringArtifactPaths } from "@/lib/tailoringArtifacts";

test("hashJobIdentity: same dedupe_key always produces the same hash", () => {
  const key = "greenhouse:1:senior-data-engineer";
  assert.equal(hashJobIdentity(key), hashJobIdentity(key));
});

test("hashJobIdentity: different dedupe_keys produce different hashes", () => {
  assert.notEqual(hashJobIdentity("greenhouse:1:role-a"), hashJobIdentity("greenhouse:1:role-b"));
  assert.notEqual(hashJobIdentity("greenhouse:1:role-a"), hashJobIdentity("greenhouse:2:role-a"));
});

test("hashJobIdentity: result is filesystem-safe (lowercase hex only, fixed length)", () => {
  const hash = hashJobIdentity("workday:42:career_link:https://example.com/job/weird?query=1&x=2");
  assert.match(hash, /^[0-9a-f]{16}$/, "must be exactly 16 lowercase hex characters, safe as a single path segment");
});

test("hashJobIdentity: rejects an empty or missing dedupe_key rather than hashing garbage", () => {
  assert.throws(() => hashJobIdentity(""), /non-empty string/);
  assert.throws(() => hashJobIdentity("   "), /non-empty string/);
});

test("hashJobIdentity: never leaks the raw dedupe_key into the hash output", () => {
  const key = "greenhouse:1:super-secret-internal-req-id-99999";
  const hash = hashJobIdentity(key);
  assert.ok(!hash.includes("greenhouse"), "hash must not contain any substring of the raw dedupe_key");
  assert.ok(!hash.includes("99999"));
});

test("getTailoringArtifactDirectory: candidate isolation — same job/run, different candidateId, different directory", () => {
  const dedupeKey = "greenhouse:1:shared-job";
  const dirA = getTailoringArtifactDirectory({ candidateId: 1, dedupeKey, runId: 1 });
  const dirB = getTailoringArtifactDirectory({ candidateId: 2, dedupeKey, runId: 1 });
  assert.notEqual(dirA, dirB);
});

test("getTailoringArtifactDirectory: job isolation — same candidate/run, different dedupeKey, different directory", () => {
  const dirX = getTailoringArtifactDirectory({ candidateId: 1, dedupeKey: "greenhouse:1:job-x", runId: 1 });
  const dirY = getTailoringArtifactDirectory({ candidateId: 1, dedupeKey: "greenhouse:1:job-y", runId: 1 });
  assert.notEqual(dirX, dirY);
});

test("getTailoringArtifactDirectory: run isolation — same candidate/job, different runId, different directory", () => {
  const dedupeKey = "greenhouse:1:shared-job";
  const run1 = getTailoringArtifactDirectory({ candidateId: 1, dedupeKey, runId: 1 });
  const run2 = getTailoringArtifactDirectory({ candidateId: 1, dedupeKey, runId: 2 });
  assert.notEqual(run1, run2);
});

test("getTailoringArtifactDirectory: identical inputs always resolve to the identical directory (deterministic)", () => {
  const location = { candidateId: 1, dedupeKey: "greenhouse:1:shared-job", runId: 1 };
  assert.equal(getTailoringArtifactDirectory(location), getTailoringArtifactDirectory(location));
});

test("getTailoringArtifactDirectory: resolved path always stays inside the generated-artifact root", () => {
  const dir = getTailoringArtifactDirectory({ candidateId: 7, dedupeKey: "workday:9:role", runId: 3 });
  const resolvedRoot = path.resolve(GENERATED_ROOT) + path.sep;
  assert.ok(path.resolve(dir).startsWith(resolvedRoot), `expected ${dir} to be inside ${resolvedRoot}`);
  assert.match(dir, /^.*\/candidates\/7\/jobs\/[0-9a-f]{16}\/runs\/3$/);
});

test("getTailoringArtifactDirectory: rejects non-positive-integer candidateId", () => {
  const dedupeKey = "greenhouse:1:job";
  assert.throws(() => getTailoringArtifactDirectory({ candidateId: 0, dedupeKey, runId: 1 }), /Invalid candidateId/);
  assert.throws(() => getTailoringArtifactDirectory({ candidateId: -1, dedupeKey, runId: 1 }), /Invalid candidateId/);
  assert.throws(() => getTailoringArtifactDirectory({ candidateId: 1.5, dedupeKey, runId: 1 }), /Invalid candidateId/);
});

test("getTailoringArtifactDirectory: rejects non-positive-integer runId", () => {
  const dedupeKey = "greenhouse:1:job";
  assert.throws(() => getTailoringArtifactDirectory({ candidateId: 1, dedupeKey, runId: 0 }), /Invalid runId/);
  assert.throws(() => getTailoringArtifactDirectory({ candidateId: 1, dedupeKey, runId: -3 }), /Invalid runId/);
});

test("getTailoringArtifactDirectory: rejects an empty dedupeKey", () => {
  assert.throws(() => getTailoringArtifactDirectory({ candidateId: 1, dedupeKey: "", runId: 1 }), /Invalid dedupeKey/);
});

test("getTailoringArtifactDirectory: candidateId/runId cannot be used to inject path traversal — numeric coercion, not string concatenation, so '../' style attacks are structurally rejected", () => {
  // TypeScript's type system already blocks passing a string here in real callers; this test proves
  // the runtime guard also rejects it if a caller bypasses the type system (e.g. via `as any`, or a
  // value that arrived as an unvalidated string from an upstream source).
  assert.throws(
    () => getTailoringArtifactDirectory({ candidateId: "../../etc" as unknown as number, dedupeKey: "greenhouse:1:job", runId: 1 }),
    /Invalid candidateId/
  );
});

test("resolveTailoringArtifactPaths: returns Resume.docx/CoverLetter.docx as relative filenames within the run directory", () => {
  const paths = resolveTailoringArtifactPaths({ candidateId: 1, dedupeKey: "greenhouse:1:job", runId: 1 });
  assert.equal(path.basename(paths.resumePath), "Resume.docx");
  assert.equal(path.basename(paths.coverLetterPath), "CoverLetter.docx");
  assert.equal(path.dirname(paths.resumePath), paths.dir);
  assert.equal(path.dirname(paths.coverLetterPath), paths.dir);
});

test("resolveTailoringArtifactPaths: candidate 1/job X/run 1 vs candidate 2/job X/run 1 are fully isolated directories", () => {
  const dedupeKey = "workday:5:job-x";
  const a = resolveTailoringArtifactPaths({ candidateId: 1, dedupeKey, runId: 1 });
  const b = resolveTailoringArtifactPaths({ candidateId: 2, dedupeKey, runId: 1 });
  assert.notEqual(a.dir, b.dir);
  assert.notEqual(a.resumePath, b.resumePath);
});

test("resolveTailoringArtifactPaths: candidate 1/job X/run 1 vs candidate 1/job X/run 2 never overwrite each other", () => {
  const dedupeKey = "workday:5:job-x";
  const run1 = resolveTailoringArtifactPaths({ candidateId: 1, dedupeKey, runId: 1 });
  const run2 = resolveTailoringArtifactPaths({ candidateId: 1, dedupeKey, runId: 2 });
  assert.notEqual(run1.resumePath, run2.resumePath);
  assert.notEqual(run1.coverLetterPath, run2.coverLetterPath);
});

test("resolveTailoringArtifactPaths: candidate 1/job X/run 1 vs candidate 1/job Y/run 1 are isolated by job identity hash", () => {
  const a = resolveTailoringArtifactPaths({ candidateId: 1, dedupeKey: "workday:5:job-x", runId: 1 });
  const b = resolveTailoringArtifactPaths({ candidateId: 1, dedupeKey: "workday:5:job-y", runId: 1 });
  assert.notEqual(a.dir, b.dir);
});
