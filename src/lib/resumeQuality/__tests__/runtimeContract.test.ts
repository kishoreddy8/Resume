import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  assertResumeWriterRuntimeContract,
  ensureResumeWriterRuntimeContract,
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
