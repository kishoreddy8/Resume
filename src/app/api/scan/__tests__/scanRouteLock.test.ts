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
let tmpCandidatesDir: string;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let acquireScanLock: typeof import("@/lib/scheduler/lock").acquireScanLock;
let releaseScanLock: typeof import("@/lib/scheduler/lock").releaseScanLock;
let resetScanLockForTests: typeof import("@/lib/scheduler/lock").resetScanLockForTests;
let POST: typeof import("../route").POST;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scan-route-lock-test-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scan-route-lock-candidates-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;

  const { getDb } = await import("@/db");
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ acquireScanLock, releaseScanLock, resetScanLockForTests } = await import("@/lib/scheduler/lock"));
  ({ POST } = await import("../route"));
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  delete process.env.CAREER_OPS_CANDIDATES_DIR;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  } catch {}
});

function writeValidProfile(candidateId: number) {
  const dir = path.join(tmpCandidatesDir, String(candidateId));
  const masterDir = path.join(dir, "master");
  fs.mkdirSync(masterDir, { recursive: true });
  const resumeHash = `resume-${candidateId}`;
  const skillsHash = `skills-${candidateId}`;
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: resumeHash, skills: skillsHash },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [],
      experience: [],
      education: [],
      certifications: [],
      totalYearsExperience: null,
    })
  );
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: resumeHash },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: skillsHash },
    })
  );
}

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

test("93. POST /api/scan invokes the same shared incremental-matching path as the scheduler tick — response includes a populated matching key", async () => {
  const company = createCompany({ name: "Matching Manual Co", source_type: "greenhouse", ats_board_token: "manual-match-token" });
  const candidate = createCandidate({ firstName: "Manual", lastName: "Scan" });
  writeValidProfile(candidate.id);
  resetScanLockForTests();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        jobs: [
          {
            id: 1,
            title: "Data Engineer",
            location: { name: "Austin, TX" },
            departments: [{ name: "Engineering" }],
            absolute_url: "https://boards.greenhouse.io/manual-match-token/jobs/1",
            content: "<p>Job description.</p>",
            updated_at: new Date().toISOString(),
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;

  try {
    const res = await postScan({ companyId: company.id });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.jobsNew, 1, "existing ScanSummary fields stay flat at the top level for backward compatibility");
    assert.ok(body.matching, "the response includes the incremental matching summary");
    assert.equal(body.matching.jobsResolved, 1);
    assert.ok(body.notifications, "23. manual scan orchestration includes the notification-generation summary too");
    assert.equal(body.notifications.evaluated, body.matching.evaluatedPairs.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
