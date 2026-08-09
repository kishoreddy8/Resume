import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedJob, PipelineStatus } from "../../../types";

/**
 * Settings / Configuration integration tests — run against a real (temp, isolated) SQLite file via
 * CAREER_OPS_DB_PATH, same pattern as jobLifecycle.test.ts/scanReliability.test.ts. Every DB-touching
 * module is imported dynamically inside before() so the env var is set before getDb() ever opens a
 * file. Scanner-wiring tests substitute globalThis.fetch with an in-memory stub (no real network,
 * no real ATS host) so retry/timeout/concurrency behavior is observable deterministically.
 *
 * Every test starts with resetAppSettings() so tests don't leak settings state into each other
 * regardless of execution order.
 *
 * Run with: npm test
 */

let tmpDir: string;

let getDb: typeof import("../../index").getDb;
let createCompany: typeof import("../companies").createCompany;
let upsertJob: typeof import("../jobs").upsertJob;
let getJob: typeof import("../jobs").getJob;
let listJobs: typeof import("../jobs").listJobs;
let runAgeBasedSweep: typeof import("../jobs").runAgeBasedSweep;
let updateJobPipeline: typeof import("../jobs").updateJobPipeline;
let setJobPinned: typeof import("../jobs").setJobPinned;
let markNotInterested: typeof import("../jobs").markNotInterested;
let getAppSettings: typeof import("../settings").getAppSettings;
let updateAppSettings: typeof import("../settings").updateAppSettings;
let resetAppSettings: typeof import("../settings").resetAppSettings;
let runScan: typeof import("../../../lib/scan").runScan;
let dedupeKeyForAts: typeof import("../../../lib/dedupe").dedupeKeyForAts;
let DEFAULT_SETTINGS: typeof import("../../../lib/settings").DEFAULT_SETTINGS;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-settings-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("../../index"));
  ({ createCompany } = await import("../companies"));
  ({ upsertJob, getJob, listJobs, runAgeBasedSweep, updateJobPipeline, setJobPinned, markNotInterested } = await import(
    "../jobs"
  ));
  ({ getAppSettings, updateAppSettings, resetAppSettings } = await import("../settings"));
  ({ runScan } = await import("../../../lib/scan"));
  ({ dedupeKeyForAts } = await import("../../../lib/dedupe"));
  ({ DEFAULT_SETTINGS } = await import("../../../lib/settings"));

  getDb(); // ensure schema + migrations have run
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let companyCounter = 0;
function makeCompany() {
  companyCounter++;
  return createCompany({
    name: `Settings Test Co ${companyCounter}`,
    source_type: "greenhouse",
    ats_board_token: `token-${companyCounter}`,
  });
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

// --- Defaults / persistence / reset ----------------------------------------------------------

test("getAppSettings reproduces DEFAULT_SETTINGS when nothing has been saved", () => {
  resetAppSettings();
  assert.deepEqual(getAppSettings(), DEFAULT_SETTINGS);
});

test("a valid partial update persists and leaves untouched groups at their prior values", () => {
  resetAppSettings();
  const result = updateAppSettings({ lifecycle: { freshDays: 1, archiveAfterDays: 4, deleteAfterDays: 9 } });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.settings.lifecycle.freshDays, 1);
  assert.equal(result.settings.lifecycle.archiveAfterDays, 4);
  assert.equal(result.settings.lifecycle.deleteAfterDays, 9);
  // Untouched groups keep their (default) values, not zeroed out or dropped.
  assert.deepEqual(result.settings.scanner, DEFAULT_SETTINGS.scanner);
  assert.deepEqual(result.settings.suppression, DEFAULT_SETTINGS.suppression);

  assert.deepEqual(getAppSettings(), result.settings, "getAppSettings must reflect what updateAppSettings wrote");
});

test("an update with archive_after_days <= fresh_days is rejected and leaves settings unchanged", () => {
  resetAppSettings();
  const before = getAppSettings();
  const result = updateAppSettings({ lifecycle: { freshDays: 5, archiveAfterDays: 5 } });
  assert.equal(result.ok, false);
  assert.deepEqual(getAppSettings(), before, "a rejected update must not be persisted");
});

test("an update with delete_after_days <= archive_after_days is rejected and leaves settings unchanged", () => {
  resetAppSettings();
  const before = getAppSettings();
  const result = updateAppSettings({ lifecycle: { deleteAfterDays: 5 } }); // default archiveAfterDays is 7
  assert.equal(result.ok, false);
  assert.deepEqual(getAppSettings(), before, "a rejected update must not be persisted");
});

test("an update with an out-of-bounds scanner value is rejected and leaves settings unchanged", () => {
  resetAppSettings();
  const before = getAppSettings();
  const result = updateAppSettings({ scanner: { concurrency: 999 } });
  assert.equal(result.ok, false);
  assert.deepEqual(getAppSettings(), before);

  const before2 = getAppSettings();
  const result2 = updateAppSettings({ scanner: { maxAttempts: 0 } });
  assert.equal(result2.ok, false);
  assert.deepEqual(getAppSettings(), before2);
});

test("an update with an unknown/extraneous key is rejected outright (strict schema, no injection surface)", () => {
  resetAppSettings();
  const before = getAppSettings();
  const result = updateAppSettings({ lifecycle: { freshDays: 3, evil: "DROP TABLE settings;" } });
  assert.equal(result.ok, false);
  assert.deepEqual(getAppSettings(), before);
});

test("resetAppSettings restores DEFAULT_SETTINGS after prior changes", () => {
  resetAppSettings();
  updateAppSettings({ scanner: { concurrency: 2 }, suppression: { expiredJobSuppressionDays: 5 } });
  assert.notDeepEqual(getAppSettings(), DEFAULT_SETTINGS);

  const reset = resetAppSettings();
  assert.deepEqual(reset, DEFAULT_SETTINGS);
  assert.deepEqual(getAppSettings(), DEFAULT_SETTINGS);
});

test("settings persist across a simulated database reconnect", () => {
  resetAppSettings();
  const result = updateAppSettings({ scanner: { concurrency: 9 } });
  assert.equal(result.ok, true);

  // Simulate a reconnect: drop the cached singleton (see src/db/index.ts's getDb/global.__careerOpsDb)
  // and force a fresh open of the same on-disk file — schema + migrations re-run (idempotent).
  (globalThis as unknown as { __careerOpsDb?: unknown }).__careerOpsDb = undefined;
  getDb();

  assert.equal(getAppSettings().scanner.concurrency, 9, "setting must survive reopening the database file");
  resetAppSettings();
});

// --- Candidate eligibility (Phase 2) -----------------------------------------------------------

test("candidate settings default to the conservative DEFAULT_SETTINGS values on an empty table", () => {
  resetAppSettings();
  const settings = getAppSettings();
  assert.deepEqual(settings.candidate, DEFAULT_SETTINGS.candidate);
});

test("candidate settings persist a partial patch and merge with existing values", () => {
  resetAppSettings();
  const result = updateAppSettings({ candidate: { requiresSponsorship: false, clearanceLevel: "Secret" } });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.settings.candidate.requiresSponsorship, false);
    assert.equal(result.settings.candidate.clearanceLevel, "Secret");
    // untouched fields keep their prior (default) value — a partial patch is a merge, not a replace
    assert.equal(result.settings.candidate.usCitizen, DEFAULT_SETTINGS.candidate.usCitizen);
  }
  assert.equal(getAppSettings().candidate.requiresSponsorship, false);
  resetAppSettings();
});

test("an invalid clearanceLevel enum value is rejected and leaves settings untouched", () => {
  resetAppSettings();
  const before = getAppSettings();
  const result = updateAppSettings({ candidate: { clearanceLevel: "Not A Real Level" } });
  assert.equal(result.ok, false);
  assert.deepEqual(getAppSettings(), before);
});

// --- Lifecycle wiring -------------------------------------------------------------------------

test("runAgeBasedSweep uses configured lifecycle thresholds, not the hardcoded defaults", () => {
  resetAppSettings();
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-thresh-1");
  seedJob(company.id, key, { title: "Threshold Test Role" });
  const jobId = listJobs({ companyId: company.id }).find((j) => j.dedupe_key === key)!.id;

  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare("UPDATE jobs SET first_seen_at = ? WHERE id = ?").run(fiveDaysAgo, jobId);

  const underDefaults = runAgeBasedSweep();
  assert.equal(underDefaults.deleted.length, 0, "sanity: default thresholds (3/7/10) must not touch a 5-day-old job");
  assert.ok(getJob(jobId), "job must still exist under default thresholds");

  const update = updateAppSettings({ lifecycle: { freshDays: 1, archiveAfterDays: 2, deleteAfterDays: 3 } });
  assert.equal(update.ok, true);

  const underConfigured = runAgeBasedSweep();
  assert.equal(underConfigured.deleted.length, 1, "must be deleted once the configured threshold is tightened below its age");
  assert.equal(getJob(jobId), undefined, "job must actually be gone once deleted");
  resetAppSettings();
});

test("protected jobs (Applied, pinned) remain protected regardless of how aggressive lifecycle settings are", () => {
  resetAppSettings();
  updateAppSettings({ lifecycle: { freshDays: 0, archiveAfterDays: 1, deleteAfterDays: 2 } });

  const company = makeCompany();
  const appliedKey = dedupeKeyForAts("greenhouse", company.id, "req-protected-applied");
  seedJob(company.id, appliedKey, { title: "Applied Role" });
  const appliedJobId = listJobs({ companyId: company.id }).find((j) => j.dedupe_key === appliedKey)!.id;
  updateJobPipeline(appliedJobId, { pipelineStatus: "Applied" as PipelineStatus });

  const pinnedKey = dedupeKeyForAts("greenhouse", company.id, "req-protected-pinned");
  seedJob(company.id, pinnedKey, { title: "Pinned Role" });
  const pinnedJobId = listJobs({ companyId: company.id }).find((j) => j.dedupe_key === pinnedKey)!.id;
  setJobPinned(pinnedJobId, true);

  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare("UPDATE jobs SET first_seen_at = ? WHERE id IN (?, ?)").run(tenDaysAgo, appliedJobId, pinnedJobId);

  const result = runAgeBasedSweep();

  assert.ok(getJob(appliedJobId), "Applied job must never be deleted, regardless of settings");
  assert.equal(getJob(appliedJobId)!.is_archived, 0, "Applied job must never be archived, regardless of settings");
  assert.ok(getJob(pinnedJobId), "pinned job must never be deleted, regardless of settings");
  assert.equal(getJob(pinnedJobId)!.is_archived, 0, "pinned job must never be archived, regardless of settings");
  assert.equal(
    result.deleted.some((d) => d.jobId === appliedJobId || d.jobId === pinnedJobId),
    false,
    "neither protected job should appear in the sweep's deleted list"
  );
  resetAppSettings();
});

// --- Suppression wiring: Not Interested is permanent, aged-out is configurable ----------------

test("an explicit Not Interested suppression blocks the exact requisition forever, ignoring expired_job_suppression_days entirely", () => {
  resetAppSettings();
  updateAppSettings({ suppression: { expiredJobSuppressionDays: 1 } }); // maximally aggressive window

  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-permanent-1");
  seedJob(company.id, key, { title: "Permanent Suppression Test" });
  const jobId = listJobs({ companyId: company.id }).find((j) => j.dedupe_key === key)!.id;

  markNotInterested(jobId);

  // Backdate the suppression fingerprint far past any plausible retention window.
  const longAgo = new Date(Date.now() - 5000 * 24 * 60 * 60 * 1000).toISOString(); // ~13.7 years ago
  getDb().prepare("UPDATE suppressed_jobs SET suppressed_at = ? WHERE dedupe_key = ?").run(longAgo, key);

  const outcome = seedJob(company.id, key, { title: "Rescanned after ages" });
  assert.equal(
    outcome,
    "suppressed",
    "Not Interested suppression must hold regardless of elapsed time or the configured expired_job_suppression_days"
  );
  assert.equal(listJobs({ companyId: company.id }).length, 0);
  resetAppSettings();
});

test("a system-generated (aged-out) suppression expires per the configured window, unlike Not Interested", () => {
  resetAppSettings();
  updateAppSettings({ suppression: { expiredJobSuppressionDays: 5 } });

  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-expired-1");

  // Mirrors what runAgeBasedSweep actually writes for an aged-out (never explicitly rejected) job —
  // a suppression fingerprint with no corresponding jobs row, reason starting "Aged out:".
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO suppressed_jobs (dedupe_key, company_id, title, reason, suppressed_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(key, company.id, "Aged Out Test", "Aged out: 11 days unapplied", tenDaysAgo);

  const outcome = seedJob(company.id, key, { title: "Reposted after aging out" });
  assert.equal(
    outcome,
    "inserted",
    "an aged-out (system) suppression must expire once past the configured window, unlike Not Interested"
  );
  resetAppSettings();
});

test("a system-generated (aged-out) suppression still holds while within the configured window", () => {
  resetAppSettings();
  updateAppSettings({ suppression: { expiredJobSuppressionDays: 30 } });

  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-expired-2");

  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO suppressed_jobs (dedupe_key, company_id, title, reason, suppressed_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(key, company.id, "Aged Out Test 2", "Aged out: 11 days unapplied", fiveDaysAgo);

  const outcome = seedJob(company.id, key, { title: "Reposted too soon" });
  assert.equal(outcome, "suppressed", "must still be suppressed — only 5 of the configured 30 days have elapsed");
  resetAppSettings();
});

// --- Scanner wiring (globalThis.fetch substituted — no real network) --------------------------

test("runScan retries exactly DEFAULT_SETTINGS.scanner.maxAttempts (3) with no Settings override", async () => {
  resetAppSettings();
  const company = makeCompany();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("error", { status: 500 });
  }) as typeof fetch;
  try {
    const summary = await runScan([company]);
    assert.equal(summary.errors, 1, "a connector that never succeeds must be recorded as an error");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 3, "must retry exactly DEFAULT_SETTINGS.scanner.maxAttempts (3) times");
});

test("runScan retries exactly the configured scanner.maxAttempts once Settings are changed", async () => {
  resetAppSettings();
  const patched = updateAppSettings({ scanner: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 } });
  assert.equal(patched.ok, true, "the settings update itself must succeed (within scanner bounds)");
  const company = makeCompany();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("error", { status: 500 });
  }) as typeof fetch;
  try {
    const summary = await runScan([company]);
    assert.equal(summary.errors, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetAppSettings();
  }
  assert.equal(calls, 2, "must retry exactly the configured maxAttempts (2), not the hardcoded default of 3");
});

test("runScan honors configured scanner.concurrency when scanning multiple ATS companies", async () => {
  resetAppSettings();
  updateAppSettings({ scanner: { concurrency: 1 } });
  const companies = [makeCompany(), makeCompany(), makeCompany()];

  let inFlight = 0;
  let maxInFlight = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight--;
    return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    await runScan(companies);
  } finally {
    globalThis.fetch = originalFetch;
    resetAppSettings();
  }

  assert.equal(maxInFlight, 1, "concurrency=1 must fully serialize the three company scans");
});

test("runScan allows real parallelism once scanner.concurrency is raised", async () => {
  resetAppSettings();
  updateAppSettings({ scanner: { concurrency: 4 } });
  const companies = [makeCompany(), makeCompany(), makeCompany()];

  let inFlight = 0;
  let maxInFlight = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight--;
    return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    await runScan(companies);
  } finally {
    globalThis.fetch = originalFetch;
    resetAppSettings();
  }

  assert.ok(maxInFlight > 1, "a concurrency of 4 for 3 companies must allow more than one in flight at once");
});

// --- Failed/partial scan safety, under Settings-driven scanner values -------------------------

test("a failed scan under tightened Settings > Scanner values still never closes/archives an existing job", async () => {
  resetAppSettings();
  const patched = updateAppSettings({ scanner: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100 } });
  assert.equal(patched.ok, true, "the settings update itself must succeed (within scanner bounds)");

  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-safety-1");
  seedJob(company.id, key, { title: "Safety Test Role" });
  const jobId = listJobs({ companyId: company.id }).find((j) => j.dedupe_key === key)!.id;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("error", { status: 500 })) as typeof fetch;
  try {
    const summary = await runScan([company]);
    assert.equal(summary.errors, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetAppSettings();
  }

  const job = getJob(jobId)!;
  assert.equal(job.is_active, 1, "a failed scan must never close an existing job, regardless of scanner settings");
  assert.equal(job.is_archived, 0, "a failed scan must never archive an existing job, regardless of scanner settings");
});
