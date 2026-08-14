import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * POST /api/scan lock-integration tests (Phase 4 Stage 1) — confirms the manual-scan route shares
 * the exact same lock primitive as the scheduler tick (src/lib/scheduler/lock.ts), returning 409
 * when the lock is already held rather than starting a second concurrent scan. Uses a company whose
 * scan attempt would be REJECTED before any real network call (an unsafe loopback career_page_url,
 * same technique as src/app/api/companies/__tests__/discoverCooldown.test.ts) so the "lock free"
 * case never actually reaches live network I/O — only the pre-scan lock gate is under test here.
 */

let tmpDir: string;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let acquireScanLock: typeof import("@/lib/scheduler/lock").acquireScanLock;
let releaseScanLock: typeof import("@/lib/scheduler/lock").releaseScanLock;
let resetScanLockForTests: typeof import("@/lib/scheduler/lock").resetScanLockForTests;
let POST: typeof import("../route").POST;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scan-route-lock-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db");
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ acquireScanLock, releaseScanLock, resetScanLockForTests } = await import("@/lib/scheduler/lock"));
  ({ POST } = await import("../route"));
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function postScan(body: Record<string, unknown> = {}) {
  const req = new Request("http://localhost/api/scan", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return POST(req as unknown as Parameters<typeof POST>[0]);
}

test("54. POST /api/scan with zero active companies short-circuits before ever acquiring the lock", async () => {
  // Runs first, before any createCompany() call in this file, so listActiveCompanies() is
  // genuinely empty — the route's companies.length === 0 branch (src/app/api/scan/route.ts) must
  // return before acquireScanLock is ever reached, confirmed by the lock still being free after.
  resetScanLockForTests();
  const res = await postScan();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.results, []);

  const stillFree = acquireScanLock(new Date());
  assert.equal(stillFree.acquired, true, "the lock must never have been touched by the zero-company short-circuit");
  releaseScanLock();
});

test("55. POST /api/scan returns 409 SCAN_ALREADY_RUNNING when the lock is already held", async () => {
  createCompany({ name: "Lock Test Co 1", source_type: "career_link", career_page_url: "http://127.0.0.1:1/co1" });
  resetScanLockForTests();
  const heldAt = acquireScanLock(new Date());

  try {
    const res = await postScan();
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "SCAN_ALREADY_RUNNING");
  } finally {
    releaseScanLock();
  }
  assert.equal(heldAt.acquired, true);
});

test("56. POST /api/scan releases the lock after completing (successfully or not), so a subsequent call can acquire it", async () => {
  createCompany({ name: "Lock Test Co 2", source_type: "career_link", career_page_url: "http://127.0.0.1:1/co2" });
  resetScanLockForTests();

  await postScan(); // company's unsafe URL causes the scan itself to fail/error internally, but the route must still release its lock

  const reacquire = acquireScanLock(new Date());
  assert.equal(reacquire.acquired, true, "the lock must be free again after the first POST /api/scan completed");
  releaseScanLock();
});
