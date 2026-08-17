import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Production-cycle tick orchestration tests. Deliberately do NOT exercise the "RAN" outcome against
 * a real scan, for the same reason src/lib/scheduler/__tests__/tick.test.ts doesn't: runScan() and
 * every individual production phase are already exhaustively covered elsewhere (orchestrator.test.ts
 * exercises all 5 phases via mocked runners); re-mocking that here would duplicate coverage without
 * adding confidence. A fresh isolated test DB naturally has zero scan-ready companies, so
 * SKIPPED_NO_COMPANIES exercises the full settings/window/interval/rotation-query sequence with the
 * one exception of the real runProductionCycle() call itself.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;
let tmpGeneratedDir: string;

let getDb: typeof import("@/db").getDb;
let resetAppSettings: typeof import("@/db/queries/settings").resetAppSettings;
let updateAppSettings: typeof import("@/db/queries/settings").updateAppSettings;
let runProductionCycleTick: typeof import("../tick").runProductionCycleTick;
let PRODUCTION_CYCLE_INTERVAL_MINUTES: typeof import("../tick").PRODUCTION_CYCLE_INTERVAL_MINUTES;
let acquireProductionCycleLock: typeof import("../state").acquireProductionCycleLock;
let releaseProductionCycleLock: typeof import("../state").releaseProductionCycleLock;
let resetProductionCycleStateForTests: typeof import("../state").resetProductionCycleStateForTests;
let recordProductionCycleStarted: typeof import("../state").recordProductionCycleStarted;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let recordDiscoveryResult: typeof import("@/db/queries/companies").recordDiscoveryResult;
let getOrganizationForCompany: typeof import("@/db/queries/organizationRegistry").getOrganizationForCompany;
let listJobSources: typeof import("@/db/queries/organizationRegistry").listJobSources;
let reviewJobSource: typeof import("@/db/queries/organizationRegistry").reviewJobSource;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-production-tick-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-production-tick-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-production-tick-generated-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {}
    global.__careerOpsDb = undefined;
  }

  ({ getDb } = await import("@/db"));
  ({ resetAppSettings, updateAppSettings } = await import("@/db/queries/settings"));
  ({ runProductionCycleTick, PRODUCTION_CYCLE_INTERVAL_MINUTES } = await import("../tick"));
  ({
    acquireProductionCycleLock,
    releaseProductionCycleLock,
    resetProductionCycleStateForTests,
    recordProductionCycleStarted,
  } = await import("../state"));
  ({ createCompany, recordDiscoveryResult } = await import("@/db/queries/companies"));
  ({ getOrganizationForCompany, listJobSources, reviewJobSource } = await import("@/db/queries/organizationRegistry"));

  getDb();
});

after(() => {
  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {}
    global.__careerOpsDb = undefined;
  }
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
});

describe("Stage 23: Production cycle scheduled tick", () => {
  beforeEach(() => {
    resetAppSettings();
    resetProductionCycleStateForTests();
  });

  it("2. SKIPPED_DISABLED when scheduler.enabled=false (the default)", async () => {
    const result = await runProductionCycleTick();
    assert.equal(result.outcome, "SKIPPED_DISABLED");
  });

  it("3. SKIPPED_OUTSIDE_WINDOW when enabled but current hour is outside the configured window", async () => {
    updateAppSettings({ scheduler: { enabled: true, windowStartHour: 9, windowEndHour: 10 } });
    // Fixed instant well outside a 9-10 window, in the settings' default timezone (UTC unless overridden).
    const outsideWindow = new Date("2026-01-01T14:00:00Z");
    const result = await runProductionCycleTick(outsideWindow);
    assert.equal(result.outcome, "SKIPPED_OUTSIDE_WINDOW");
  });

  it("4. SKIPPED_INTERVAL_NOT_DUE when the last attempt was too recent", async () => {
    updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
    const now = new Date("2026-01-01T12:00:00Z");
    recordProductionCycleStarted(now);
    const tooSoon = new Date(now.getTime() + (PRODUCTION_CYCLE_INTERVAL_MINUTES - 1) * 60_000);
    const result = await runProductionCycleTick(tooSoon);
    assert.equal(result.outcome, "SKIPPED_INTERVAL_NOT_DUE");
  });

  it("5. SKIPPED_NO_COMPANIES on a fresh database with zero scan-ready companies", async () => {
    updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });
    const result = await runProductionCycleTick();
    assert.equal(result.outcome, "SKIPPED_NO_COMPANIES");
  });

  it("6. Overlap prevention: a tick firing while a cycle already holds the lease does not start a second cycle", async () => {
    updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24 } });

    // One minimal scan-ready company (same fixture pattern as
    // src/lib/scheduler/__tests__/tick.test.ts's own makeScanReadyCompany) so the tick gets past its
    // own SKIPPED_NO_COMPANIES check and actually attempts runProductionCycle() — but the pre-held
    // lease below rejects it before any phase (and therefore any real network call) ever runs,
    // exactly like orchestrator.test.ts's own "6. Overlapping production cycle is rejected when lock
    // is held".
    const company = createCompany({ name: "Overlap Test Co", source_type: "greenhouse", ats_board_token: "overlap-test-token" });
    recordDiscoveryResult(company.id, {
      status: "VERIFIED",
      sourceType: "greenhouse",
      atsBoardToken: "overlap-test-token",
      discoveredJobsUrl: "https://boards.greenhouse.io/overlap-test-token",
      reason: "Direct ATS URL match (greenhouse)",
      suspectedAts: null,
    });
    const organization = getOrganizationForCompany(company.id)!;
    const [source] = listJobSources(organization.id);
    reviewJobSource(source.id, "APPROVED", "Test fixture approval");

    const lockRes = acquireProductionCycleLock();
    assert.ok(lockRes.acquired);

    const result = await runProductionCycleTick();
    assert.equal(result.outcome, "SKIPPED_LOCK_HELD");

    releaseProductionCycleLock(lockRes.ownerId!);
  });
});
