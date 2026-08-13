import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedJob, PipelineStatus } from "../../../types";

/**
 * Scanner Reliability & Observability tests — run against a real (temp, isolated) SQLite file via
 * CAREER_OPS_DB_PATH, same pattern as jobLifecycle.test.ts/dedupeRepost.test.ts. Every DB-touching
 * module is imported dynamically inside before() so the env var is set before getDb() ever opens a
 * file. A real ephemeral local HTTP server (Node's built-in `http`) stands in for a Workday tenant
 * for the end-to-end scenarios, via fetchWorkdayJobs' testing-only `hostOverride` — no mocking.
 *
 * Run with: npm test
 */

let tmpDir: string;

let getDb: typeof import("../../index").getDb;
let createCompany: typeof import("../companies").createCompany;
let recordScanSuccess: typeof import("../companies").recordScanSuccess;
let recordScanPartial: typeof import("../companies").recordScanPartial;
let recordScanFailure: typeof import("../companies").recordScanFailure;
let getCompany: typeof import("../companies").getCompany;
let upsertJob: typeof import("../jobs").upsertJob;
let getJob: typeof import("../jobs").getJob;
let getJobByDedupeKey: typeof import("../jobs").getJobByDedupeKey;
let closeStaleJobs: typeof import("../jobs").closeStaleJobs;
let updateJobPipeline: typeof import("../jobs").updateJobPipeline;
let listJobs: typeof import("../jobs").listJobs;
let recordScanRun: typeof import("../scanRuns").recordScanRun;
let getScanRun: typeof import("../scanRuns").getScanRun;
let listScanRunsForCompany: typeof import("../scanRuns").listScanRunsForCompany;
let dedupeKeyForAts: typeof import("../../../lib/dedupe").dedupeKeyForAts;
let computeConnectorHealth: typeof import("../../../lib/scan/health").computeConnectorHealth;
let determineScanStatus: typeof import("../../../lib/scan/status").determineScanStatus;
let canRunLifecycleActions: typeof import("../../../lib/scan/status").canRunLifecycleActions;
let hasContentChanged: typeof import("../../../lib/scan/status").hasContentChanged;
let fetchWorkdayJobs: typeof import("../../../lib/ats/workday").fetchWorkdayJobs;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scan-reliability-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("../../index"));
  ({ createCompany, recordScanSuccess, recordScanPartial, recordScanFailure, getCompany } = await import(
    "../companies"
  ));
  ({ upsertJob, getJob, getJobByDedupeKey, closeStaleJobs, updateJobPipeline, listJobs } = await import("../jobs"));
  ({ recordScanRun, getScanRun, listScanRunsForCompany } = await import("../scanRuns"));
  ({ dedupeKeyForAts } = await import("../../../lib/dedupe"));
  ({ computeConnectorHealth } = await import("../../../lib/scan/health"));
  ({ determineScanStatus, canRunLifecycleActions, hasContentChanged } = await import("../../../lib/scan/status"));
  ({ fetchWorkdayJobs } = await import("../../../lib/ats/workday"));

  getDb(); // ensure schema + migrations have run
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let companyCounter = 0;
function makeCompany(sourceType: "greenhouse" | "workday" | "career_link" = "greenhouse") {
  companyCounter++;
  return createCompany({
    name: `Scan Reliability Test Co ${companyCounter}`,
    source_type: sourceType,
    ats_board_token: sourceType === "workday" ? `wdtok-${companyCounter}|wd5|External` : `token-${companyCounter}`,
    career_page_url: sourceType === "career_link" ? `https://acme${companyCounter}.example.com/careers` : undefined,
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

// --- Pure decision functions (src/lib/scan/status.ts, src/lib/scan/health.ts) -----------------

test("determineScanStatus: success with 0 description failures, partial otherwise", () => {
  assert.equal(determineScanStatus(0), "success");
  assert.equal(determineScanStatus(1), "partial");
  assert.equal(determineScanStatus(5), "partial");
});

test("canRunLifecycleActions: only a successful ATS scan may act on missing jobs", () => {
  assert.equal(canRunLifecycleActions("success", "greenhouse"), true);
  assert.equal(canRunLifecycleActions("success", "workday"), true);
  assert.equal(canRunLifecycleActions("partial", "greenhouse"), false, "partial never closes jobs");
  assert.equal(canRunLifecycleActions("failed", "greenhouse"), false, "failed never closes jobs");
  assert.equal(canRunLifecycleActions("success", "career_link"), false, "career_link is never authoritative");
});

test("hasContentChanged detects a real diff and ignores byte-identical content", () => {
  const before = getJob0Stub();
  assert.equal(hasContentChanged(before, makeNormalizedJob({ title: before.title })), false);
  assert.equal(hasContentChanged(before, makeNormalizedJob({ title: "Something else" })), true);
});

function getJob0Stub() {
  // Minimal Job-shaped stub covering only the fields hasContentChanged reads.
  return {
    title: "Test Role",
    location: null,
    department: null,
    url: "https://example.com/job",
    description_html: null,
    description_text: null,
    employment_type: null,
    workplace_type: null,
    salary_text: null,
    posted_at: null,
  } as import("../../../types").Job;
}

test("computeConnectorHealth thresholds", () => {
  assert.equal(computeConnectorHealth(0), "healthy");
  assert.equal(computeConnectorHealth(1), "degraded");
  assert.equal(computeConnectorHealth(2), "degraded");
  assert.equal(computeConnectorHealth(3), "down");
  assert.equal(computeConnectorHealth(10), "down");
});

// --- Company health persistence (src/db/queries/companies.ts) ---------------------------------

test("recordScanFailure increments consecutive_failures and derives connector_health", () => {
  const company = makeCompany();
  recordScanFailure(company.id, { errorCategory: "provider_5xx", errorMessage: "500 from board" });
  let updated = getCompany(company.id)!;
  assert.equal(updated.consecutive_failures, 1);
  assert.equal(updated.connector_health, "degraded");
  assert.equal(updated.last_error_category, "provider_5xx");
  assert.ok(updated.last_failed_scan_at);

  recordScanFailure(company.id, { errorCategory: "timeout", errorMessage: "timed out" });
  recordScanFailure(company.id, { errorCategory: "timeout", errorMessage: "timed out again" });
  updated = getCompany(company.id)!;
  assert.equal(updated.consecutive_failures, 3);
  assert.equal(updated.connector_health, "down");
  assert.equal(updated.last_error_category, "timeout");
});

test("recordScanSuccess resets the failure streak but keeps the last error as history", () => {
  const company = makeCompany();
  recordScanFailure(company.id, { errorCategory: "network", errorMessage: "connection refused" });
  recordScanFailure(company.id, { errorCategory: "network", errorMessage: "connection refused" });
  assert.equal(getCompany(company.id)!.consecutive_failures, 2);

  recordScanSuccess(company.id);
  const updated = getCompany(company.id)!;
  assert.equal(updated.consecutive_failures, 0, "failure streak resets on success");
  assert.equal(updated.connector_health, "healthy");
  assert.ok(updated.last_successful_scan_at);
  assert.equal(updated.last_error_category, "network", "last error stays as history, not cleared");
});

test("recordScanPartial marks connector_health degraded without touching the failure streak", () => {
  const company = makeCompany();
  recordScanSuccess(company.id); // consecutive_failures = 0, connector_health = healthy
  recordScanPartial(company.id, { errorCategory: null, errorMessage: "1 job description failed" });
  const updated = getCompany(company.id)!;
  assert.equal(updated.consecutive_failures, 0, "a partial scan is not a failure");
  assert.equal(updated.connector_health, "degraded");
  assert.equal(updated.last_error_message, "1 job description failed");
});

// --- scan_runs persistence (src/db/queries/scanRuns.ts) ----------------------------------------

test("recordScanRun persists every field and is retrievable", () => {
  const company = makeCompany();
  const id = recordScanRun({
    companyId: company.id,
    provider: "greenhouse",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 5000,
    status: "partial",
    jobsDiscovered: 10,
    jobsAdded: 3,
    jobsUpdated: 2,
    jobsUnchanged: 4,
    duplicatesSkipped: 1,
    jobsClosed: 0,
    jobsArchived: 0,
    descriptionFailures: 2,
    retryCount: 3,
    errorCategory: null,
    errorMessage: "2 job description(s) failed to fetch after retries",
  });

  const run = getScanRun(id)!;
  assert.equal(run.company_id, company.id);
  assert.equal(run.provider, "greenhouse");
  assert.equal(run.duration_ms, 5000);
  assert.equal(run.status, "partial");
  assert.equal(run.jobs_discovered, 10);
  assert.equal(run.jobs_added, 3);
  assert.equal(run.jobs_updated, 2);
  assert.equal(run.jobs_unchanged, 4);
  assert.equal(run.duplicates_skipped, 1);
  assert.equal(run.jobs_deleted, 0, "jobs_deleted defaults to 0 — see schema.sql's doc comment");
  assert.equal(run.description_failures, 2);
  assert.equal(run.retry_count, 3);
  assert.equal(run.error_message, "2 job description(s) failed to fetch after retries");

  const history = listScanRunsForCompany(company.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].company_name, company.name);
});

// --- Safety rule, driven through the real functions scan.ts calls in the same sequence --------

test("a partial scan's gate (canRunLifecycleActions) blocks closeStaleJobs — missing job stays active", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  // Mirrors scan.ts's exact sequence: a job's description fetch failed (descriptionFailures=1),
  // so this scan is "partial" and its close-stale-jobs step must be skipped entirely.
  const status = determineScanStatus(1);
  assert.equal(status, "partial");
  const seenDedupeKeys: string[] = []; // the job would appear "missing" if closeStaleJobs ran
  if (canRunLifecycleActions(status, company.source_type)) {
    closeStaleJobs(company.id, seenDedupeKeys);
  }

  const job = getJob(jobId)!;
  assert.equal(job.is_active, 1, "a partial scan must never close a job, even one genuinely missing from the list");
  assert.equal(job.is_archived, 0);
});

test("a failed scan's gate blocks closeStaleJobs — missing job stays active", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  const status = "failed" as const;
  if (canRunLifecycleActions(status, company.source_type)) {
    closeStaleJobs(company.id, []);
  }

  assert.equal(getJob(jobId)!.is_active, 1, "a failed scan must never close jobs");
});

test("a successful scan's gate allows closeStaleJobs — a genuinely missing job is closed", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");
  seedJob(company.id, key);
  const jobId = listJobs({ companyId: company.id })[0].id;

  const status = determineScanStatus(0);
  assert.equal(status, "success");
  if (canRunLifecycleActions(status, company.source_type)) {
    closeStaleJobs(company.id, []); // the job's dedupe_key is not in the "seen" set
  }

  const job = getJob(jobId)!;
  assert.equal(job.is_active, 0, "a successful authoritative scan can close a job that disappeared");
  assert.equal(job.is_archived, 1);
});

// --- jobs_unchanged vs. jobs_updated bucketing, using the real DB lookup scan.ts uses ----------

test("re-scanning with byte-identical content classifies as unchanged, not updated", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");
  seedJob(company.id, key, { title: "Data Engineer", location: "Remote" });

  const job = makeNormalizedJob({ title: "Data Engineer", location: "Remote" });
  const before = getJobByDedupeKey(key)!;
  const outcome = seedJob(company.id, key, { title: "Data Engineer", location: "Remote" });

  assert.equal(outcome, "updated", "upsertJob's own contract is unchanged — always 'updated' on refresh");
  assert.equal(hasContentChanged(before, job), false, "but the content itself is identical -> jobs_unchanged");
});

test("re-scanning with a real content change classifies as updated", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");
  seedJob(company.id, key, { title: "Data Engineer" });

  const before = getJobByDedupeKey(key)!;
  const job = makeNormalizedJob({ title: "Senior Data Engineer" });
  const outcome = seedJob(company.id, key, { title: "Senior Data Engineer" });

  assert.equal(outcome, "updated");
  assert.equal(hasContentChanged(before, job), true);
});

// --- End-to-end via a real local HTTP server standing in for a Workday tenant ------------------

function startWorkdayServer(handler: {
  list: (req: http.IncomingMessage, res: http.ServerResponse, requestCount: number) => void;
  detail: (req: http.IncomingMessage, res: http.ServerResponse, path: string, requestCount: number) => void;
}) {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    const url = req.url ?? "";
    if (req.method === "POST" && url.endsWith("/jobs")) {
      handler.list(req, res, count);
    } else {
      handler.detail(req, res, url, count);
    }
  });
  return new Promise<{ origin: string; server: http.Server; getCount: () => number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, server, getCount: () => count });
    });
  });
}

function jsonRes(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const WORKDAY_TOKEN = "acme|wd5|External";
const CXS_PREFIX = "/wday/cxs/acme/External";

test("workday e2e: a fully successful scan (list + all details 200) discovers jobs with no retries", async () => {
  const { origin, server } = await startWorkdayServer({
    list: (_req, res) =>
      jsonRes(res, 200, {
        total: 1,
        jobPostings: [{ title: "Backend Engineer", externalPath: `${CXS_PREFIX}/job1` }],
      }),
    detail: (_req, res) =>
      jsonRes(res, 200, { jobPostingInfo: { title: "Backend Engineer", jobDescription: "<p>Do stuff</p>" } }),
  });
  try {
    let retries = 0;
    const jobs = await fetchWorkdayJobs(WORKDAY_TOKEN, { hostOverride: origin, onRetry: () => retries++ });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].descriptionText, "Do stuff");
    assert.equal(retries, 0);
    assert.equal(determineScanStatus(jobs.filter((j) => !j.descriptionText).length), "success");
  } finally {
    server.close();
  }
});

test("workday e2e: a detail fetch that exhausts retries yields a partial scan that never closes jobs", async () => {
  const company = makeCompany("workday");
  const key = dedupeKeyForAts("workday", company.id, "will-disappear");
  seedJob(company.id, key, { externalId: "will-disappear" });
  const missingJobId = listJobs({ companyId: company.id })[0].id;

  const { origin, server } = await startWorkdayServer({
    list: (_req, res) =>
      jsonRes(res, 200, {
        total: 1,
        jobPostings: [{ title: "Frontend Engineer", externalPath: `${CXS_PREFIX}/job1` }],
      }),
    // Always fails -> fetchDetail's retry budget is exhausted -> workday.ts's own fallback kicks
    // in and returns a job with descriptionText: null, rather than throwing.
    detail: (_req, res) => jsonRes(res, 503, { error: "unavailable" }),
  });
  try {
    let retries = 0;
    const jobs = await fetchWorkdayJobs(WORKDAY_TOKEN, {
      hostOverride: origin,
      onRetry: () => retries++,
      maxAttempts: 2,
      baseDelayMs: 1,
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].descriptionText, null, "the detail fetch permanently failed");
    assert.ok(retries > 0, "the detail fetch was retried before giving up");

    const descriptionFailures = jobs.filter((j) => !j.descriptionText).length;
    const status = determineScanStatus(descriptionFailures);
    assert.equal(status, "partial");

    // Mirrors scan.ts: seenDedupeKeys is built from what the list phase returned (job1, not the
    // seeded "will-disappear" job) — a successful scan would close the missing job, but this is
    // partial, so the close step must be skipped.
    if (canRunLifecycleActions(status, "workday")) {
      closeStaleJobs(company.id, []);
    }
    assert.equal(getJob(missingJobId)!.is_active, 1, "partial scan must not close the missing job");
  } finally {
    server.close();
  }
});

test("workday e2e: a detail fetch that permanently fails still recovers the same dedupe identity a successful fetch would have produced", async () => {
  // externalPath follows Workday's conventional "<slug>_<reqId>[-N]" shape, same as real tenant
  // data observed in this project's own database (see reqIdFromExternalPath's doc comment in
  // src/lib/ats/workday.ts) — the requisition ID "JR1561" is recoverable from the path alone,
  // without needing the detail fetch that failed.
  const externalPath = `${CXS_PREFIX}/job/Some-Title_JR1561-1`;

  const { origin: failOrigin, server: failServer } = await startWorkdayServer({
    list: (_req, res) => jsonRes(res, 200, { total: 1, jobPostings: [{ title: "Some Title", externalPath }] }),
    detail: (_req, res) => jsonRes(res, 503, { error: "unavailable" }),
  });
  const { origin: okOrigin, server: okServer } = await startWorkdayServer({
    list: (_req, res) => jsonRes(res, 200, { total: 1, jobPostings: [{ title: "Some Title", externalPath }] }),
    detail: (_req, res) =>
      jsonRes(res, 200, { jobPostingInfo: { title: "Some Title", jobDescription: "<p>Do stuff</p>", jobReqId: "JR1561" } }),
  });
  try {
    const failedJobs = await fetchWorkdayJobs(WORKDAY_TOKEN, {
      hostOverride: failOrigin,
      maxAttempts: 1,
      baseDelayMs: 1,
    });
    const okJobs = await fetchWorkdayJobs(WORKDAY_TOKEN, { hostOverride: okOrigin });

    assert.equal(failedJobs[0].externalId, "JR1561", "recovered from externalPath despite the detail fetch failing");
    assert.equal(okJobs[0].externalId, "JR1561", "matches jobReqId from a successful detail fetch");
    assert.equal(
      dedupeKeyForAts("workday", 1, failedJobs[0].externalId!),
      dedupeKeyForAts("workday", 1, okJobs[0].externalId!),
      "same posting must resolve to the same dedupe_key whether or not the detail fetch succeeded"
    );
  } finally {
    failServer.close();
    okServer.close();
  }
});

test("workday e2e: a listing with only a requisition ID becomes a sighting-only partial record", async () => {
  const { origin, server, getCount } = await startWorkdayServer({
    list: (_req, res) =>
      jsonRes(res, 200, { total: 1, jobPostings: [{ bulletFields: ["JR196045"] }] }),
    detail: (_req, res) => jsonRes(res, 500, { error: "detail must not be requested" }),
  });
  try {
    const jobs = await fetchWorkdayJobs(WORKDAY_TOKEN, { hostOverride: origin });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].externalId, "JR196045");
    assert.equal(jobs[0].sightingOnly, true);
    assert.equal(jobs[0].descriptionText, null);
    assert.equal(getCount(), 1, "an unusable path must never trigger a detail request");
    assert.equal(determineScanStatus(jobs.filter((job) => job.sightingOnly || !job.descriptionText).length), "partial");
  } finally {
    server.close();
  }
});

test("workday e2e: maxJobs bounds list paging and detail fetches for connector verification", async () => {
  const postings = Array.from({ length: 20 }, (_, index) => ({
    title: `Role ${index + 1}`,
    externalPath: `${CXS_PREFIX}/job/Role-${index + 1}_JR${index + 1}`,
  }));
  const { origin, server, getCount } = await startWorkdayServer({
    list: (_req, res) => jsonRes(res, 200, { total: 100, jobPostings: postings }),
    detail: (_req, res, path) =>
      jsonRes(res, 200, {
        jobPostingInfo: { title: path, jobDescription: "<p>Sample</p>" },
      }),
  });
  try {
    const jobs = await fetchWorkdayJobs(WORKDAY_TOKEN, { hostOverride: origin, maxJobs: 3 });
    assert.equal(jobs.length, 3);
    assert.equal(getCount(), 4, "one list request plus exactly three detail requests");
  } finally {
    server.close();
  }
});

test("workday e2e: list-phase retry exhaustion fails the whole scan (never reaches job data)", async () => {
  const { origin, server, getCount } = await startWorkdayServer({
    list: (_req, res) => jsonRes(res, 500, { error: "boom" }),
    detail: (_req, res) => jsonRes(res, 200, { jobPostingInfo: {} }),
  });
  try {
    await assert.rejects(() =>
      fetchWorkdayJobs(WORKDAY_TOKEN, { hostOverride: origin, maxAttempts: 2, baseDelayMs: 1 })
    );
    assert.equal(getCount(), 2, "the list endpoint was retried once before giving up");
  } finally {
    server.close();
  }
});

test("workday e2e: 429 on the list phase retries once and succeeds", async () => {
  const { origin, server, getCount } = await startWorkdayServer({
    list: (_req, res, count) => {
      if (count === 1) return jsonRes(res, 429, { error: "rate limited" });
      jsonRes(res, 200, { total: 0, jobPostings: [] });
    },
    detail: (_req, res) => jsonRes(res, 200, { jobPostingInfo: {} }),
  });
  try {
    let retries = 0;
    const jobs = await fetchWorkdayJobs(WORKDAY_TOKEN, { hostOverride: origin, onRetry: () => retries++, baseDelayMs: 1 });
    assert.equal(jobs.length, 0);
    assert.equal(retries, 1);
    assert.equal(getCount(), 2);
  } finally {
    server.close();
  }
});

test("failure counters reset after success: a company recovers cleanly after prior failures", () => {
  const company = makeCompany();
  recordScanFailure(company.id, { errorCategory: "provider_5xx", errorMessage: "500" });
  recordScanFailure(company.id, { errorCategory: "provider_5xx", errorMessage: "500" });
  assert.equal(getCompany(company.id)!.consecutive_failures, 2);

  recordScanSuccess(company.id);
  assert.equal(getCompany(company.id)!.consecutive_failures, 0);
  assert.equal(getCompany(company.id)!.connector_health, "healthy");

  // A subsequent failure starts the streak fresh from 1, not 3.
  recordScanFailure(company.id, { errorCategory: "timeout", errorMessage: "timed out" });
  assert.equal(getCompany(company.id)!.consecutive_failures, 1);
});

// --- Preserved existing behavior: pipeline/notes/tags survive, dedupe unaffected ---------------

test("existing lifecycle/dedupe behavior is unaffected by the new scan-run bookkeeping", () => {
  const company = makeCompany();
  const key = dedupeKeyForAts("greenhouse", company.id, "req-1");
  seedJob(company.id, key, { title: "Original" });
  const jobId = listJobs({ companyId: company.id })[0].id;
  updateJobPipeline(jobId, { pipelineStatus: "Applied" as PipelineStatus, notes: "note" });

  seedJob(company.id, key, { title: "Rescanned" });

  const job = getJob(jobId)!;
  assert.equal(job.title, "Rescanned");
  assert.equal(job.pipeline_status, "Applied", "pipeline status still survives a rescan refresh");
  assert.equal(job.notes, "note");
  assert.equal(listJobs({ companyId: company.id }).length, 1, "still no duplicate row");
});
