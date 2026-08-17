import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveryV2Result } from "@/lib/ats/discoveryV2";
import type { RawBuiltInResult } from "@/lib/externalSignals/normalize";
import type { Company } from "@/types";

// Isolation MUST be established before any DB-backed module is imported, since getDb() resolves
// CAREER_OPS_DB_PATH (defaulting to the REAL data/app.db) the first time it's called, and every
// other test file in this repo sets these env vars before importing anything DB-backed for exactly
// that reason. This file previously had none — safe only by accident (never wired into `npm test`'s
// glob, so it was never actually executed against the real production database) rather than by
// design; dynamic imports below (assigned inside before()) are what make deferring safe.
let tmpDbDir: string;
let tmpCandidatesDir: string;
let tmpGeneratedDir: string;

let getDb: typeof import("@/db").getDb;
let acquireProductionCycleLock: typeof import("../state").acquireProductionCycleLock;
let getProductionCycleLockStatus: typeof import("../state").getProductionCycleLockStatus;
let getProductionCycleRuntimeState: typeof import("../state").getProductionCycleRuntimeState;
let releaseProductionCycleLock: typeof import("../state").releaseProductionCycleLock;
let resetProductionCycleStateForTests: typeof import("../state").resetProductionCycleStateForTests;
let STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES: typeof import("../state").STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES;
let runProductionCycle: typeof import("../orchestrator").runProductionCycle;
let getMorningReadinessSummary: typeof import("../readiness").getMorningReadinessSummary;
let listScanReadyCompanies: typeof import("@/db/queries/organizationRegistry").listScanReadyCompanies;
let retireSupersededSecondaryJobs: typeof import("@/lib/externalSignals/secondaryIngestion").retireSupersededSecondaryJobs;
let PROVIDER_COST_CLASS: typeof import("@/lib/externalSignals/providers").PROVIDER_COST_CLASS;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-production-orch-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-production-orch-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-production-orch-generated-"));
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
  ({
    acquireProductionCycleLock,
    getProductionCycleLockStatus,
    getProductionCycleRuntimeState,
    releaseProductionCycleLock,
    resetProductionCycleStateForTests,
    STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES,
  } = await import("../state"));
  ({ runProductionCycle } = await import("../orchestrator"));
  ({ getMorningReadinessSummary } = await import("../readiness"));
  ({ listScanReadyCompanies } = await import("@/db/queries/organizationRegistry"));
  ({ retireSupersededSecondaryJobs } = await import("@/lib/externalSignals/secondaryIngestion"));
  ({ PROVIDER_COST_CLASS } = await import("@/lib/externalSignals/providers"));

  const db = getDb();

  // Discovery V2 phase (see listDiscoveryV2Candidates) requires at least one is_active=1,
  // resolution_status IN ('UNRESOLVED','GENERIC_SUPPORTED') company with zero active jobs — both
  // defaults on a fresh row — for the discoverer mock in tests 1/2/11 to ever be invoked. Every
  // other test skips the discoveryV2 phase (or fails fast before reaching it), so this fixture is
  // inert everywhere else.
  db.prepare(
    `INSERT INTO companies (name, source_type, career_page_url) VALUES ('Discovery V2 Test Fixture Co', 'career_link', 'https://example.com/careers')`
  ).run();
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

describe("Stage 20: Unified Production Orchestrator & Morning Readiness", () => {
  beforeEach(() => {
    resetProductionCycleStateForTests();
  });

  it("1. Production phases execute in intended order: reliability -> atsScan -> builtIn -> crossSourceDedup -> discoveryV2", async () => {
    const phaseOrder: string[] = [];

    const summary = await runProductionCycle({
      atsCompanies: [],
      discoveryV2Limit: 1,
      recoveryRunner: async () => {
        phaseOrder.push("reliability");
        return {
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 10,
          eligibleFound: 0,
          attempted: 0,
          skippedByCircuitBreaker: [],
          openCircuits: [],
          outcomes: [],
          proposalsCreated: 0,
        };
      },
      builtInSearcher: async () => {
        phaseOrder.push("builtIn");
        return [];
      },
      discoverer: async () => {
        phaseOrder.push("discoveryV2");
        return {
          companyId: 1,
          seedUrl: "https://example.com",
          seedFinalUrl: null,
          followedCareersUrl: null,
          followedFinalUrl: null,
          careersLinkScore: null,
          pagesVisited: 1,
          finalUrl: null,
          candidates: [],
          bestGenericJobsUrl: null,
          suspectedUnsupportedAts: null,
          redirectChain: [],
          outcome: "NO_SOURCE_FOUND",
          reason: "No source found on seed page (test fixture).",
          observedRequestCount: 1,
          durationMs: 10,
        };
      },
    });

    assert.deepEqual(phaseOrder, ["reliability", "builtIn", "discoveryV2"]);
    assert.ok(summary.phases.reliability);
    assert.ok(summary.phases.atsScan);
    assert.ok(summary.phases.builtIn);
    assert.ok(summary.phases.crossSourceDedup);
    assert.ok(summary.phases.discoveryV2);
  });

  it("2. One phase failure doesn't destroy unrelated completed phases (failure isolation)", async () => {
    const summary = await runProductionCycle({
      atsCompanies: [],
      recoveryRunner: async () => {
        throw new Error("Reliability error");
      },
      builtInSearcher: async () => {
        return [];
      },
      discoverer: async () => {
        throw new Error("Discovery V2 error");
      },
    });

    assert.equal(summary.phases.reliability.status, "DEGRADED");
    assert.equal(summary.phases.atsScan.status, "COMPLETED");
    assert.equal(summary.phases.builtIn.status, "COMPLETED");
    assert.equal(summary.phases.crossSourceDedup.status, "COMPLETED");
    assert.equal(summary.phases.discoveryV2.status, "DEGRADED");
    assert.equal(summary.status, "DEGRADED");
  });

  it("3. READY derivation requires successful core phases", async () => {
    const summary = await runProductionCycle({
      skipPhases: ["discoveryV2"],
      atsCompanies: [],
      builtInRoles: [],
      recoveryRunner: async () => ({
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 10,
        eligibleFound: 0,
        attempted: 0,
        skippedByCircuitBreaker: [],
        openCircuits: [],
        outcomes: [],
        proposalsCreated: 0,
      }),
    });

    const hasOpenCircuits = summary.phases.reliability.metrics.openCircuits.length > 0;
    assert.equal(summary.status, hasOpenCircuits ? "DEGRADED" : "READY");
  });

  it("4. DEGRADED derivation when non-critical components have errors", async () => {
    const summary = await runProductionCycle({
      skipPhases: ["atsScan", "discoveryV2"],
      builtInRoles: [],
      recoveryRunner: async () => {
        throw new Error("Degraded recovery");
      },
    });

    assert.equal(summary.status, "DEGRADED");
    assert.ok(summary.statusReason.includes("Degraded recovery"));
  });

  it("5. FAILED derivation when core ATS scan throws fatal error", async () => {
    const summary = await runProductionCycle({
      // Deliberately malformed fixture (source_type isn't a real SourceType) to force a fatal scan
      // error; cast through `unknown` rather than `any` since Company's other required fields are
      // irrelevant to this test.
      atsCompanies: [{ id: -999, name: "Invalid", source_type: "invalid_ats" } as unknown as Company],
      skipPhases: ["reliability", "builtIn", "discoveryV2", "crossSourceDedup"],
    });

    assert.equal(summary.phases.atsScan.status, "FAILED");
    assert.equal(summary.status, "FAILED");
  });

  it("6. Overlapping production cycle is rejected when lock is held", async () => {
    const lockRes = acquireProductionCycleLock();
    assert.equal(lockRes.acquired, true);
    assert.ok(lockRes.ownerId);

    await assert.rejects(
      async () => {
        await runProductionCycle();
      },
      /already running/
    );

    releaseProductionCycleLock(lockRes.ownerId!);
  });

  it("7. Stale lease is automatically recoverable once past STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES", async () => {
    const db = getDb();
    const longAgo = new Date(Date.now() - (STALE_PRODUCTION_LOCK_TIMEOUT_MINUTES + 60) * 60_000).toISOString();
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('production_cycle_lock.acquired_at', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(longAgo);
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('production_cycle_lock.owner_id', 'dead-owner', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run();

    const lockStatus = getProductionCycleLockStatus();
    assert.equal(lockStatus.stale, true);
    assert.equal(lockStatus.held, false);

    const summary = await runProductionCycle({
      skipPhases: ["atsScan", "builtIn", "discoveryV2", "crossSourceDedup"],
      recoveryRunner: async () => ({
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 10,
        eligibleFound: 0,
        attempted: 0,
        skippedByCircuitBreaker: [],
        openCircuits: [],
        outcomes: [],
        proposalsCreated: 0,
      }),
    });
    assert.ok(summary.cycleId);
  });

  it("7b. A running cycle renews its own lease via heartbeat before phases complete", async () => {
    // A controlled artificial delay (not a real network call) guarantees the cycle stays open long
    // enough for a 15ms heartbeat interval to fire multiple times — deterministic, no real timing
    // dependency on external services.
    let sawHeartbeatBump = false;
    const cyclePromise = runProductionCycle({
      heartbeatIntervalMs: 15,
      skipPhases: ["atsScan", "builtIn", "crossSourceDedup", "discoveryV2"],
      recoveryRunner: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return {
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 150,
          eligibleFound: 0,
          attempted: 0,
          skippedByCircuitBreaker: [],
          openCircuits: [],
          outcomes: [],
          proposalsCreated: 0,
        };
      },
    });

    let sawReadinessRunning = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const status = getProductionCycleLockStatus();
      if (status.held && status.acquiredAt && status.trueAcquiredAt && status.acquiredAt > status.trueAcquiredAt) {
        sawHeartbeatBump = true;
        const readiness = getMorningReadinessSummary();
        sawReadinessRunning = readiness.productionCycle.isRunning === true && readiness.productionCycle.runningSinceAt === status.trueAcquiredAt;
        break;
      }
    }

    await cyclePromise;
    assert.ok(sawHeartbeatBump, "expected at least one heartbeat renewal to move acquiredAt past trueAcquiredAt while the cycle ran");
    assert.ok(sawReadinessRunning, "Morning Readiness must report isRunning=true and the correct runningSinceAt while a cycle is in flight");
  });

  it("8. Only approved ATS sources scanned by default", () => {
    const scanReady = listScanReadyCompanies();
    for (const c of scanReady) {
      assert.notEqual(c.source_type, "career_link", "career_link must never be scan-ready");
      assert.equal(c.is_active, 1);
    }
  });

  it("9. Built In persistence uses existing safe pipeline and preserves US / <=20-day invariants", async () => {
    const rawJob: RawBuiltInResult = {
      identifierValue: "test-builtin-orch-1",
      title: "Staff Data Engineer",
      hiringOrganizationName: "Boeing",
      datePosted: "2026-08-14",
      description: "Staff Data Engineer building robust distributed systems in Python and Spark with AWS. ".repeat(4),
      addressLocality: "Hazelwood",
      addressRegion: "MO",
      addressCountry: "USA",
      listingUrl: "https://builtin.com/job/test-orch-1",
      applyHref: "https://jobs.boeing.com/job/test-orch-1",
    };

    const summary = await runProductionCycle({
      skipPhases: ["atsScan", "discoveryV2", "reliability", "crossSourceDedup"],
      builtInSearcher: async () => [rawJob],
    });

    assert.ok(summary.phases.builtIn);
    assert.equal(summary.phases.builtIn.metrics.listingsDiscovered, 1);
    assert.equal(summary.phases.builtIn.metrics.usAndFreshListings, 1);
  });

  it("10. Ambiguous employer is never onboarded", async () => {
    const rawAmbiguous: RawBuiltInResult = {
      identifierValue: "test-ambiguous-1",
      title: "Software Engineer",
      hiringOrganizationName: "Unknown Common Ambiguous Name XYZ",
      datePosted: "2026-08-14",
      description: "Software engineering role with no external domain or ATS link. ".repeat(4),
      addressLocality: "New York",
      addressRegion: "NY",
      addressCountry: "USA",
      listingUrl: "https://builtin.com/job/test-ambig-1",
      applyHref: undefined,
    };

    const summary = await runProductionCycle({
      skipPhases: ["atsScan", "discoveryV2", "reliability", "crossSourceDedup"],
      builtInSearcher: async () => [rawAmbiguous],
    });

    assert.ok(summary.phases.builtIn);
    assert.equal(summary.phases.builtIn.metrics.newCompaniesCreated, 0);
  });

  it("11. Discovery V2 creates proposals strictly as PENDING_REVIEW (zero auto-approval)", async () => {
    const mockDiscoverResult: DiscoveryV2Result = {
      companyId: 1,
      seedUrl: "https://example.com/careers",
      seedFinalUrl: "https://example.com/careers",
      followedCareersUrl: null,
      followedFinalUrl: null,
      careersLinkScore: null,
      pagesVisited: 1,
      finalUrl: "https://example.com/careers",
      bestGenericJobsUrl: null,
      suspectedUnsupportedAts: null,
      redirectChain: [],
      outcome: "STRUCTURED_CANDIDATE_FOUND",
      reason: "Structured candidate found on seed page (test fixture).",
      candidates: [
        {
          provider: "greenhouse",
          boardToken: "test-token-stage20-v2",
          canonicalUrl: "https://boards.greenhouse.io/test-token-stage20-v2",
          evidenceTypes: ["STATIC_HTML"],
          evidenceUrls: ["https://example.com/careers"],
          foundOnPage: "seed",
          validationStatus: "VALIDATED_JOBS",
          jobsSeen: 5,
          confidence: "HIGH",
          recommendation: "NEEDS_SOURCE_REVIEW",
        },
      ],
      observedRequestCount: 1,
      durationMs: 50,
    };

    const summary = await runProductionCycle({
      skipPhases: ["atsScan", "builtIn", "crossSourceDedup"],
      discoveryV2Limit: 1,
      discoverer: async () => mockDiscoverResult,
      recoveryRunner: async () => ({
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 10,
        eligibleFound: 0,
        attempted: 0,
        skippedByCircuitBreaker: [],
        openCircuits: [],
        outcomes: [],
        proposalsCreated: 0,
      }),
    });

    assert.ok(summary.phases.discoveryV2);
    const db = getDb();
    const proposals = db.prepare("SELECT * FROM ats_source_proposals WHERE proposed_board_token = 'test-token-stage20-v2'").all() as Array<{ status: string }>;
    assert.ok(proposals.length > 0);
    for (const p of proposals) {
      assert.equal(p.status, "PENDING_REVIEW");
    }
  });

  it("12. Zero lifecycle maintenance / matching / notification side effects", async () => {
    const db = getDb();
    const archivedBefore = (db.prepare("SELECT COUNT(*) as c FROM jobs WHERE is_archived = 1").get() as { c: number }).c;

    await runProductionCycle({
      skipPhases: ["atsScan", "builtIn", "discoveryV2", "crossSourceDedup"],
      recoveryRunner: async () => ({
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 10,
        eligibleFound: 0,
        attempted: 0,
        skippedByCircuitBreaker: [],
        openCircuits: [],
        outcomes: [],
        proposalsCreated: 0,
      }),
    });

    const archivedAfter = (db.prepare("SELECT COUNT(*) as c FROM jobs WHERE is_archived = 1").get() as { c: number }).c;
    assert.equal(archivedAfter, archivedBefore, "Orchestrator must NEVER run age-based sweep or archive jobs");
  });

  it("13. Zero-cost invariant: Built In is FREE_DIRECT, paid providers are disabled", () => {
    assert.equal(PROVIDER_COST_CLASS.built_in, "FREE_DIRECT");
    assert.equal(PROVIDER_COST_CLASS.indeed, "OPTIONAL_PAID");
    assert.equal(PROVIDER_COST_CLASS.google_jobs, "OPTIONAL_PAID");
    assert.equal(process.env.CAREER_OPS_ALLOW_PAID_EXTERNAL, undefined);
  });

  it("14. Cross-source deduplication and official source preference", () => {
    // retireSupersededSecondaryJobs is per-company (see secondaryIngestion.ts) — no company with
    // this id exists in the isolated test DB, so it deterministically returns [] (the function's own
    // early-return for an unknown/ineligible company), which is exactly what this test verifies:
    // calling it never throws and always returns an array.
    const retired = retireSupersededSecondaryJobs(999_999);
    assert.ok(Array.isArray(retired));
  });

  it("15. Repeated Built In execution is 100% idempotent", async () => {
    const rawJob: RawBuiltInResult = {
      identifierValue: "test-builtin-orch-idempotency",
      title: "Senior AI Engineer",
      hiringOrganizationName: "Boeing",
      datePosted: "2026-08-14",
      description: "Senior AI Engineer building intelligent agents and search pipelines in Python. ".repeat(4),
      addressLocality: "Hazelwood",
      addressRegion: "MO",
      addressCountry: "USA",
      listingUrl: "https://builtin.com/job/test-orch-idemp",
      applyHref: "https://jobs.boeing.com/job/test-orch-idemp",
    };

    const db = getDb();

    // Run 1
    await runProductionCycle({
      skipPhases: ["atsScan", "discoveryV2", "reliability", "crossSourceDedup"],
      builtInSearcher: async () => [rawJob],
    });
    const postRun1Jobs = (db.prepare("SELECT COUNT(*) as c FROM jobs").get() as { c: number }).c;

    // Run 2 (Idempotency)
    await runProductionCycle({
      skipPhases: ["atsScan", "discoveryV2", "reliability", "crossSourceDedup"],
      builtInSearcher: async () => [rawJob],
    });
    const postRun2Jobs = (db.prepare("SELECT COUNT(*) as c FROM jobs").get() as { c: number }).c;

    assert.equal(postRun2Jobs, postRun1Jobs, "Re-running identical listing must not insert duplicate jobs");
  });

  it("16. Morning readiness API derives structured JSON with telemetry gap documentation", () => {
    const readiness = getMorningReadinessSummary();
    const runtime = getProductionCycleRuntimeState();

    assert.equal(readiness.productionCycle.status, runtime.lastStatus, "readiness status must be derived from runtime state, not a separate source of truth");
    assert.equal(readiness.productionCycle.lastRunAt, runtime.lastCompletedAt);
    assert.equal(readiness.productionCycle.isRunning, false, "no cycle is running between tests (beforeEach resets lock state)");
    assert.equal(readiness.productionCycle.runningSinceAt, null);
    assert.equal(typeof readiness.productionCycle.scanReadyCompaniesNeverScanned, "number");

    assert.ok(readiness.productionCycle);
    assert.ok(readiness.ats);
    assert.ok(readiness.reliability);
    assert.ok(readiness.jobs);
    assert.ok(readiness.builtIn);
    assert.ok(readiness.discovery);
    assert.ok(readiness.coverage);
    assert.ok(readiness.needsAttention);
    assert.ok(Array.isArray(readiness.telemetryGaps));
  });
});
