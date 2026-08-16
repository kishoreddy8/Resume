import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedJob } from "@/types";

/**
 * Regression suite for the runScan()/global-lifecycle-maintenance decoupling. This is the exact
 * missing coverage identified after the Discovery V2 Stage 5 incident: a single-company
 * runScan([company]) call was silently archiving/deleting thousands of unrelated jobs across
 * hundreds of other companies, because runAgeBasedSweep() ran by default. See
 * src/lib/scan/lifecycleMaintenance.ts and RunScanOptions.runAgeSweep's doc comment (src/lib/scan.ts)
 * for the fix; this file proves it.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJob: typeof import("@/db/queries/jobs").getJob;
let listJobs: typeof import("@/db/queries/jobs").listJobs;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let runScan: typeof import("@/lib/scan").runScan;
let runLifecycleMaintenance: typeof import("../lifecycleMaintenance").runLifecycleMaintenance;
let setCandidatePipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let setCandidatePinned: typeof import("@/db/queries/candidateJobState").setPinned;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-lifecycle-maintenance-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("@/db"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJob, listJobs } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ runScan } = await import("@/lib/scan"));
  ({ runLifecycleMaintenance } = await import("../lifecycleMaintenance"));
  ({ setPipelineStatus: setCandidatePipelineStatus, setPinned: setCandidatePinned } = await import("@/db/queries/candidateJobState"));
  ({ createCandidate } = await import("@/db/queries/candidates"));

  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let companyCounter = 0;
function makeCompany() {
  companyCounter++;
  return createCompany({ name: `Lifecycle Test Co ${companyCounter}`, source_type: "greenhouse", ats_board_token: `lc-token-${companyCounter}` });
}

function makeNormalizedJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "ext-1",
    title: "Test Role",
    location: null,
    department: null,
    url: "https://example.com/job",
    descriptionHtml: null,
    descriptionText: null,
    employmentType: null,
    workplaceType: null,
    salaryText: null,
    postedAt: null,
    raw: null,
    ...overrides,
  };
}

function seedJob(companyId: number, dedupeKey: string, overrides: Partial<NormalizedJob> = {}) {
  return upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: makeNormalizedJob(overrides),
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
}

function backdateJob(jobId: number, daysAgo: number) {
  const iso = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare("UPDATE jobs SET first_seen_at = ? WHERE id = ?").run(iso, jobId);
}

function seedJobAtAge(company: { id: number }, daysAgo: number, externalId = `ext-${Math.random().toString(36).slice(2)}`) {
  const key = dedupeKeyForAts("greenhouse", company.id, externalId);
  seedJob(company.id, key, { externalId });
  const job = listJobs({ companyId: company.id }).find((j) => j.dedupe_key === key)!;
  backdateJob(job.id, daysAgo);
  return getJob(job.id)!;
}

function mockEmptyJobsFetch() {
  return (async () => new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

async function scanWithMockedFetch(companies: Parameters<typeof runScan>[0], options?: Parameters<typeof runScan>[1]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockEmptyJobsFetch();
  try {
    return await runScan(companies, options);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- 1-4: runScan default no longer runs the global sweep ---------------------------------------

test("1/2. runScan([companyA]) does not mutate companyB's lifecycle state and does not call runAgeBasedSweep by default", async () => {
  const companyA = makeCompany();
  const companyB = makeCompany();
  const staleJob = seedJobAtAge(companyB, 11); // eligible for deletion under current policy

  const summary = await scanWithMockedFetch([companyA]);

  assert.equal(summary.jobsArchived, 0);
  assert.equal(summary.jobsDeletedByAge, 0);
  assert.ok(getJob(staleJob.id), "companyB's stale job must still exist — scanning companyA must never touch it");
  assert.equal(getJob(staleJob.id)!.is_archived, 0);
});

test("3. a sample scan (maxJobsPerCompany set) also does not run the global sweep", async () => {
  const companyA = makeCompany();
  const companyB = makeCompany();
  const staleJob = seedJobAtAge(companyB, 15);

  const summary = await scanWithMockedFetch([companyA], { maxJobsPerCompany: 3 });

  assert.equal(summary.jobsDeletedByAge, 0);
  assert.ok(getJob(staleJob.id));
});

test("4. a manual full scan (no options at all, matching scripts/scan.ts) also does not run the global sweep unless explicitly requested", async () => {
  const companyA = makeCompany();
  const companyB = makeCompany();
  const agingJob = seedJobAtAge(companyB, 9);

  const summary = await scanWithMockedFetch([companyA]);

  assert.equal(summary.jobsArchived, 0);
  assert.equal(getJob(agingJob.id)!.is_archived, 0);
});

test("5. only an explicit runAgeSweep:true runs the sweep; false and omitted both leave it off", async () => {
  const companyOmitted = makeCompany();
  const companyFalse = makeCompany();
  const companyTrue = makeCompany();
  const staleOmitted = seedJobAtAge(companyOmitted, 12);
  const staleFalse = seedJobAtAge(companyFalse, 12);
  const staleTrue = seedJobAtAge(companyTrue, 12);

  await scanWithMockedFetch([companyOmitted]);
  assert.ok(getJob(staleOmitted.id), "omitted runAgeSweep must leave the sweep off");

  await scanWithMockedFetch([companyFalse], { runAgeSweep: false });
  assert.ok(getJob(staleFalse.id), "explicit runAgeSweep:false must leave the sweep off");

  // jobsDeletedByAge/jobsArchived below are checked as "at least" rather than exact totals: earlier
  // tests in this file share one DB and deliberately never sweep, so their own stale/aging jobs are
  // still sitting there — this test only needs to prove ITS job was swept when runAgeSweep:true.
  const summary = await scanWithMockedFetch([companyTrue], { runAgeSweep: true });
  assert.equal(getJob(staleTrue.id), undefined, "explicit runAgeSweep:true must run the sweep");
  assert.ok(summary.jobsDeletedByAge >= 1);
});

// --- 6-15: the dedicated runLifecycleMaintenance() entry point -----------------------------------

test("6. runLifecycleMaintenance invokes the age sweep for real (no options)", () => {
  const company = makeCompany();
  const staleJob = seedJobAtAge(company, 11);

  const result = runLifecycleMaintenance();

  assert.equal(result.deletedCount, 1);
  assert.equal(getJob(staleJob.id), undefined);
});

test("7/8. dry-run produces correct counts, zero DB mutations, and zero suppressed_jobs rows", () => {
  const company = makeCompany();
  const archiving = seedJobAtAge(company, 9);
  const stale = seedJobAtAge(company, 15);
  const suppressedBefore = (getDb().prepare("SELECT COUNT(*) AS c FROM suppressed_jobs").get() as { c: number }).c;

  const result = runLifecycleMaintenance({ dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.archivedCount, 1);
  assert.equal(result.deletedCount, 1);
  // Zero mutation: both jobs are untouched — the "aging" one still unarchived, the "stale" one still exists.
  assert.equal(getJob(archiving.id)!.is_archived, 0);
  assert.ok(getJob(stale.id), "dry-run must not delete anything");
  const suppressedAfter = (getDb().prepare("SELECT COUNT(*) AS c FROM suppressed_jobs").get() as { c: number }).c;
  assert.equal(suppressedAfter, suppressedBefore, "dry-run must create zero suppressed_jobs rows");
});

test("9/10/11. real maintenance preserves Applied, Interviewing, and pinned jobs regardless of age", async () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Lifecycle", lastName: "Tester" });

  const applied = seedJobAtAge(company, 20);
  setCandidatePipelineStatus(candidate.id, applied.dedupe_key, "Applied");

  const interviewing = seedJobAtAge(company, 20);
  setCandidatePipelineStatus(candidate.id, interviewing.dedupe_key, "Interviewing");

  const pinned = seedJobAtAge(company, 20);
  setCandidatePinned(candidate.id, pinned.dedupe_key, true);

  runLifecycleMaintenance();

  assert.ok(getJob(applied.id), "Applied job must survive maintenance regardless of age");
  assert.ok(getJob(interviewing.id), "Interviewing job must survive maintenance regardless of age");
  assert.ok(getJob(pinned.id), "pinned job must survive maintenance regardless of age");
});

test("12/13. archive (7 day) and delete (10 day) thresholds are unchanged through the maintenance wrapper", () => {
  const company = makeCompany();
  const fresh = seedJobAtAge(company, 5);
  const archiveEdge = seedJobAtAge(company, 8);
  const deleteEdge = seedJobAtAge(company, 11);

  runLifecycleMaintenance();

  assert.equal(getJob(fresh.id)!.is_archived, 0, "a 5-day job must remain untouched");
  assert.equal(getJob(archiveEdge.id)!.is_archived, 1, "an 8-day job must be archived, matching the existing 7-day threshold");
  assert.equal(getJob(deleteEdge.id), undefined, "an 11-day job must be deleted, matching the existing 10-day threshold");
});

test("14. maintenance metrics (archivedCount/deletedCount/affectedCompanies/suppressionCount/durationMs) are correct", () => {
  const companyA = makeCompany();
  const companyB = makeCompany();
  seedJobAtAge(companyA, 9); // archived
  seedJobAtAge(companyB, 12); // deleted
  seedJobAtAge(companyB, 13); // deleted, same company as above

  const result = runLifecycleMaintenance();

  assert.equal(result.archivedCount, 1);
  assert.equal(result.deletedCount, 2);
  assert.equal(result.suppressionCount, 2);
  assert.equal(result.affectedCompanies, 2, "companyA (archive) + companyB (delete) = 2 distinct companies");
  assert.ok(result.durationMs >= 0);
  assert.equal(result.blocked, false);
  assert.equal(result.dryRun, false);
});

test("15. a mutation bound blocks an oversized run before any change, and reports the projected count", () => {
  const company = makeCompany();
  seedJobAtAge(company, 12);
  seedJobAtAge(company, 12);
  seedJobAtAge(company, 12); // 3 eligible deletions

  const result = runLifecycleMaintenance({ maxMutations: 2 });

  assert.equal(result.blocked, true);
  assert.equal(result.projectedCount, 3);
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS c FROM jobs WHERE company_id = ?").get(company.id) as { c: number }).c,
    3,
    "a blocked run must mutate zero rows — all 3 jobs must still exist"
  );
});

// --- Phase 9: the exact regression shape from the Stage 5 incident -------------------------------

test("Equity Methods regression: scanning the approved company never cleans up an unrelated company's backlog; explicit maintenance does", async () => {
  const equityMethodsLike = makeCompany(); // company A: the just-approved, scan-ready source
  const backlogCompany = makeCompany(); // company B: many stale jobs, like the 357 real companies affected

  const staleJobs = Array.from({ length: 5 }, (_, i) => seedJobAtAge(backlogCompany, 12, `backlog-${i}`));

  const scanSummary = await scanWithMockedFetch([equityMethodsLike]);
  assert.equal(scanSummary.errors, 0, "company A's own scan must succeed");
  assert.equal(scanSummary.jobsDeletedByAge, 0);
  assert.equal(scanSummary.jobsArchived, 0);
  for (const job of staleJobs) {
    assert.ok(getJob(job.id), "company B's backlog must be completely untouched by company A's scan");
  }

  // Now explicitly invoke maintenance — this is the only path that should ever clean up company B.
  // deletedCount is checked as "at least our 5" rather than an exact total: this file's earlier
  // tests share one DB and deliberately never sweep, so their own eligible jobs are still present.
  const maintenance = runLifecycleMaintenance();
  assert.ok(maintenance.deletedCount >= 5);
  for (const job of staleJobs) {
    assert.equal(getJob(job.id), undefined, "explicit maintenance must clean up company B's backlog");
  }
});
