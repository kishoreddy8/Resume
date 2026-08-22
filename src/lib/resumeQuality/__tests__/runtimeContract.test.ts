import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  assertResumeWriterRuntimeContract,
  ensureResumeWriterRuntimeContract,
  evaluateRuntimeFreshness,
  readResumeWriterRuntimeContract,
  ResumeWriterRuntimeMismatchError,
  type ResumeWriterRuntimeContract,
} from "../runtimeContract";

const tempDirectories: string[] = [];

function tempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-runtime-contract-"));
  tempDirectories.push(dir);
  return dir;
}

function contract(overrides: Partial<ResumeWriterRuntimeContract> = {}): ResumeWriterRuntimeContract {
  return {
    schemaVersion: 1,
    contractVersion: "surgical-repair-v1",
    sourceRevision: "revision-a",
    loadedAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

test("runtime contract is immutable and a matching worker may read it", () => {
  const workspace = tempWorkspace();
  const expected = contract();
  assert.deepEqual(ensureResumeWriterRuntimeContract(workspace, { runtime: expected }), expected);
  assert.deepEqual(assertResumeWriterRuntimeContract(workspace, expected), expected);
  assert.deepEqual(readResumeWriterRuntimeContract(workspace), expected);
});

test("contract-version skew fails closed with an operational error", () => {
  const workspace = tempWorkspace();
  ensureResumeWriterRuntimeContract(workspace, { runtime: contract() });
  assert.throws(
    () => assertResumeWriterRuntimeContract(workspace, contract({ contractVersion: "future-v2" })),
    (error: unknown) =>
      error instanceof ResumeWriterRuntimeMismatchError &&
      error.code === "RUNTIME_VERSION_MISMATCH" &&
      error.message.includes("workflow contract surgical-repair-v1 does not match worker contract future-v2")
  );
});

test("source-revision skew fails closed and never replaces the producer stamp", () => {
  const workspace = tempWorkspace();
  const producer = contract();
  ensureResumeWriterRuntimeContract(workspace, { runtime: producer });
  assert.throws(
    () => ensureResumeWriterRuntimeContract(workspace, { runtime: contract({ sourceRevision: "revision-b" }) }),
    ResumeWriterRuntimeMismatchError
  );
  assert.deepEqual(readResumeWriterRuntimeContract(workspace), producer);
});

test("invalid existing fingerprints are rejected rather than silently adopted", () => {
  const workspace = tempWorkspace();
  fs.writeFileSync(path.join(workspace, "runtime_contract.json"), "{ invalid json");
  assert.throws(() => ensureResumeWriterRuntimeContract(workspace, { runtime: contract() }), ResumeWriterRuntimeMismatchError);
});

// --- Phase K: advisory runtime freshness (never a substitute for the assertions above) --------------

test("Phase K: matching loaded and observed revisions report CURRENT", () => {
  const result = evaluateRuntimeFreshness({ sourceRevision: "abc123" }, { revision: "abc123", observedAt: "2026-08-22T00:00:00.000Z" });
  assert.equal(result.state, "CURRENT");
  assert.equal(result.loadedRevision, "abc123");
  assert.equal(result.observedRevision, "abc123");
});

test("Phase K: a loaded revision behind the currently checked-out one reports STALE_PROCESS with a restart instruction", () => {
  const result = evaluateRuntimeFreshness({ sourceRevision: "old111" }, { revision: "new222", observedAt: "2026-08-22T00:00:00.000Z" });
  assert.equal(result.state, "STALE_PROCESS");
  assert.match(result.detail, /[Rr]estart/);
  assert.equal(result.loadedRevision, "old111");
  assert.equal(result.observedRevision, "new222");
});

test("Phase K: an undeterminable revision on either side reports UNKNOWN, never guesses CURRENT or STALE_PROCESS", () => {
  const loadedUnknown = evaluateRuntimeFreshness({ sourceRevision: "unknown" }, { revision: "new222", observedAt: "2026-08-22T00:00:00.000Z" });
  assert.equal(loadedUnknown.state, "UNKNOWN");
  const observedUnknown = evaluateRuntimeFreshness({ sourceRevision: "abc123" }, { revision: "unknown", observedAt: "2026-08-22T00:00:00.000Z" });
  assert.equal(observedUnknown.state, "UNKNOWN");
});

test("Phase K: freshness evaluation is purely advisory data — it exposes no capability to bypass assertResumeWriterRuntimeContract", () => {
  // Structural guard: evaluateRuntimeFreshness must never be able to affect the real per-workflow
  // enforcement — proven by construction, since it takes only plain data and returns only plain
  // data, with no reference to a workspace directory or the assert/ensure functions above.
  const result = evaluateRuntimeFreshness({ sourceRevision: "abc123" }, { revision: "def456", observedAt: "2026-08-22T00:00:00.000Z" });
  assert.equal(typeof result, "object");
  assert.equal("workspaceDirectory" in result, false);
});
