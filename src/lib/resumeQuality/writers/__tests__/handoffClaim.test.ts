import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  claimHandoff,
  clearTechnicalFailures,
  getTechnicalFailureCount,
  isClaimStale,
  recordTechnicalFailure,
  releaseHandoffClaim,
} from "../handoffClaim";

/**
 * Pure filesystem tests — no database, no Claude CLI. Proves the atomic-claim mechanism itself:
 * duplicate protection, stale-claim (crash) recovery, and the technical-attempts sidecar counter.
 */

let tmpDir: string;

function definitelyDeadPid(): number {
  // A genuinely-exited process's pid — never reused within this short-lived test process's lifetime,
  // unlike a made-up large number which risks flakily colliding with a real running process.
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return result.pid ?? 999999;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-claim-"));
});

after(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("claim succeeds on an unclaimed handoff directory", () => {
  const dir = path.join(tmpDir, "wf-1");
  const claim = claimHandoff(dir);
  assert(claim);
  assert.equal(claim!.pid, process.pid);
  assert(fs.existsSync(path.join(dir, ".claim.json")));
  releaseHandoffClaim(dir);
});

test("duplicate claim of the same live handoff is blocked", () => {
  const dir = path.join(tmpDir, "wf-2");
  const first = claimHandoff(dir);
  assert(first);

  const second = claimHandoff(dir);
  assert.equal(second, null, "a second claim attempt while the first owner is still alive must be rejected");

  releaseHandoffClaim(dir);
});

test("stale claim (dead pid) is detected and reclaimed", async () => {
  const dir = path.join(tmpDir, "wf-3");
  fs.mkdirSync(dir, { recursive: true });
  const deadPid = definitelyDeadPid();
  fs.writeFileSync(
    path.join(dir, ".claim.json"),
    JSON.stringify({ pid: deadPid, hostname: "old-worker", startedAt: new Date(0).toISOString() })
  );

  assert.equal(isClaimStale(dir), true);

  const reclaimed = claimHandoff(dir);
  assert(reclaimed, "a stale (dead-pid) claim must be reclaimable");
  assert.equal(reclaimed!.pid, process.pid);

  releaseHandoffClaim(dir);
});

test("live claim (this process's own pid) is never considered stale", () => {
  const dir = path.join(tmpDir, "wf-4");
  const claim = claimHandoff(dir);
  assert(claim);
  assert.equal(isClaimStale(dir), false, "a claim owned by a still-running pid must not be treated as stale");
  releaseHandoffClaim(dir);
});

test("release only removes a claim owned by the current process", () => {
  const dir = path.join(tmpDir, "wf-5");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".claim.json"), JSON.stringify({ pid: 999999999, hostname: "someone-else", startedAt: new Date().toISOString() }));

  releaseHandoffClaim(dir);

  assert(fs.existsSync(path.join(dir, ".claim.json")), "releasing must never delete a claim owned by a different process");
});

test("release on a missing/already-released claim is a safe no-op", () => {
  const dir = path.join(tmpDir, "wf-6");
  assert.doesNotThrow(() => releaseHandoffClaim(dir));
});

test("technical-attempts sidecar: starts at zero, increments, and clears", () => {
  const dir = path.join(tmpDir, "wf-7");
  fs.mkdirSync(dir, { recursive: true });

  assert.equal(getTechnicalFailureCount(dir), 0);

  const first = recordTechnicalFailure(dir, "timeout");
  assert.equal(first, 1);
  assert.equal(getTechnicalFailureCount(dir), 1);

  const second = recordTechnicalFailure(dir, "malformed json");
  assert.equal(second, 2);
  assert.equal(getTechnicalFailureCount(dir), 2);

  clearTechnicalFailures(dir);
  assert.equal(getTechnicalFailureCount(dir), 0, "a successful pass must reset the technical-retry budget");
});
