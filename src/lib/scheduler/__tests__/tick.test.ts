import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/**
 * Scheduler tick orchestration tests. Deliberately do NOT exercise the "RAN" outcome against a real
 * scan — per the explicit Stage 1 constraint ("Do NOT run production scans... No production data
 * mutations are authorized in Stage 1"), and because runScan()/scanCompany() itself is already
 * covered by src/db/queries/__tests__/scanReliability.test.ts and friends; forking or re-mocking
 * that engine here would violate the "zero forking, reuse the existing engine" requirement. This
 * file starts from a fresh, empty test DB, so listScanReadyCompanies() always returns zero
 * companies — the SKIPPED_NO_COMPANIES path exercises the FULL orchestration sequence (settings
 * read, enabled/window/interval checks, lock acquire, state-started write, company selection,
 * state-succeeded write, lock release) with the one exception of the actual runScan() call itself.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let resetAppSettings: typeof import("@/db/queries/settings").resetAppSettings;
let updateAppSettings: typeof import("@/db/queries/settings").updateAppSettings;
let runSchedulerTick: typeof import("../tick").runSchedulerTick;
let acquireScanLock: typeof import("../lock").acquireScanLock;
let releaseScanLock: typeof import("../lock").releaseScanLock;
let resetScanLockForTests: typeof import("../lock").resetScanLockForTests;
let getScanLockStatus: typeof import("../lock").getScanLockStatus;
let getSchedulerRuntimeState: typeof import("../state").getSchedulerRuntimeState;
let resetSchedulerRuntimeStateForTests: typeof import("../state").resetSchedulerRuntimeStateForTests;
let resetMaintenanceRuntimeStateForTests: typeof import("../maintenanceState").resetMaintenanceRuntimeStateForTests;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let recordDiscoveryResult: typeof import("@/db/queries/companies").recordDiscoveryResult;
let getOrganizationForCompany: typeof import("@/db/queries/organizationRegistry").getOrganizationForCompany;
let listJobSources: typeof import("@/db/queries/organizationRegistry").listJobSources;
let reviewJobSource: typeof import("@/db/queries/organizationRegistry").reviewJobSource;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let tmpCandidatesDir: string;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduler-tick-test-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduler-tick-candidates-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;

  ({ getDb } = await import("@/db"));
  ({ resetAppSettings, updateAppSettings } = await import("@/db/queries/settings"));
  ({ runSchedulerTick } = await import("../tick"));
  ({ acquireScanLock, releaseScanLock, resetScanLockForTests, getScanLockStatus } = await import("../lock"));
  ({ getSchedulerRuntimeState, resetSchedulerRuntimeStateForTests } = await import("../state"));
  ({ resetMaintenanceRuntimeStateForTests } = await import("../maintenanceState"));
  ({ createCompany, recordDiscoveryResult } = await import("@/db/queries/companies"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ getOrganizationForCompany, listJobSources, reviewJobSource } = await import("@/db/queries/organizationRegistry"));

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

beforeEach(() => {
  resetAppSettings();
  resetScanLockForTests();
  resetSchedulerRuntimeStateForTests();
  resetMaintenanceRuntimeStateForTests();
});

test("34. runSchedulerTick returns SKIPPED_DISABLED when scheduler.enabled=false (the default), and never touches the lock", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  return runSchedulerTick(now).then((outcome) => {
    assert.equal(outcome.outcome, "SKIPPED_DISABLED");
    assert.equal(getScanLockStatus(now).held, false);
  });
});

test("35. runSchedulerTick returns SKIPPED_OUTSIDE_WINDOW when enabled but the current hour is outside the configured window", async () => {
  updateAppSettings({ scheduler: { enabled: true, windowStartHour: 9, windowEndHour: 17 } });
  const outcome = await runSchedulerTick(new Date("2026-01-15T20:00:00Z")); // 8pm UTC
  assert.equal(outcome.outcome, "SKIPPED_OUTSIDE_WINDOW");
});

test("36. runSchedulerTick returns SKIPPED_INTERVAL_NOT_DUE when the last attempt was too recent", async () => {
  updateAppSettings({
    scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24, intervalMinutes: 60 },
  });
  const first = await runSchedulerTick(new Date("2026-01-15T12:00:00Z"));
  assert.equal(first.outcome, "SKIPPED_NO_COMPANIES"); // fresh DB, zero scan-ready companies

  const second = await runSchedulerTick(new Date("2026-01-15T12:10:00Z")); // only 10 minutes later
  assert.equal(second.outcome, "SKIPPED_INTERVAL_NOT_DUE");
});

test("37. runSchedulerTick returns SKIPPED_LOCK_HELD when the lock is already held by someone else (e.g. a manual scan)", async () => {
  updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
  const now = new Date("2026-01-15T12:00:00Z");
  acquireScanLock(now); // simulate a concurrent manual POST /api/scan holding the lock

  const outcome = await runSchedulerTick(now);
  assert.equal(outcome.outcome, "SKIPPED_LOCK_HELD");
  if (outcome.outcome === "SKIPPED_LOCK_HELD") {
    assert.equal(outcome.heldSince, now.toISOString());
  }
});

test("38. runSchedulerTick releases a lock it acquired even when there are zero companies to scan, and records success state", async () => {
  updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
  const now = new Date("2026-01-15T12:00:00Z");
  const beforeCall = Date.now();

  const outcome = await runSchedulerTick(now);
  assert.equal(outcome.outcome, "SKIPPED_NO_COMPANIES");

  const lockStatus = getScanLockStatus(now);
  assert.equal(lockStatus.held, false);

  const runtimeState = getSchedulerRuntimeState();
  // lastStartedAt uses the tick's own injected clock (`now`) — it's the "as-of" instant the tick
  // reasoned about, and the value the NEXT tick's isIntervalDue check reads back.
  assert.equal(runtimeState.lastStartedAt, now.toISOString());
  // lastCompletedAt/lastSuccessfulAt use a fresh real timestamp (see tick.ts's comment) — for this
  // near-instant zero-company path that's just "roughly when the test actually ran", not `now`.
  assert.ok(runtimeState.lastSuccessfulAt);
  const successfulAtMs = new Date(runtimeState.lastSuccessfulAt!).getTime();
  assert.ok(successfulAtMs >= beforeCall && successfulAtMs <= Date.now());
  assert.equal(runtimeState.lastError, null);
});

test("39. a fresh database's listScanReadyCompanies() is empty, so runSchedulerTick never reaches runScan() without any companies configured", async () => {
  updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
  const outcome = await runSchedulerTick(new Date("2026-01-15T12:00:00Z"));
  assert.equal(outcome.outcome, "SKIPPED_NO_COMPANIES");
});

test("40. runSchedulerTick releases the lock even though no scan ran, so a manual POST /api/scan can immediately acquire it afterward", async () => {
  updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
  const now = new Date("2026-01-15T12:00:00Z");
  await runSchedulerTick(now);

  const manualAcquire = acquireScanLock(new Date(now.getTime() + 1000));
  assert.equal(manualAcquire.acquired, true);
  releaseScanLock();
});

test("92. a RAN scheduler tick includes a nested matching summary (Phase 4 Stage 2) built from the same shared post-scan orchestration as a manual scan", async () => {
  // Make one company scan-ready via listScanReadyCompanies()'s real gating — same fixture pattern
  // as src/db/queries/__tests__/organizationRegistry.test.ts's own "verified structured source"
  // case: VERIFIED resolution + APPROVED review.
  const company = createCompany({ name: "Scheduler Matching Co", source_type: "greenhouse", ats_board_token: "sched-match-token" });
  recordDiscoveryResult(company.id, {
    status: "VERIFIED",
    sourceType: "greenhouse",
    atsBoardToken: "sched-match-token",
    discoveredJobsUrl: "https://boards.greenhouse.io/sched-match-token",
    reason: "Direct ATS URL match (greenhouse)",
    suspectedAts: null,
  });
  const organization = getOrganizationForCompany(company.id)!;
  const [source] = listJobSources(organization.id);
  reviewJobSource(source.id, "APPROVED", "Test fixture approval");

  const candidate = createCandidate({ firstName: "Scheduler", lastName: "Notified" });
  writeValidProfile(candidate.id);

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
            absolute_url: "https://boards.greenhouse.io/sched-match-token/jobs/1",
            content: "<p>Job description.</p>",
            updated_at: new Date().toISOString(),
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;

  try {
    updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
    const outcome = await runSchedulerTick(new Date());
    assert.equal(outcome.outcome, "RAN");
    if (outcome.outcome !== "RAN") return;
    assert.equal(outcome.summary.affectedJobDedupeKeys.length, 1);
    assert.ok(outcome.matching, "the RAN outcome must include a nested matching summary");
    assert.equal(outcome.matching.jobsResolved, 1);
    assert.ok(outcome.notifications, "24. scheduled scan orchestration includes the notification-generation summary through the same canonical flow");
    assert.equal(outcome.notifications.evaluated, outcome.matching.evaluatedPairs.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makeScanReadyCompany(name: string, token: string) {
  const company = createCompany({ name, source_type: "greenhouse", ats_board_token: token });
  recordDiscoveryResult(company.id, {
    status: "VERIFIED",
    sourceType: "greenhouse",
    atsBoardToken: token,
    discoveredJobsUrl: `https://boards.greenhouse.io/${token}`,
    reason: "Direct ATS URL match (greenhouse)",
    suspectedAts: null,
  });
  const organization = getOrganizationForCompany(company.id)!;
  const [source] = listJobSources(organization.id);
  reviewJobSource(source.id, "APPROVED", "Test fixture approval");
  return company;
}

function mockEmptyJobsFetch() {
  return (async () => new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

test("Scheduler maintenance phase: a never-run maintenance state runs on the first RAN tick (isIntervalDue treats null lastStartedAt as due)", async () => {
  makeScanReadyCompany("Maintenance Cadence Co A", "maint-cadence-a");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockEmptyJobsFetch();
  try {
    updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
    const outcome = await runSchedulerTick(new Date("2026-01-15T12:00:00Z"));
    assert.equal(outcome.outcome, "RAN");
    if (outcome.outcome !== "RAN") return;
    assert.ok(outcome.maintenance, "maintenance must run on the first tick, since it has never run before");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("17. Scheduler maintenance cadence is independent from the scan interval: a second tick 61 minutes later re-scans but does not re-run maintenance within the same 24h window", async () => {
  makeScanReadyCompany("Maintenance Cadence Co B", "maint-cadence-b");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockEmptyJobsFetch();
  try {
    updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24, intervalMinutes: 60 } });
    const first = await runSchedulerTick(new Date("2026-01-15T12:00:00Z"));
    assert.equal(first.outcome, "RAN");
    if (first.outcome !== "RAN") return;
    assert.ok(first.maintenance, "first tick: maintenance is due");

    // 61 minutes later: past the scan interval (60m), so this tick RUNS a scan again — but nowhere
    // near the 24h maintenance cadence, so maintenance must be skipped (null) this time.
    const second = await runSchedulerTick(new Date("2026-01-15T13:01:00Z"));
    assert.equal(second.outcome, "RAN");
    if (second.outcome !== "RAN") return;
    assert.equal(second.maintenance, null, "16/17. the scan phase running again must not implicitly re-run lifecycle maintenance");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
