import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { adminTestRequest } from "@/lib/auth/__tests__/adminTestRequest";

/**
 * Phase 4 Stage 6 — GET /api/operations. Real (temp, isolated) SQLite DB, no network, no candidate
 * files needed (this route never touches candidate-profile.json). Query-layer aggregation
 * correctness is proven in src/db/queries/__tests__/operations.test.ts; this file covers the route
 * boundary — response shape, validation, mutation-safety, and end-to-end candidate isolation.
 */

let tmpDbDir: string;

let getDb: typeof import("@/db").getDb;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let archiveCandidate: typeof import("@/db/queries/candidates").archiveCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let insertJobMatchResult: typeof import("@/db/queries/jobMatches").insertJobMatchResult;
let createNotificationIfAbsent: typeof import("@/db/queries/notifications").createNotificationIfAbsent;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let GET: typeof import("../route").GET;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-operations-api-db-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");

  ({ getDb } = await import("@/db"));
  ({ createCandidate, archiveCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ createNotificationIfAbsent } = await import("@/db/queries/notifications"));
  ({ setPipelineStatus } = await import("@/db/queries/candidateJobState"));
  ({ GET } = await import("../route"));
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  } catch {}
});

async function callGET(query: string) {
  const url = new URL(`http://localhost/api/operations${query}`);
  const candidateId = Number(url.searchParams.get("candidateId"));
  if (Number.isInteger(candidateId) && candidateId > 0) {
    const candidate = getDb().prepare("SELECT id FROM candidates WHERE id = ?").get(candidateId);
    if (candidate) {
      getDb().prepare("UPDATE candidates SET is_owner = CASE WHEN id = ? THEN 1 ELSE 0 END").run(candidateId);
      return GET(await adminTestRequest(`/api/operations${query}`));
    }
  }
  return GET(new NextRequest(url));
}

let companyCounter = 0;
function makeCompany() {
  companyCounter++;
  return createCompany({ name: `Ops API Co ${companyCounter}`, source_type: "greenhouse", ats_board_token: `ops-api-${companyCounter}` });
}

let jobCounter = 0;
function seedJob(companyId: number) {
  jobCounter++;
  const externalId = `ops-api-job-${jobCounter}`;
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId,
      title: "Ops API Role",
      location: "Austin, TX",
      department: null,
      url: "https://example.com/job",
      descriptionHtml: null,
      descriptionText: "desc",
      employmentType: null,
      workplaceType: null,
      salaryText: null,
      postedAt: new Date().toISOString(),
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: true,
    sponsorshipPolarity: "positive",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  return dedupeKey;
}

function fakeMatch(candidateId: number, dedupeKey: string, jobId: number) {
  return {
    candidateId,
    dedupeKey,
    jobId,
    matchEngineVersion: 1,
    matchKnowledgeHash: "khash",
    candidateProfileHash: "phash",
    candidateSettingsHash: "shash",
    jdContentHash: "jdhash",
    computedAt: new Date().toISOString(),
    eligibility: { status: "PASS" as const, reasons: [], sponsorship: { signal: "explicit_positive" as const, note: "n/a" } },
    dimensionScores: { roleAlignment: null, required: 90, preferred: 90, experience: 90, seniority: 90 },
    overallScore: 95,
    requirementCoverage: 0.9,
    employerEvidencedShare: 0.9,
    insufficientJdSignal: false,
    employerEvidencedMatches: [],
    inventoryOnlyMatches: [],
    transferableMatches: [],
    missingRequirements: [],
    unresolvedRequirements: [],
    criticalGaps: [],
    unrecognizedCandidateSkills: [],
    recommendedTrack: "General / Unclassified" as const,
    decision: "READY_FOR_TAILORING" as const,
    blockingReasons: [],
    roleAlignmentDetail: null,
  };
}

// --- Contract / validation ------------------------------------------------------------------

test("1. operations endpoint returns expected top-level sections", async () => {
  const candidate = createCandidate({ firstName: "Ops", lastName: "Shape" });
  const res = await callGET(`?candidateId=${candidate.id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const key of [
    "generatedAt", "window", "candidateId", "overview", "scheduler", "scanning", "connectors",
    "matching", "notifications", "rematching", "resumeQuality", "applications",
  ]) {
    assert.ok(key in body, `response is missing top-level section "${key}"`);
  }
  assert.equal(body.window, "24h", "default window must be 24h");
});

test("2. invalid candidate rejected — missing candidateId", async () => {
  const res = await callGET("");
  assert.equal(res.status, 400);
});

test("2b. invalid candidate rejected — non-existent candidateId", async () => {
  const res = await callGET("?candidateId=999999");
  assert.equal(res.status, 404);
});

test("2c. invalid candidate rejected — archived candidateId", async () => {
  const candidate = createCandidate({ firstName: "Archived", lastName: "Ops" });
  archiveCandidate(candidate.id);
  const res = await callGET(`?candidateId=${candidate.id}`);
  assert.equal(res.status, 404);
});

test("3. invalid window rejected", async () => {
  const candidate = createCandidate({ firstName: "Ops", lastName: "Window" });
  const res = await callGET(`?candidateId=${candidate.id}&window=90d`);
  assert.equal(res.status, 400);
});

test("valid window values (24h/7d/30d) are all accepted", async () => {
  const candidate = createCandidate({ firstName: "Ops", lastName: "Windows" });
  for (const window of ["24h", "7d", "30d"]) {
    const res = await callGET(`?candidateId=${candidate.id}&window=${window}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.window, window);
  }
});

// --- Candidate isolation, end-to-end through the route --------------------------------------

test("4/5/6/7. candidate A cannot receive candidate B's notification/application/match/resume-quality metrics", async () => {
  const a = createCandidate({ firstName: "RouteIso", lastName: "A" });
  const b = createCandidate({ firstName: "RouteIso", lastName: "B" });
  const company = makeCompany();
  const key = seedJob(company.id);

  insertJobMatchResult(fakeMatch(a.id, key, getJobByDedupeKey(key)!.id));
  createNotificationIfAbsent({ candidateId: a.id, dedupeKey: key, type: "HIGH_VALUE_JOB_MATCH", title: "A's job", body: "b" });
  setPipelineStatus(a.id, key, "Applied");

  const bRes = await callGET(`?candidateId=${b.id}`);
  const bBody = await bRes.json();

  assert.equal(bBody.notifications.candidate.total, 0);
  assert.equal(bBody.notifications.recent.length, 0);
  assert.equal(bBody.applications.candidate.applied, 0);
  assert.equal(bBody.matching.candidate.readyForTailoring, 0);
  assert.equal(bBody.resumeQuality.candidate.tailoringRunsTotal, 0);

  const aRes = await callGET(`?candidateId=${a.id}`);
  const aBody = await aRes.json();
  assert.equal(aBody.notifications.candidate.total, 1);
  assert.equal(aBody.applications.candidate.applied, 1);
  assert.equal(aBody.matching.candidate.readyForTailoring, 1);
});

// --- Mutation safety ---------------------------------------------------------------------------

test("38. GET causes zero mutations — counts before and after are identical across every relevant table", async () => {
  const candidate = createCandidate({ firstName: "Mutation", lastName: "Safety" });
  const company = makeCompany();
  seedJob(company.id);

  const db = getDb();
  const countsBefore = {
    jobs: (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n,
    companies: (db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n,
    candidates: (db.prepare("SELECT COUNT(*) AS n FROM candidates").get() as { n: number }).n,
    job_match_results: (db.prepare("SELECT COUNT(*) AS n FROM job_match_results").get() as { n: number }).n,
    match_runs: (db.prepare("SELECT COUNT(*) AS n FROM match_runs").get() as { n: number }).n,
    notifications: (db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n,
    scan_runs: (db.prepare("SELECT COUNT(*) AS n FROM scan_runs").get() as { n: number }).n,
    tailoring_runs: (db.prepare("SELECT COUNT(*) AS n FROM tailoring_runs").get() as { n: number }).n,
  };

  await callGET(`?candidateId=${candidate.id}&window=7d`);
  await callGET(`?candidateId=${candidate.id}&window=30d`);

  const countsAfter = {
    jobs: (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n,
    companies: (db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n,
    candidates: (db.prepare("SELECT COUNT(*) AS n FROM candidates").get() as { n: number }).n,
    job_match_results: (db.prepare("SELECT COUNT(*) AS n FROM job_match_results").get() as { n: number }).n,
    match_runs: (db.prepare("SELECT COUNT(*) AS n FROM match_runs").get() as { n: number }).n,
    notifications: (db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n,
    scan_runs: (db.prepare("SELECT COUNT(*) AS n FROM scan_runs").get() as { n: number }).n,
    tailoring_runs: (db.prepare("SELECT COUNT(*) AS n FROM tailoring_runs").get() as { n: number }).n,
  };

  assert.deepEqual(countsAfter, countsBefore, "GET /api/operations must never mutate any table");
});

test("39. no new database tables were introduced for the dashboard", () => {
  const db = getDb();
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
  for (const forbidden of ["operations_metrics", "operations_snapshots", "dashboard_events", "telemetry"]) {
    assert.equal(tables.has(forbidden), false, `${forbidden} must not exist — Stage 6 introduces no new schema`);
  }
});

// --- Cache visibility / rematch provenance limitations are surfaced, not fabricated -------------

test("cache visibility explicitly reports historical cache-hit data is unavailable", async () => {
  const candidate = createCandidate({ firstName: "Cache", lastName: "Visibility" });
  const res = await callGET(`?candidateId=${candidate.id}`);
  const body = await res.json();
  assert.equal(body.matching.cacheVisibility.historicalCacheHitDataAvailable, false);
  assert.ok(typeof body.matching.cacheVisibility.note === "string" && body.matching.cacheVisibility.note.length > 0);
});

test("rematching section reports the scan-vs-rematch provenance limitation, not a guess", async () => {
  const candidate = createCandidate({ firstName: "Rematch", lastName: "Provenance" });
  const res = await callGET(`?candidateId=${candidate.id}`);
  const body = await res.json();
  assert.ok(typeof body.rematching.provenanceLimitation === "string" && body.rematching.provenanceLimitation.length > 0);
  assert.ok(Array.isArray(body.rematching.recentMatchRuns));
});
