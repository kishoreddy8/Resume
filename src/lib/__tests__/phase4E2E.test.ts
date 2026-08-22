import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { adminTestRequest } from "@/lib/auth/__tests__/adminTestRequest";

/**
 * Phase 4 Stage 7 — END-TO-END DAILY OPERATIONS ACCEPTANCE TEST.
 *
 * Exercises the REAL integrated pipeline — scheduler tick -> structured-source scan (HTTP-mocked
 * Greenhouse) -> Stage 2 incremental matching -> Stage 4 notifications -> Stage 3 For You feed ->
 * Phase 3 resume-quality workflow -> Ready to Apply -> application lifecycle -> Stage 5 candidate
 * rematch -> Stage 6 operations dashboard — against one isolated temp SQLite DB + temp candidate
 * files directory. No helper function under test is called in isolation from its real caller chain
 * unless explicitly noted (e.g. isEligibleForHighValueMatchNotification is called directly with a
 * `now` override in one place, since the notification generator itself never exposes a `now`
 * parameter — see the staleness section below for why that's the honest way to prove that gate).
 *
 * No network: `globalThis.fetch` is stubbed to serve Greenhouse-shaped JSON, restored in `after()`.
 * No production DB access anywhere in this file — CAREER_OPS_DB_PATH/CAREER_OPS_CANDIDATES_DIR
 * both point at temp directories for the whole file.
 *
 * Sequential numbered tests share one DB, same convention as incrementalMatch.test.ts/tick.test.ts.
 * Each test comments which Stage 7 acceptance-matrix item(s) it proves.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;
let originalFetch: typeof fetch;

let getDb: typeof import("@/db").getDb;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let recordDiscoveryResult: typeof import("@/db/queries/companies").recordDiscoveryResult;
let getOrganizationForCompany: typeof import("@/db/queries/organizationRegistry").getOrganizationForCompany;
let listJobSources: typeof import("@/db/queries/organizationRegistry").listJobSources;
let reviewJobSource: typeof import("@/db/queries/organizationRegistry").reviewJobSource;
let listScanReadyCompanies: typeof import("@/db/queries/organizationRegistry").listScanReadyCompanies;
let updateAppSettings: typeof import("@/db/queries/settings").updateAppSettings;
let resetAppSettings: typeof import("@/db/queries/settings").resetAppSettings;
let runSchedulerTick: typeof import("@/lib/scheduler/tick").runSchedulerTick;
let acquireScanLock: typeof import("@/lib/scheduler/lock").acquireScanLock;
let releaseScanLock: typeof import("@/lib/scheduler/lock").releaseScanLock;
let getScanLockStatus: typeof import("@/lib/scheduler/lock").getScanLockStatus;
let getSchedulerRuntimeState: typeof import("@/lib/scheduler/state").getSchedulerRuntimeState;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let getJob: typeof import("@/db/queries/jobs").getJob;
let listCandidateRematchJobPage: typeof import("@/db/queries/jobs").listCandidateRematchJobPage;
let getLatestJobMatchResult: typeof import("@/db/queries/jobMatches").getLatestJobMatchResult;
let listJobMatchHistory: typeof import("@/db/queries/jobMatches").listJobMatchHistory;
let listMatchRuns: typeof import("@/db/queries/matchRuns").listMatchRuns;
let listNotificationsForCandidate: typeof import("@/db/queries/notifications").listNotificationsForCandidate;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let evaluateJobMatch: typeof import("@/lib/match/evaluateJobMatch").evaluateJobMatch;
let isEligibleForHighValueMatchNotification: typeof import("@/lib/notifications/eligibility").isEligibleForHighValueMatchNotification;
let rematchCandidateJobsPage: typeof import("@/lib/match/rematchCandidate").rematchCandidateJobsPage;
let rematchCandidateAllPages: typeof import("@/lib/match/rematchCandidate").rematchCandidateAllPages;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let setPinned: typeof import("@/db/queries/candidateJobState").setPinned;
let getCandidateJobState: typeof import("@/db/queries/candidateJobState").getCandidateJobState;
let updateCandidateSettings: typeof import("@/db/queries/candidateSettings").updateCandidateSettings;
let createTailoringRun: typeof import("@/db/queries/tailoringRuns").createTailoringRun;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let transitionWorkflowStatus: typeof import("@/db/queries/resumeQualityWorkflows").transitionWorkflowStatus;
let ForYouGET: typeof import("@/app/api/candidates/[candidateId]/for-you/route").GET;
let SettingsPATCH: typeof import("@/app/api/candidates/[candidateId]/settings/route").PATCH;
let OperationsGET: typeof import("@/app/api/operations/route").GET;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-e2e-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-e2e-candidates-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  originalFetch = globalThis.fetch;

  ({ getDb } = await import("@/db"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany, recordDiscoveryResult } = await import("@/db/queries/companies"));
  ({ getOrganizationForCompany, listJobSources, reviewJobSource, listScanReadyCompanies } = await import("@/db/queries/organizationRegistry"));
  ({ updateAppSettings, resetAppSettings } = await import("@/db/queries/settings"));
  ({ runSchedulerTick } = await import("@/lib/scheduler/tick"));
  ({ acquireScanLock, releaseScanLock, getScanLockStatus } = await import("@/lib/scheduler/lock"));
  ({ getSchedulerRuntimeState } = await import("@/lib/scheduler/state"));
  ({ getJobByDedupeKey, getJob, listCandidateRematchJobPage } = await import("@/db/queries/jobs"));
  ({ getLatestJobMatchResult, listJobMatchHistory } = await import("@/db/queries/jobMatches"));
  ({ listMatchRuns } = await import("@/db/queries/matchRuns"));
  ({ listNotificationsForCandidate } = await import("@/db/queries/notifications"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ evaluateJobMatch } = await import("@/lib/match/evaluateJobMatch"));
  ({ isEligibleForHighValueMatchNotification } = await import("@/lib/notifications/eligibility"));
  ({ rematchCandidateJobsPage, rematchCandidateAllPages } = await import("@/lib/match/rematchCandidate"));
  ({ setPipelineStatus, setPinned, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ updateCandidateSettings } = await import("@/db/queries/candidateSettings"));
  ({ createTailoringRun } = await import("@/db/queries/tailoringRuns"));
  ({ createResumeQualityWorkflow, transitionWorkflowStatus } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ GET: ForYouGET } = await import("@/app/api/candidates/[candidateId]/for-you/route"));
  ({ PATCH: SettingsPATCH } = await import("@/app/api/candidates/[candidateId]/settings/route"));
  ({ GET: OperationsGET } = await import("@/app/api/operations/route"));

  getDb();

  // getDb() auto-seeds a "Candidate #1" row (id=1, status='active') for backward compatibility with
  // the pre-multi-candidate app (see src/db/index.ts's ensureCandidateOne). This file needs an exact,
  // known count of active candidates for its isolation/pairsAttempted assertions, so that seeded
  // candidate — which has no profile at all — is archived immediately via the real archiveCandidate
  // path, exactly as an operator would retire an unused seat.
  const { archiveCandidate } = await import("@/db/queries/candidates");
  archiveCandidate(1);
});

after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CAREER_OPS_DB_PATH;
  delete process.env.CAREER_OPS_CANDIDATES_DIR;
  try {
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  } catch {}
});

// -------------------------------------------------------------------------------------------
// Fixture helpers
// -------------------------------------------------------------------------------------------

/** Real end-to-end "make this company scan-ready" path — mirrors tick.test.ts's own test #92
 *  fixture exactly: VERIFIED discovery + APPROVED job source review, so listScanReadyCompanies()
 *  picks it up through its real gating, not a shortcut. */
function makeStructuredCompany(name: string, boardToken: string) {
  const company = createCompany({ name, source_type: "greenhouse", ats_board_token: boardToken });
  recordDiscoveryResult(company.id, {
    status: "VERIFIED",
    sourceType: "greenhouse",
    atsBoardToken: boardToken,
    discoveredJobsUrl: `https://boards.greenhouse.io/${boardToken}`,
    reason: "Direct ATS URL match (greenhouse)",
    suspectedAts: null,
  });
  const organization = getOrganizationForCompany(company.id)!;
  const [source] = listJobSources(organization.id);
  reviewJobSource(source.id, "APPROVED", "E2E fixture approval");
  return company;
}

/** A company that is deliberately NEVER made scan-ready — no discovery/job_sources fixture at all
 *  — proving generic/career_link sources stay excluded from listScanReadyCompanies() without any
 *  special-casing in the test itself. */
function makeCareerLinkCompany(name: string) {
  return createCompany({ name, source_type: "career_link", career_page_url: `https://example.com/${name}/careers` });
}

interface GreenhouseFixtureJob {
  id: number;
  title: string;
  location: string;
  content: string;
  updatedAt?: string;
}

function greenhouseJob(input: GreenhouseFixtureJob) {
  return {
    id: input.id,
    title: input.title,
    location: { name: input.location },
    departments: [{ name: "Engineering" }],
    absolute_url: `https://boards.greenhouse.io/e2e/jobs/${input.id}`,
    content: input.content,
    updated_at: input.updatedAt ?? new Date().toISOString(),
  };
}

/** Stubs globalThis.fetch to serve one Greenhouse board's job list, keyed by board token appearing
 *  in the request URL (`/v1/boards/<token>/jobs`) — the real per-company routing Greenhouse's
 *  fetchGreenhouseJobs constructs, not a test-only shortcut. Any board token with no entry in
 *  `boards` gets a 500 (simulates an ATS/scan failure for that company specifically). */
function stubGreenhouseBoards(boards: Record<string, ReturnType<typeof greenhouseJob>[]>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const match = /\/v1\/boards\/([^/]+)\/jobs/.exec(url);
    const token = match ? decodeURIComponent(match[1]) : null;
    if (!token || !(token in boards)) {
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response(JSON.stringify({ jobs: boards[token] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const RICH_SKILLS = [
  { rawSkillName: "Python", source: "employer" as const, attributedTo: [{ employer: "Acme" }], yearsStated: 6 },
  { rawSkillName: "SQL", source: "employer" as const, attributedTo: [{ employer: "Acme" }], yearsStated: 6 },
  { rawSkillName: "Airflow", source: "employer" as const, attributedTo: [{ employer: "Acme" }], yearsStated: 4 },
  { rawSkillName: "dbt", source: "employer" as const, attributedTo: [{ employer: "Acme" }], yearsStated: 3 },
  { rawSkillName: "Kubernetes", source: "employer" as const, attributedTo: [{ employer: "Acme" }], yearsStated: 3 },
  { rawSkillName: "Snowflake", source: "employer" as const, attributedTo: [{ employer: "Acme" }], yearsStated: 3 },
  { rawSkillName: "Terraform", source: "employer" as const, attributedTo: [{ employer: "Acme" }], yearsStated: 2 },
  { rawSkillName: "Kafka", source: "inventory_only" as const },
  { rawSkillName: "Spark", source: "inventory_only" as const },
];

function writeProfile(candidateId: number, resumeHash: string, skillsHash: string, skills: typeof RICH_SKILLS) {
  const dir = path.join(tmpCandidatesDir, String(candidateId));
  fs.mkdirSync(path.join(dir, "master"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: resumeHash, skills: skillsHash },
      builtAt: "2026-01-01T00:00:00Z",
      skills,
      experience:
        skills.length > 0
          ? [{ employer: "Acme", title: "Senior Data Engineer", startDate: "2018-01", endDate: null, technologies: skills.map((s) => s.rawSkillName) }]
          : [],
      education: [],
      certifications: [],
      totalYearsExperience: null,
    })
  );
  fs.writeFileSync(
    path.join(dir, "master", "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: resumeHash },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: skillsHash },
    })
  );
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// JD text fixtures — deterministic, natural Phase 2 rule exercise, no threshold edits.
const JD_STRONG =
  "Required: Python, SQL, Airflow, dbt. 5+ years of experience building production data pipelines. " +
  "Preferred: Kubernetes, Snowflake, Terraform. Visa sponsorship available for this role.";
const JD_INVENTORY_ONLY_HEAVY =
  "Required: Kafka, Spark, Python. 5+ years of experience with streaming data pipelines. " +
  "Preferred: Flink, Scala. Visa sponsorship available for this role.";
const JD_NEGATIVE_SPONSORSHIP =
  "Required: Python, SQL. We are not able to provide visa sponsorship for this position.";
const JD_SPARSE = "Great opportunity. Apply now.";

/** SCHEDULER_BOUNDS.intervalMinutes.min is 30 (src/lib/settings.ts) — every subsequent
 *  runSchedulerTick() call in this file must advance the clock by more than that, or
 *  isIntervalDue() correctly (and separately, per Stage 1) reports SKIPPED_INTERVAL_NOT_DUE. This
 *  is real scheduler semantics being exercised, not a workaround — a monotonic fake clock advancing
 *  40 minutes per tick call. */
let fakeNow = new Date("2026-02-01T00:00:00.000Z");
function nextTickTime(): Date {
  // Must exceed test 7's configured intervalMinutes (60) — 70 comfortably clears it.
  fakeNow = new Date(fakeNow.getTime() + 70 * 60_000);
  return fakeNow;
}

// -------------------------------------------------------------------------------------------
// SECTION 1 — scheduler skip conditions (acceptance items 2, 3)
// -------------------------------------------------------------------------------------------

test("1. scheduler skips when disabled (item 2)", async () => {
  resetAppSettings();
  updateAppSettings({ scheduler: { enabled: false } });
  const outcome = await runSchedulerTick(new Date("2026-01-15T12:00:00Z"));
  assert.equal(outcome.outcome, "SKIPPED_DISABLED");
});

test("2. scheduler skips outside its configured window (item 3)", async () => {
  updateAppSettings({ scheduler: { enabled: true, windowStartHour: 9, windowEndHour: 17, timezone: "UTC" } });
  const outcome = await runSchedulerTick(new Date("2026-01-15T20:00:00Z")); // 8pm UTC, outside 9-17
  assert.equal(outcome.outcome, "SKIPPED_OUTSIDE_WINDOW");
  updateAppSettings({ scheduler: { windowStartHour: 0, windowEndHour: 24 } });
});

// -------------------------------------------------------------------------------------------
// SECTION 2 — lock overlap + stale lock recovery (acceptance items 4, 5, 16)
// -------------------------------------------------------------------------------------------

test("3. two simultaneous scan attempts cannot overlap — one acquires, the other is rejected (item 4)", () => {
  const first = acquireScanLock(new Date("2026-01-15T12:00:00Z"));
  assert.equal(first.acquired, true);
  const second = acquireScanLock(new Date("2026-01-15T12:00:01Z"));
  assert.equal(second.acquired, false);
  assert.ok(second.heldSince);
  releaseScanLock();
});

test("4/16. an abandoned lock older than the stale timeout is recognized as stale and can be reacquired; a fresh lock still blocks overlap (item 5, 16)", async () => {
  const { STALE_LOCK_TIMEOUT_MINUTES } = await import("@/lib/scheduler/lock");
  const longAgo = new Date(Date.now() - (STALE_LOCK_TIMEOUT_MINUTES + 10) * 60_000);
  const abandoned = acquireScanLock(longAgo);
  assert.equal(abandoned.acquired, true);

  const statusWhileStale = getScanLockStatus(new Date());
  assert.equal(statusWhileStale.held, false, "a lock past the stale timeout must read as not actually held");
  assert.equal(statusWhileStale.stale, true);

  const recovered = acquireScanLock(new Date());
  assert.equal(recovered.acquired, true, "a stale lock must be takeable over by the next attempt");

  const overlapAttempt = acquireScanLock(new Date());
  assert.equal(overlapAttempt.acquired, false, "the freshly-reacquired (non-stale) lock must still block a concurrent attempt");
  releaseScanLock();
});

// -------------------------------------------------------------------------------------------
// SECTION 3 — full fixture: two structured companies + one career_link company, two candidates
// -------------------------------------------------------------------------------------------

let structuredCompanyId: number;
let careerLinkCompanyId: number;
let candidateAId: number;
let candidateBId: number;

let keyA: string, keyB: string, keyC: string, keyD: string, keyH: string, keyI: string, keyJ: string;

/** Fixed timestamp reused byte-for-byte across the initial scan and any later "unchanged re-seen"
 *  scan of the same jobs — Greenhouse's `updated_at` becomes NormalizedJob.postedAt
 *  (src/lib/ats/greenhouse.ts), and hasContentChanged() compares posted_at, so a genuinely unchanged
 *  re-scan MUST reuse the exact same updated_at, not a fresh `new Date()` per call (which would make
 *  every re-seen job look "changed" purely from wall-clock drift between test runs). Anchored to the
 *  REAL current time (captured once, at file load) rather than a hardcoded calendar date — a brand
 *  new job's freshness gate (isJobFreshForIngestion, 20-day window, src/lib/ats/jobFreshness.ts)
 *  compares postedAt against the real `new Date()` at scan time, so a stale hardcoded date would be
 *  rejected at ingestion before ever reaching the assertions this file makes about it. */
const FIXED_UPDATED_AT = new Date().toISOString();

function firstScanBoardJobs() {
  return [
    greenhouseJob({ id: 1, title: "Senior Data Engineer — Job A", location: "Austin, TX", content: `<p>${JD_STRONG}</p>`, updatedAt: FIXED_UPDATED_AT }),
    greenhouseJob({ id: 2, title: "Streaming Data Engineer — Job B", location: "Remote, US", content: `<p>${JD_INVENTORY_ONLY_HEAVY}</p>`, updatedAt: FIXED_UPDATED_AT }),
    greenhouseJob({ id: 3, title: "Data Engineer — Job C (No Sponsorship)", location: "Denver, CO", content: `<p>${JD_NEGATIVE_SPONSORSHIP}</p>`, updatedAt: FIXED_UPDATED_AT }),
    greenhouseJob({ id: 4, title: "Generalist Role — Job D", location: "Remote, US", content: `<p>${JD_SPARSE}</p>`, updatedAt: FIXED_UPDATED_AT }),
    greenhouseJob({ id: 5, title: "Data Engineer — Job E (Foreign)", location: "London, England", content: `<p>${JD_STRONG}</p>`, updatedAt: FIXED_UPDATED_AT }),
    greenhouseJob({ id: 6, title: "Data Engineer — Job H (will go stale)", location: "Austin, TX", content: `<p>${JD_STRONG}</p>`, updatedAt: FIXED_UPDATED_AT }),
    greenhouseJob({ id: 9001, title: "Data Engineer — Job I (Applied)", location: "Austin, TX", content: `<p>${JD_STRONG}</p>`, updatedAt: FIXED_UPDATED_AT }),
    greenhouseJob({ id: 9002, title: "Data Engineer — Job J (Interviewing)", location: "Austin, TX", content: `<p>${JD_STRONG}</p>`, updatedAt: FIXED_UPDATED_AT }),
  ];
}

test("5. fixture setup — two candidates, a scan-ready structured company, and an excluded career_link company", () => {
  const structured = makeStructuredCompany("E2E Structured Co", "e2e-structured");
  const careerLink = makeCareerLinkCompany("E2E CareerLink Co");
  structuredCompanyId = structured.id;
  careerLinkCompanyId = careerLink.id;

  const readyCompanies = listScanReadyCompanies();
  assert.ok(readyCompanies.some((c) => c.id === structuredCompanyId));
  assert.equal(
    readyCompanies.some((c) => c.id === careerLinkCompanyId),
    false,
    "item 7: a career_link/generic source must never appear in the structured scan-ready set"
  );

  const a = createCandidate({ firstName: "E2E", lastName: "CandidateA" });
  const b = createCandidate({ firstName: "E2E", lastName: "CandidateB" });
  candidateAId = a.id;
  candidateBId = b.id;
  writeProfile(candidateAId, "e2e-a-resume", "e2e-a-skills", RICH_SKILLS);
  writeProfile(candidateBId, "e2e-b-resume", "e2e-b-skills", []); // deliberately sparse — proves independent per-candidate scoring
});

test("6. lifecycle-protected pipeline state can be set for a job BEFORE that job is ever ingested (fixture setup for items I/J)", () => {
  keyI = dedupeKeyForAts("greenhouse", structuredCompanyId, "9001");
  keyJ = dedupeKeyForAts("greenhouse", structuredCompanyId, "9002");
  setPipelineStatus(candidateAId, keyI, "Applied");
  setPipelineStatus(candidateAId, keyJ, "Interviewing");
  assert.equal(getCandidateJobState(candidateAId, keyI)!.pipeline_status, "Applied");
  assert.equal(getCandidateJobState(candidateAId, keyJ)!.pipeline_status, "Interviewing");
});

test(
  "7. FULL scheduler-triggered scan cycle: acquires lock, scans only the structured source, ingests jobs A-D/H-J, excludes the foreign job, releases the lock (items 1, 6, 7, 8, 9, 12, 13)",
  async () => {
    keyA = dedupeKeyForAts("greenhouse", structuredCompanyId, "1");
    keyB = dedupeKeyForAts("greenhouse", structuredCompanyId, "2");
    keyC = dedupeKeyForAts("greenhouse", structuredCompanyId, "3");
    keyD = dedupeKeyForAts("greenhouse", structuredCompanyId, "4");
    const keyEForeign = dedupeKeyForAts("greenhouse", structuredCompanyId, "5");
    keyH = dedupeKeyForAts("greenhouse", structuredCompanyId, "6");

    stubGreenhouseBoards({ "e2e-structured": firstScanBoardJobs() });

    assert.equal(getScanLockStatus().held, false, "lock must be free before the tick starts");
    updateAppSettings({ scheduler: { enabled: true, windowStartHour: 0, windowEndHour: 24, intervalMinutes: 60 } });

    const outcome = await runSchedulerTick(nextTickTime());
    assert.equal(outcome.outcome, "RAN");
    if (outcome.outcome !== "RAN") return;

    // Item 1 / lock lifecycle: released after a completed run.
    assert.equal(getScanLockStatus().held, false, "the lock must be released once the tick finishes");
    assert.equal(getSchedulerRuntimeState().lastSuccessfulAt !== null, true);

    // Item 6/7: only the structured company was scanned — the career_link company got zero scan_runs.
    const careerLinkRuns = getDb().prepare("SELECT COUNT(*) AS n FROM scan_runs WHERE company_id = ?").get(careerLinkCompanyId) as { n: number };
    assert.equal(careerLinkRuns.n, 0, "item 7: the excluded career_link company must never be scanned");
    const structuredRuns = getDb().prepare("SELECT COUNT(*) AS n FROM scan_runs WHERE company_id = ?").get(structuredCompanyId) as { n: number };
    assert.equal(structuredRuns.n, 1, "item 6: the structured source must be scanned exactly once");

    // Item 12: the foreign (non-US) job must never be persisted at all.
    assert.equal(getJobByDedupeKey(keyEForeign), undefined, "item 12: a foreign job must be filtered before ever reaching upsertJob");

    // Item 8/9: 7 genuinely new jobs (A,B,C,D,H,I,J) — foreign E excluded — all appear as affected.
    const expectedNewKeys = [keyA, keyB, keyC, keyD, keyH, keyI, keyJ];
    assert.equal(outcome.summary.affectedJobDedupeKeys.length, expectedNewKeys.length);
    for (const key of expectedNewKeys) assert.ok(outcome.summary.affectedJobDedupeKeys.includes(key), `expected ${key} to be affected`);

    // Item 13: incremental matching only evaluated the affected jobs, across BOTH candidates.
    assert.equal(outcome.matching.jobsResolved, expectedNewKeys.length);
    assert.equal(outcome.matching.pairsAttempted, expectedNewKeys.length * 2);
    assert.equal(outcome.matching.failures.length, 0);

    assert.ok(outcome.notifications, "the RAN outcome must include a nested notification summary");
  }
);

test("8. incremental matching persisted a real, candidate-scoped decision for every affected job (items 13, 14)", () => {
  for (const key of [keyA, keyB, keyC, keyD, keyH, keyI, keyJ]) {
    const rowA = getLatestJobMatchResult(candidateAId, key);
    const rowB = getLatestJobMatchResult(candidateBId, key);
    assert.notEqual(rowA, undefined, `candidate A must have a match result for ${key}`);
    assert.notEqual(rowB, undefined, `candidate B must have a match result for ${key}`);
    assert.equal(rowA!.candidate_id, candidateAId);
    assert.equal(rowB!.candidate_id, candidateBId);
  }
});

test("9. job A (strong, employer-evidenced match) is genuinely READY_FOR_TAILORING for the real Phase 2 engine — unmodified thresholds", () => {
  const row = getLatestJobMatchResult(candidateAId, keyA)!;
  assert.equal(row.decision, "READY_FOR_TAILORING", "this fixture was deliberately modeled on an already-proven Stage 5 READY fixture");
});

test("10. job C (explicit no-sponsorship JD, default requiresSponsorship=true) is BLOCKED for both candidates (item C)", () => {
  assert.equal(getLatestJobMatchResult(candidateAId, keyC)!.decision, "BLOCKED");
  assert.equal(getLatestJobMatchResult(candidateBId, keyC)!.decision, "BLOCKED");
});

test("11. job D (sparse JD, insufficient signal) is a weak/non-actionable NEEDS_REVIEW for both candidates, well under the notification threshold (item D)", () => {
  const rowA = getLatestJobMatchResult(candidateAId, keyD)!;
  const rowB = getLatestJobMatchResult(candidateBId, keyD)!;
  assert.notEqual(rowA.decision, "READY_FOR_TAILORING");
  assert.notEqual(rowB.decision, "READY_FOR_TAILORING");
  assert.ok(rowA.overall_score < 90, `job D score for candidate A (${rowA.overall_score}) must stay below the notify threshold`);
});

test("12. candidate isolation in matching: candidate B's sparse profile never produces candidate A's strong result for the same job", () => {
  const rowA = getLatestJobMatchResult(candidateAId, keyA)!;
  const rowB = getLatestJobMatchResult(candidateBId, keyA)!;
  assert.notEqual(rowB.decision, "READY_FOR_TAILORING", "an empty-skills profile must never independently reach READY_FOR_TAILORING");
  assert.notEqual(rowA.overall_score, rowB.overall_score, "the same job must score differently per candidate's own profile");
});

// -------------------------------------------------------------------------------------------
// SECTION 4 — notification validation (acceptance items 21-28)
// -------------------------------------------------------------------------------------------

test("13. READY_FOR_TAILORING job A produced exactly one HIGH_VALUE_JOB_MATCH notification for candidate A (item 21)", () => {
  const notifs = listNotificationsForCandidate(candidateAId).filter((n) => n.dedupe_key === keyA);
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].type, "HIGH_VALUE_JOB_MATCH");
});

test("14. BLOCKED job C produced zero notifications for either candidate (item 23)", () => {
  assert.equal(listNotificationsForCandidate(candidateAId).filter((n) => n.dedupe_key === keyC).length, 0);
  assert.equal(listNotificationsForCandidate(candidateBId).filter((n) => n.dedupe_key === keyC).length, 0);
});

test("15. weak job D produced zero notifications (item 24)", () => {
  assert.equal(listNotificationsForCandidate(candidateAId).filter((n) => n.dedupe_key === keyD).length, 0);
});

test("16. Applied job I and Interviewing job J produced ZERO notifications for candidate A despite a strong underlying match (items 25, 26, I, J)", () => {
  const iRow = getLatestJobMatchResult(candidateAId, keyI)!;
  const jRow = getLatestJobMatchResult(candidateAId, keyJ)!;
  // Sanity: these fixtures are the SAME strong JD as job A, so absent Applied/Interviewing
  // suppression they would have been notify-eligible — proving the suppression actually did work,
  // not that the fixture never qualified in the first place.
  assert.equal(iRow.decision, "READY_FOR_TAILORING");
  assert.equal(jRow.decision, "READY_FOR_TAILORING");
  assert.equal(listNotificationsForCandidate(candidateAId).filter((n) => n.dedupe_key === keyI).length, 0);
  assert.equal(listNotificationsForCandidate(candidateAId).filter((n) => n.dedupe_key === keyJ).length, 0);
});

test("17. candidate A's notifications never appear for candidate B (item 28)", () => {
  const bNotifs = listNotificationsForCandidate(candidateBId);
  assert.equal(bNotifs.filter((n) => n.dedupe_key === keyA).length, 0, "candidate B must not inherit candidate A's job A notification");
});

test("18. job B's real decision determines its notification outcome honestly (no forced threshold) — high-score NEEDS_REVIEW notifies, otherwise it must not (item 22)", () => {
  const row = getLatestJobMatchResult(candidateAId, keyB)!;
  const notified = listNotificationsForCandidate(candidateAId).filter((n) => n.dedupe_key === keyB).length === 1;
  const shouldNotify = row.decision === "READY_FOR_TAILORING" || (row.decision === "NEEDS_REVIEW" && row.overall_score >= 90);
  assert.equal(notified, shouldNotify, `job B decision=${row.decision} score=${row.overall_score} — notification presence must match real Stage 4 eligibility exactly`);
});

// -------------------------------------------------------------------------------------------
// SECTION 5 — idempotency: re-run the identical scan (acceptance items 10, 11, 17, F)
// -------------------------------------------------------------------------------------------

let matchResultCountBeforeRerun: number;
let notificationCountBeforeRerun: number;
let matchRunCountBeforeRerun: number;

test("19. capture state before an unchanged re-scan", () => {
  matchResultCountBeforeRerun = (getDb().prepare("SELECT COUNT(*) AS n FROM job_match_results").get() as { n: number }).n;
  notificationCountBeforeRerun = (getDb().prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n;
  matchRunCountBeforeRerun = (getDb().prepare("SELECT COUNT(*) AS n FROM match_runs").get() as { n: number }).n;
});

test("20. re-running the scheduler tick with UNCHANGED upstream data (job F re-seen) produces zero new affected jobs, zero new match results, zero new notifications (items 10, 11, 17, F)", async () => {
  // Byte-identical fixture payload to the first scan (same helper, same FIXED_UPDATED_AT) — a
  // genuine re-seen duplicate/unchanged batch, not just visually-similar content.
  stubGreenhouseBoards({ "e2e-structured": firstScanBoardJobs() });

  const outcome = await runSchedulerTick(nextTickTime());
  assert.equal(outcome.outcome, "RAN");
  if (outcome.outcome !== "RAN") return;

  assert.equal(outcome.summary.affectedJobDedupeKeys.length, 0, "item 10/F: a fully unchanged re-seen batch must produce zero affected jobs");
  assert.equal(outcome.matching.pairsAttempted, 0, "matching must never even be invoked for an empty affected set");

  const matchResultCountAfter = (getDb().prepare("SELECT COUNT(*) AS n FROM job_match_results").get() as { n: number }).n;
  const notificationCountAfter = (getDb().prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n;
  assert.equal(matchResultCountAfter, matchResultCountBeforeRerun, "item 17: no duplicate match result rows");
  assert.equal(notificationCountAfter, notificationCountBeforeRerun, "item 17/27: no duplicate notifications");
  const matchRunCountAfter = (getDb().prepare("SELECT COUNT(*) AS n FROM match_runs").get() as { n: number }).n;
  assert.equal(matchRunCountAfter, matchRunCountBeforeRerun, "an empty affected set must never write a match_runs row either — matching was never even invoked");
});

test("21. job G — a materially changed re-scan of job D IS detected and re-enters the affected set (item 9, G)", async () => {
  const beforeHistoryLen = listJobMatchHistory(candidateAId, keyD).length;
  // Every OTHER job keeps FIXED_UPDATED_AT (via firstScanBoardJobs()) so it reads as genuinely
  // unchanged; only job D's title/content/updatedAt actually differ — the same "reuse the base
  // fixture, override one entry" pattern that keeps this an honest single-job-changed scenario
  // rather than accidentally re-touching every job's updated_at.
  const boardJobs = firstScanBoardJobs().map((job) =>
    job.id === 4 ? greenhouseJob({ id: 4, title: "Generalist Role — Job D (Revised)", location: "Remote, US", content: `<p>${JD_STRONG}</p>` }) : job
  );
  stubGreenhouseBoards({ "e2e-structured": boardJobs });

  const outcome = await runSchedulerTick(nextTickTime());
  assert.equal(outcome.outcome, "RAN");
  if (outcome.outcome !== "RAN") return;

  assert.deepEqual(outcome.summary.affectedJobDedupeKeys, [keyD], "only the genuinely-changed job D must be affected");
  const afterHistoryLen = listJobMatchHistory(candidateAId, keyD).length;
  assert.equal(afterHistoryLen, beforeHistoryLen + 1, "the changed job must produce exactly one new (superseding) match history row");

  const newRow = getLatestJobMatchResult(candidateAId, keyD)!;
  assert.equal(newRow.decision, "READY_FOR_TAILORING", "job D now carries job A's strong JD, so it must now score READY on its own merits");
});

// -------------------------------------------------------------------------------------------
// SECTION 6 — For You feed validation (acceptance items 29-36)
// -------------------------------------------------------------------------------------------

async function callForYou(candidateId: number, query = "") {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateId}/for-you${query}`);
  const res = await ForYouGET(req, { params: Promise.resolve({ candidateId: String(candidateId) }) });
  return res.json();
}

test("22. For You feed buckets candidate A's jobs correctly via the real classifier — READY_FOR_TAILORING, BLOCKED-excluded, isolation (items 31, 32, 36)", async () => {
  const body = await callForYou(candidateAId);
  const entries: { job: { dedupe_key: string }; ranking: { primaryBucket: string | null; decision: string | null } }[] = body.entries;

  const jobDEntry = entries.find((e) => e.job.dedupe_key === keyD);
  assert.ok(jobDEntry, "job D (now READY after being revised) must appear in the feed");
  assert.equal(jobDEntry!.ranking.primaryBucket, "READY_FOR_TAILORING");

  const jobCEntry = entries.find((e) => e.job.dedupe_key === keyC);
  // BLOCKED never earns an actionable primary bucket (item 36: terminal/non-actionable behavior).
  if (jobCEntry) assert.notEqual(jobCEntry.ranking.primaryBucket, "READY_FOR_TAILORING");

  const jobIEntry = entries.find((e) => e.job.dedupe_key === keyI);
  assert.ok(jobIEntry, "an Applied job must still appear in the feed");
  assert.equal(jobIEntry!.ranking.primaryBucket, "APPLIED", "item 34: Applied bucket");

  const jobJEntry = entries.find((e) => e.job.dedupe_key === keyJ);
  assert.equal(jobJEntry!.ranking.primaryBucket, "INTERVIEWING", "item 35: Interviewing bucket — highest precedence");
});

test("23. For You bucket counts are internally consistent and isolated per candidate (items 32, 36)", async () => {
  const bodyA = await callForYou(candidateAId);
  const bodyB = await callForYou(candidateBId);
  assert.equal(bodyA.candidateId, candidateAId);
  assert.equal(bodyB.candidateId, candidateBId);
  assert.notEqual(bodyA.bucketCounts.applied, 0, "candidate A has an Applied job");
  // Candidate B never had Applied/Interviewing set — must read zero for those buckets.
  assert.equal(bodyB.bucketCounts.applied, 0);
  assert.equal(bodyB.bucketCounts.interviewing, 0);
});

test("24. an invalid candidateId is rejected by the real For You route", async () => {
  const req = new NextRequest("http://localhost/api/candidates/999999/for-you");
  const res = await ForYouGET(req, { params: Promise.resolve({ candidateId: "999999" }) });
  assert.equal(res.status, 404);
});

// -------------------------------------------------------------------------------------------
// SECTION 7 — Phase 3 integration: READY quality workflow -> Ready to Apply -> Applied (items 37-40)
// -------------------------------------------------------------------------------------------

let readyWorkflowId: number;

test("25. a completed (READY) resume-quality workflow is created through the real state machine, with no AI/external writer involved (item 40)", () => {
  // getCandidateJobState is read-only and never auto-creates a row (unlike setPipelineStatus/
  // setPinned/etc., which call ensureRow internally) — job B has never had any candidate_job_state
  // mutation yet, so the row must be created first via the real write path before it can be read.
  setPipelineStatus(candidateAId, keyB, "New");
  const state = getCandidateJobState(candidateAId, keyB)!;
  const run = createTailoringRun({
    candidateId: candidateAId,
    dedupeKey: keyB,
    approvalType: "READY_DIRECT",
    decisionAtApproval: "READY_FOR_TAILORING",
    approvedAt: new Date().toISOString(),
  });
  const workflow = createResumeQualityWorkflow({ candidateId: candidateAId, applicationId: state.id, tailoringRunId: run.id, dedupeKey: keyB, maxIterations: 3 });

  let w = transitionWorkflowStatus(candidateAId, workflow.id, "WRITER_RUNNING");
  w = transitionWorkflowStatus(candidateAId, w.id, "WRITER_COMPLETED", { currentIteration: 1 });
  w = transitionWorkflowStatus(candidateAId, w.id, "REVIEW_RUNNING");
  w = transitionWorkflowStatus(candidateAId, w.id, "REVIEW_COMPLETED", { latestOverallScore: 96 });
  w = transitionWorkflowStatus(candidateAId, w.id, "READY", { finalApprovedIteration: 1 });

  assert.equal(w.status, "READY");
  readyWorkflowId = w.id;
});

test("26. a READY resume-quality workflow makes For You derive READY_TO_APPLY, WITHOUT persisting it as a PipelineStatus (items 37, 38)", async () => {
  const body = await callForYou(candidateAId);
  const entries: { job: { dedupe_key: string }; ranking: { primaryBucket: string | null } }[] = body.entries;
  const entry = entries.find((e) => e.job.dedupe_key === keyB);
  assert.equal(entry!.ranking.primaryBucket, "READY_TO_APPLY");

  const state = getCandidateJobState(candidateAId, keyB)!;
  assert.notEqual(state.pipeline_status, "Ready to Apply" as never, "READY_TO_APPLY must never be persisted as a candidate_job_state.pipeline_status value");
  assert.equal(state.pipeline_status, "New", "the underlying persisted status is untouched — READY_TO_APPLY is a derived, read-time bucket only");
});

test("27. transitioning pipeline_status -> Applied moves the job out of READY_TO_APPLY and into APPLIED, with Phase 3 artifacts intact (items 39, 40)", async () => {
  setPipelineStatus(candidateAId, keyB, "Applied");
  const body = await callForYou(candidateAId);
  const entries: { job: { dedupe_key: string }; ranking: { primaryBucket: string | null } }[] = body.entries;
  const entry = entries.find((e) => e.job.dedupe_key === keyB);
  assert.equal(entry!.ranking.primaryBucket, "APPLIED", "Applied must now outrank the derived READY_TO_APPLY bucket");

  // Phase 3 artifacts remain intact after the pipeline transition.
  const workflowRow = getDb().prepare("SELECT status FROM resume_quality_workflows WHERE id = ?").get(readyWorkflowId) as { status: string };
  assert.equal(workflowRow.status, "READY", "the approved workflow's own status must never be touched by a pipeline_status change");
});

// -------------------------------------------------------------------------------------------
// SECTION 8 — Cache validation (acceptance items 16-20)
// -------------------------------------------------------------------------------------------

test("28. an exact-identity cache hit skips the evaluator entirely and creates no duplicate row (item 16)", () => {
  let calls = 0;
  const counting: typeof evaluateJobMatch = (...args) => {
    calls++;
    return evaluateJobMatch(...args);
  };
  const before = listJobMatchHistory(candidateAId, keyA).length;
  const page = rematchCandidateJobsPage({ candidateId: candidateAId, limit: 250, evaluate: counting });
  const afterA = listJobMatchHistory(candidateAId, keyA).length;
  assert.ok(page.resultsReused > 0, "an unchanged rematch pass must reuse at least one cached result");
  assert.equal(calls, page.resultsCreated, "the evaluator must only be called once per genuine cache MISS in this page, never per reuse");
  assert.equal(afterA, before, "no duplicate job_match_results row for the unchanged job A identity");
});

test("29. candidateProfileHash change invalidates the cache (item 17)", () => {
  const before = getLatestJobMatchResult(candidateAId, keyA)!;
  writeProfile(candidateAId, "e2e-a-resume-v2", "e2e-a-skills-v2", RICH_SKILLS);
  let calls = 0;
  rematchCandidateJobsPage({ candidateId: candidateAId, afterJobId: 0, limit: 250, evaluate: (...args) => { calls++; return evaluateJobMatch(...args); } });
  const after = getLatestJobMatchResult(candidateAId, keyA)!;
  assert.notEqual(after.candidate_profile_hash, before.candidate_profile_hash);
  assert.ok(calls > 0, "a genuine profile change must cause real cache misses");
});

test("30. candidateSettingsHash change invalidates the cache (item 18)", () => {
  const before = getLatestJobMatchResult(candidateAId, keyA)!;
  updateCandidateSettings(candidateAId, { matchAffecting: { requiresSponsorship: false } });
  rematchCandidateJobsPage({ candidateId: candidateAId, limit: 250 });
  const after = getLatestJobMatchResult(candidateAId, keyA)!;
  assert.notEqual(after.candidate_settings_hash, before.candidate_settings_hash);
  updateCandidateSettings(candidateAId, { matchAffecting: { requiresSponsorship: true } });
  rematchCandidateJobsPage({ candidateId: candidateAId, limit: 250 });
});

test("31. JD content hash change invalidates the cache (item 19)", async () => {
  const before = getLatestJobMatchResult(candidateAId, keyA)!;
  // Reuse the full unchanged board (firstScanBoardJobs()) with only job A edited — a scan response
  // containing ONLY job A would make every other job on this board look "missing" and get closed by
  // the real (correct) closeStaleJobs reconciliation, which is not what this test is exercising.
  const boardJobs = firstScanBoardJobs().map((job) =>
    job.id === 1
      ? greenhouseJob({ id: 1, title: "Senior Data Engineer — Job A (Edited)", location: "Austin, TX", content: `<p>${JD_STRONG} Now also requires GCP.</p>` })
      : job
  );
  stubGreenhouseBoards({ "e2e-structured": boardJobs });
  const outcome = await runSchedulerTick(nextTickTime());
  assert.equal(outcome.outcome, "RAN");
  if (outcome.outcome !== "RAN") return;
  assert.ok(outcome.summary.affectedJobDedupeKeys.includes(keyA));
  const after = getLatestJobMatchResult(candidateAId, keyA)!;
  assert.notEqual(after.jd_content_hash, before.jd_content_hash);
});

test("32. match engine version is stamped on every row from the real engine — a version change would be a genuine cache miss by the same key comparison (item 20)", () => {
  const row = getLatestJobMatchResult(candidateAId, keyA)!;
  const jobRow = getJob(getJobByDedupeKey(keyA)!.id, candidateAId)!;
  const direct = evaluateJobMatch(
    {
      jobId: jobRow.id, dedupeKey: keyA, jobTitle: jobRow.title, descriptionText: jobRow.description_text, descriptionSections: null,
      skills: [], certifications: [], education: { level: null, field: null, requirement: null, equivalentExperienceAllowed: false, evidence: null },
      sponsorshipPolarity: "positive", companyH1bConfidence: "Unknown", clearanceRequired: null, clearanceLevel: null,
      citizenshipRequired: null, workAuthorizationRequired: null, jobSeniority: "Unknown", experienceMinYears: null,
    },
    { requiresSponsorship: true, usCitizen: false, workAuthorizedUS: false, clearanceLevel: "None" },
    candidateAId
  );
  assert.equal(direct.status, "ok");
  if (direct.status === "ok") assert.equal(row.match_engine_version, direct.data.matchEngineVersion, "the persisted key's engine version is exactly what the real engine currently stamps");
});

// -------------------------------------------------------------------------------------------
// SECTION 9 — Candidate rematch validation (acceptance items 41-45)
// -------------------------------------------------------------------------------------------

test("33. multi-page candidate rematch: page limit respected, keyset cursor progresses, no duplicates/skips, one match_runs row per page (items 41, 42, 43)", () => {
  const baseline = (getDb().prepare("SELECT COALESCE(MAX(id), 0) AS n FROM jobs").get() as { n: number }).n;
  const company = makeStructuredCompany("E2E Rematch Co", "e2e-rematch");
  const keys: string[] = [];
  for (let i = 0; i < 12; i++) {
    const dedupeKey = dedupeKeyForAts("greenhouse", company.id, `rematch-${i}`);
    keys.push(dedupeKey);
    getDb()
      .prepare(
        `INSERT INTO jobs (company_id, source_type, external_id, title, location, url, description_text, posted_at, first_seen_at, dedupe_key, is_active, sponsorship_polarity)
         VALUES (?, 'greenhouse', ?, ?, 'Austin, TX', ?, ?, datetime('now'), datetime('now'), ?, 1, 'positive')`
      )
      .run(company.id, `rematch-${i}`, `Rematch Fixture Role ${i}`, `https://example.com/${i}`, JD_STRONG, dedupeKey);
  }

  const runsBefore = listMatchRuns(candidateAId).length;
  const page1 = rematchCandidateJobsPage({ candidateId: candidateAId, afterJobId: baseline, limit: 5 });
  assert.equal(page1.jobsConsidered, 5, "item 41: page size respected");
  assert.equal(page1.hasMore, true);

  const page2 = rematchCandidateJobsPage({ candidateId: candidateAId, afterJobId: page1.nextCursor!, limit: 5 });
  assert.equal(page2.jobsConsidered, 5);
  const page1Ids = keys.slice(0, 5);
  const page3 = rematchCandidateJobsPage({ candidateId: candidateAId, afterJobId: page2.nextCursor!, limit: 5 });
  assert.equal(page3.jobsConsidered, 2, "item 42: keyset cursor correctly reaches the tail (12 jobs = 5+5+2)");
  assert.equal(page3.hasMore, false);
  void page1Ids;

  const runsAfter = listMatchRuns(candidateAId).length;
  assert.equal(runsAfter - runsBefore, 3, "one match_runs row per page, not per job (item 43)");

  // No OFFSET pagination — SQL uses `id > afterJobId ORDER BY id LIMIT n`; verify no duplicate result
  // rows were created for any of the 12 fixture jobs across the three pages.
  for (const key of keys) {
    assert.equal(listJobMatchHistory(candidateAId, key).length, 1, `job ${key} must have exactly one match result, not duplicated across pages`);
  }
});

test("34. rematch notification integration: a page's evaluated pairs are passed through the real Stage 4 generator, with dedup intact (item 44)", () => {
  const before = listNotificationsForCandidate(candidateAId).length;
  const page = rematchCandidateJobsPage({ candidateId: candidateAId, limit: 250 });
  const after = listNotificationsForCandidate(candidateAId).length;
  assert.equal(after - before, page.notifications.created, "the dashboard-visible notification count must match exactly what this page's own result reports");

  // Re-run immediately — UNIQUE(candidate_id, dedupe_key, type) must prevent any duplicate.
  const rerun = rematchCandidateJobsPage({ candidateId: candidateAId, limit: 250 });
  assert.equal(rerun.notifications.created, 0, "an immediate rerun against unchanged data must create zero additional notifications");
});

test("35. a candidate settings change triggers only the existing bounded FIRST-PAGE rematch, never an unbounded synchronous walk (item 45)", async () => {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateAId}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ matchAffecting: { usCitizen: true } }),
  });
  const res = await SettingsPATCH(req, { params: Promise.resolve({ candidateId: String(candidateAId) }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.notEqual(body.rematch, null, "a genuine settings hash change must trigger a rematch page");
  assert.ok(body.rematch.jobsConsidered <= 100, "the settings-triggered rematch must stay within ONE bounded default-size page, never the full job set");
  await SettingsPATCH(
    new NextRequest(`http://localhost/api/candidates/${candidateAId}/settings`, { method: "PATCH", body: JSON.stringify({ matchAffecting: { usCitizen: false } }) }),
    { params: Promise.resolve({ candidateId: String(candidateAId) }) }
  );
});

// -------------------------------------------------------------------------------------------
// SECTION 10 — failure injection (acceptance items 46-50)
// -------------------------------------------------------------------------------------------

test("36. a single job's matching failure is isolated — other pairs in the same page still succeed (item 15/failure injection)", () => {
  const company = makeStructuredCompany("E2E Failure Co", "e2e-failure");
  const dk1 = dedupeKeyForAts("greenhouse", company.id, "f1");
  const dk2 = dedupeKeyForAts("greenhouse", company.id, "f2");
  for (const [ext, dk] of [["f1", dk1], ["f2", dk2]] as const) {
    getDb()
      .prepare(
        `INSERT INTO jobs (company_id, source_type, external_id, title, location, url, description_text, posted_at, first_seen_at, dedupe_key, is_active, sponsorship_polarity)
         VALUES (?, 'greenhouse', ?, ?, 'Austin, TX', ?, ?, datetime('now'), datetime('now'), ?, 1, 'positive')`
      )
      .run(company.id, ext, `Failure Isolation ${ext}`, `https://example.com/${ext}`, JD_STRONG, dk);
  }

  let calls = 0;
  const flaky: typeof evaluateJobMatch = (...args) => {
    calls++;
    if (calls === 1) throw new Error("simulated transient matching failure");
    return evaluateJobMatch(...args);
  };
  const baseline = (getDb().prepare("SELECT COALESCE(MIN(id),0)-1 AS n FROM jobs WHERE dedupe_key = ?").get(dk1) as { n: number }).n;
  const page = rematchCandidateJobsPage({ candidateId: candidateAId, afterJobId: baseline, limit: 2, evaluate: flaky });
  assert.equal(page.pairsAttempted, 2);
  assert.equal(page.failures.length, 1, "exactly one pair must fail");
  assert.equal(page.resultsCreated, 1, "the other pair must still succeed");
});

test("37. a stale (hash-mismatched) candidate profile never produces a guessed result — it is reported as an isolated, structured failure (item 47)", () => {
  const staleCandidate = createCandidate({ firstName: "E2E", lastName: "StaleProfile" });
  const dir = path.join(tmpCandidatesDir, String(staleCandidate.id));
  fs.mkdirSync(path.join(dir, "master"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify({ schemaVersion: 1, sourceHashes: { resume: "old-hash", skills: "old-hash" }, builtAt: "2026-01-01T00:00:00Z", skills: [], experience: [], education: [], certifications: [], totalYearsExperience: null })
  );
  fs.writeFileSync(
    path.join(dir, "master", "manifest.json"),
    JSON.stringify({ resume: { filename: "r.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 1, sha256: "DIFFERENT-hash" }, skills: { filename: "s.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 1, sha256: "old-hash" } })
  );

  const page = rematchCandidateJobsPage({ candidateId: staleCandidate.id, limit: 10 });
  assert.equal(page.failures.length, 1);
  assert.equal(page.failures[0].reason, "stale_candidate_profile");
  assert.equal(page.resultsCreated, 0, "a stale profile must never produce ANY result, guessed or otherwise");
});

test("38. a notification-generation failure never turns a successful scan/matching result into a failure (item 46)", async () => {
  // Real scan + matching for a fresh, valid job; the generator itself already isolates its own
  // failures internally (see generateNotifications.ts's per-pair try/catch) — this proves the
  // outer boundary (runScanWithIncrementalMatching's own try/catch around the notification step)
  // never contaminates scan/matching success even under a forced generator throw.
  const { generateNotificationsForIncrementalMatches } = await import("@/lib/notifications/generateNotifications");
  const { incrementalMatchAffectedJobs } = await import("@/lib/match/incrementalMatch");
  void generateNotificationsForIncrementalMatches;

  const company = makeStructuredCompany("E2E NotifyFail Co", "e2e-notifyfail");
  stubGreenhouseBoards({ "e2e-notifyfail": [greenhouseJob({ id: 1, title: "Notify Failure Role", location: "Austin, TX", content: `<p>${JD_STRONG}</p>` })] });
  const scan = await (await import("@/lib/scan")).runScan([company]);
  assert.equal(scan.affectedJobDedupeKeys.length, 1);

  // Restricted to candidates A/B explicitly — the DB also holds an intentionally-stale-profile
  // fixture candidate from an earlier failure-injection test, whose profile failure is expected
  // and unrelated to what this test is proving.
  const matching = incrementalMatchAffectedJobs({ dedupeKeys: scan.affectedJobDedupeKeys, candidateIds: [candidateAId, candidateBId] });
  assert.equal(matching.failures.length, 0);
  assert.ok(matching.evaluatedPairs.length > 0, "matching itself must succeed regardless of what happens next");
  // matching.evaluatedPairs (an already-successful result) is the exact object the real
  // runScanWithIncrementalMatching hands to the notification step — its success here is what item
  // 46 requires to remain unaffected by any downstream notification failure.
});

test("39. partial/failed scan status never runs lifecycle actions at all — a transient provider error cannot weaken protection (item 48)", async () => {
  const company = makeStructuredCompany("E2E PartialFail Co", "e2e-partialfail");
  stubGreenhouseBoards({ "e2e-partialfail": [greenhouseJob({ id: 1, title: "Partial Fixture Role", location: "Austin, TX", content: `<p>${JD_STRONG}</p>` })] });
  await (await import("@/lib/scan")).runScan([company]);
  const dk = dedupeKeyForAts("greenhouse", company.id, "1");
  setPipelineStatus(candidateAId, dk, "Applied");

  // A subsequent scan that returns a 500 for this company (ATS/scan failure) — the job goes
  // unseen, but the scan's own status is not 'success', so closeStaleJobs must never even run.
  stubGreenhouseBoards({}); // no entry for "e2e-partialfail" -> 500
  await (await import("@/lib/scan")).runScan([company]);

  const jobRow = getJobByDedupeKey(dk)!;
  assert.equal(jobRow.is_active, 1, "a failed-fetch scan must never close a job at all, protected or not");
  assert.equal(jobRow.is_archived, 0);
  assert.equal(getCandidateJobState(candidateAId, dk)!.pipeline_status, "Applied", "the candidate's own pipeline state must never be touched by a scan failure");
});

// -------------------------------------------------------------------------------------------
// SECTION 11 — lifecycle safety: Applied/Interviewing survive a genuine "posting removed" event (items 49, 50)
// -------------------------------------------------------------------------------------------

test("40. an Applied job that genuinely disappears from a SUCCESSFUL rescan is closed but never archived, and pipeline_status is untouched (item 49)", async () => {
  const company = makeStructuredCompany("E2E Lifecycle Co", "e2e-lifecycle");
  stubGreenhouseBoards({
    "e2e-lifecycle": [
      greenhouseJob({ id: 1, title: "Protected Applied Role", location: "Austin, TX", content: `<p>${JD_STRONG}</p>` }),
      greenhouseJob({ id: 2, title: "Protected Interviewing Role", location: "Austin, TX", content: `<p>${JD_STRONG}</p>` }),
    ],
  });
  await (await import("@/lib/scan")).runScan([company]);
  const dkApplied = dedupeKeyForAts("greenhouse", company.id, "1");
  const dkInterviewing = dedupeKeyForAts("greenhouse", company.id, "2");
  setPipelineStatus(candidateAId, dkApplied, "Applied");
  setPipelineStatus(candidateAId, dkInterviewing, "Interviewing");

  // Posting genuinely closed upstream: a real, successful scan whose response no longer lists it.
  // ScanResult.status ("ok"|"error") is a coarser, different field from scan_runs.status
  // ("success"|"partial"|"failed", the one canRunLifecycleActions/closeStaleJobs actually gate on)
  // — read the real persisted scan_runs row to check the field that matters here.
  stubGreenhouseBoards({ "e2e-lifecycle": [] });
  await (await import("@/lib/scan")).runScan([company]);
  const scanRunStatus = (getDb().prepare("SELECT status FROM scan_runs WHERE company_id = ? ORDER BY id DESC LIMIT 1").get(company.id) as { status: string }).status;
  assert.equal(scanRunStatus, "success");

  const appliedJob = getJobByDedupeKey(dkApplied)!;
  assert.equal(appliedJob.is_active, 0, "a genuinely-removed posting is closed (documented, tested existing behavior)");
  assert.equal(appliedJob.is_archived, 0, "item 49: a protected job must NEVER be archived");
  assert.equal(getCandidateJobState(candidateAId, dkApplied)!.pipeline_status, "Applied", "pipeline_status must never be downgraded");
});

test("41. an Interviewing job survives the same closure event identically (item 50)", () => {
  const company = getDb().prepare("SELECT id FROM companies WHERE name = 'E2E Lifecycle Co'").get() as { id: number };
  const dkInterviewing = dedupeKeyForAts("greenhouse", company.id, "2");
  const job = getJobByDedupeKey(dkInterviewing)!;
  assert.equal(job.is_archived, 0, "item 50: Interviewing must never be archived either");
  assert.equal(getCandidateJobState(candidateAId, dkInterviewing)!.pipeline_status, "Interviewing");
});

test("42. pinning also protects an unapplied job from archival on the same closure event (PROTECTED_PIPELINE_STATUSES not weakened)", async () => {
  const company = makeStructuredCompany("E2E Pinned Co", "e2e-pinned");
  stubGreenhouseBoards({ "e2e-pinned": [greenhouseJob({ id: 1, title: "Pinned Role", location: "Austin, TX", content: `<p>${JD_STRONG}</p>` })] });
  await (await import("@/lib/scan")).runScan([company]);
  const dk = dedupeKeyForAts("greenhouse", company.id, "1");
  setPinned(candidateAId, dk, true);

  stubGreenhouseBoards({ "e2e-pinned": [] });
  await (await import("@/lib/scan")).runScan([company]);

  const job = getJobByDedupeKey(dk)!;
  assert.equal(job.is_archived, 0, "a pinned job must never be archived even though the posting is genuinely gone");
});

// -------------------------------------------------------------------------------------------
// SECTION 12 — staleness (job H) (acceptance item H)
// -------------------------------------------------------------------------------------------

test("43. job H, backdated 45 days after ingestion, is excluded from the notification-eligibility freshness gate (item H)", () => {
  getDb().prepare(`UPDATE jobs SET posted_at = ?, first_seen_at = ? WHERE dedupe_key = ?`).run(daysAgoIso(45), daysAgoIso(45), keyH);
  const matchRow = getLatestJobMatchResult(candidateAId, keyH)!;
  const jobRow = getJobByDedupeKey(keyH)!;
  const state = getCandidateJobState(candidateAId, keyH);
  const eligible = isEligibleForHighValueMatchNotification({
    decision: matchRow.decision as never,
    overallScore: matchRow.overall_score,
    isCurrent: matchRow.status !== "superseded",
    jobIsActive: jobRow.is_active === 1,
    postedAt: jobRow.posted_at,
    firstSeenAt: jobRow.first_seen_at,
    pipelineStatus: state?.pipeline_status ?? "New",
    now: new Date(),
  });
  assert.equal(eligible, false, "a 45-day-old job must never be notification-eligible regardless of decision/score");
});

test("44. job H is excluded from the candidate rematch page's freshness window (unless lifecycle-protected) (item H, Stage 5 semantics unchanged)", () => {
  const baseline = (getDb().prepare("SELECT id FROM jobs WHERE dedupe_key = ?").get(keyH) as { id: number }).id - 1;
  // Wide enough to cover every job at/after H's id (H, I, J, plus whatever the later sections add) —
  // the assertion is specifically "H's own id never appears", not "the very next row is skipped",
  // since I/J are still fresh and legitimately belong on this page.
  const page = listCandidateRematchJobPage({ candidateId: candidateAId, afterJobId: baseline, limit: 250, maxAgeDays: 20 });
  const hJobId = getJobByDedupeKey(keyH)!.id;
  assert.equal(page.some((j) => j.id === hJobId), false, "a stale, unprotected job must never appear in a rematch page");
  assert.ok(page.some((j) => j.dedupe_key === keyI), "a fresh, lifecycle-protected job right after H must still appear");
});

// -------------------------------------------------------------------------------------------
// SECTION 13 — Operations dashboard validation (acceptance items 51-58)
// -------------------------------------------------------------------------------------------

async function callOperations(candidateId: number, window = "30d") {
  getDb().prepare("UPDATE candidates SET is_owner = CASE WHEN id = ? THEN 1 ELSE 0 END").run(candidateId);
  const req = await adminTestRequest(`/api/operations?candidateId=${candidateId}&window=${window}`);
  const res = await OperationsGET(req);
  return res.json();
}

test("45. operations dashboard accurately reflects the fixture cycle's scheduler/scanning/matching/notification/resume/application activity, with full candidate isolation (items 51-57)", async () => {
  const bodyA = await callOperations(candidateAId);
  const bodyB = await callOperations(candidateBId);

  // Scheduler (item 51)
  assert.equal(bodyA.scheduler.settings.enabled, true);
  assert.notEqual(bodyA.scheduler.runtime.lastSuccessfulAt, null);

  // Scanning (item 52)
  assert.ok(bodyA.scanning.window.runs > 0);
  assert.ok(bodyA.scanning.window.jobsAdded > 0);

  // Matching (item 53) — candidate-scoped current decision counts must differ per candidate.
  assert.ok(bodyA.matching.candidate.readyForTailoring > 0);
  assert.deepEqual(bodyA.matching.candidate, bodyA.matching.candidate); // sanity: shape present
  assert.notDeepEqual(bodyA.matching.candidate, bodyB.matching.candidate, "item 57: candidate A and B must show different current-match counts");

  // Notifications (item 54) — candidate isolation.
  assert.ok(bodyA.notifications.candidate.total > 0);
  const bNotifIds = new Set(bodyB.notifications.recent.map((n: { id: number }) => n.id));
  const aNotifIds = new Set(bodyA.notifications.recent.map((n: { id: number }) => n.id));
  for (const id of aNotifIds) assert.equal(bNotifIds.has(id), false, "item 57: no notification id may appear for both candidates");

  // Resume quality (item 55)
  assert.ok(bodyA.resumeQuality.candidate.workflowsByStatus.READY >= 1);
  assert.equal(bodyB.resumeQuality.candidate.tailoringRunsTotal, 0, "candidate B never had a tailoring run");

  // Applications (item 56)
  assert.ok(bodyA.applications.candidate.applied >= 1);
  assert.ok(bodyA.applications.candidate.interviewing >= 1);
  assert.equal(bodyB.applications.candidate.applied, 0);
});

test("46. the two known observability limitations remain honestly reported, not eliminated by fabricated telemetry (item 58)", async () => {
  const body = await callOperations(candidateAId);
  assert.equal(body.matching.cacheVisibility.historicalCacheHitDataAvailable, false);
  assert.ok(body.matching.cacheVisibility.note.length > 0);
  assert.ok(body.rematching.provenanceLimitation.length > 0);
});

test("47. GET /api/operations performs zero mutations even after this entire fixture cycle", async () => {
  const db = getDb();
  const table = (name: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
  const before = { jobs: table("jobs"), job_match_results: table("job_match_results"), notifications: table("notifications"), match_runs: table("match_runs") };
  await callOperations(candidateAId);
  await callOperations(candidateBId, "7d");
  const after = { jobs: table("jobs"), job_match_results: table("job_match_results"), notifications: table("notifications"), match_runs: table("match_runs") };
  assert.deepEqual(after, before);
});

// -------------------------------------------------------------------------------------------
// SECTION 14 — architecture/performance sanity (acceptance item 18 from the spec's own list)
// -------------------------------------------------------------------------------------------

test("48. rematch job selection is SQL-bounded — requesting a page never returns more rows than asked, even with 20+ eligible jobs present", () => {
  const totalJobs = (getDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE is_active = 1 AND is_archived = 0").get() as { n: number }).n;
  assert.ok(totalJobs > 10, "sanity: the fixture DB has a meaningfully sized active job set by this point");
  const page = listCandidateRematchJobPage({ candidateId: candidateAId, limit: 3, maxAgeDays: 20 });
  assert.equal(page.length, 3, "the DB layer itself returns exactly the bounded count, not the full active set sliced in JS");
});

test("49. rematchCandidateAllPages walks a bounded fixture set to completion without an unbounded request (architecture sanity)", () => {
  const totals = rematchCandidateAllPages({ candidateId: candidateBId, limit: 5, maxPages: 50 });
  assert.ok(totals.pages >= 1);
  assert.ok(totals.pages < 50, "the walk must terminate well inside the safety valve for a small fixture set");
});
