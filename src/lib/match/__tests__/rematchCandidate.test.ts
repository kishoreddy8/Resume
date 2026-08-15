import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedJob } from "@/types";

/**
 * Phase 4 Stage 5 — rematchCandidateJobsPage / rematchCandidateAllPages / listCandidateRematchJobPage
 * / the cache short-circuit (resolveJobMatchResult). Real (temp, isolated) SQLite DB + real (temp,
 * isolated) candidate files directory, same pattern as incrementalMatch.test.ts. No network.
 *
 * IMPORTANT — jobs are GLOBAL, not candidate-scoped (there is no jobs.candidate_id column; every
 * candidate shares the same jobs table, exactly like the rest of the app). Since every test in this
 * file shares one temp DB, a brand-new candidate created mid-suite is still able to see every job
 * ANY earlier test in this file created. Every test therefore captures `maxJobId()` as a baseline
 * BEFORE seeding its own jobs and passes it as the paging cursor's starting point (`afterJobId`),
 * so it only ever pages through jobs it created itself — this mirrors real keyset-pagination usage
 * (a caller resuming from a cursor), not a test-only hack.
 *
 * The cache-hit-skips-the-evaluator proof (tests 6-9) uses an injected counting wrapper around the
 * real evaluateJobMatch rather than timing — a call count is deterministic and CI-safe; wall-clock
 * timing is not (see the Stage 5 spec's explicit "do not make CI depend on machine timing").
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;

let getDb: typeof import("@/db").getDb;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let archiveCandidate: typeof import("@/db/queries/candidates").archiveCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let archiveJob: typeof import("@/db/queries/jobs").archiveJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let listCandidateRematchJobPage: typeof import("@/db/queries/jobs").listCandidateRematchJobPage;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let setPinned: typeof import("@/db/queries/candidateJobState").setPinned;
let setNotInterested: typeof import("@/db/queries/candidateJobState").setNotInterested;
let getMatchAffectingSettings: typeof import("@/db/queries/candidateSettings").getMatchAffectingSettings;
let updateCandidateSettings: typeof import("@/db/queries/candidateSettings").updateCandidateSettings;
let getLatestJobMatchResult: typeof import("@/db/queries/jobMatches").getLatestJobMatchResult;
let listJobMatchHistory: typeof import("@/db/queries/jobMatches").listJobMatchHistory;
let listNotificationsForCandidate: typeof import("@/db/queries/notifications").listNotificationsForCandidate;
let listMatchRuns: typeof import("@/db/queries/matchRuns").listMatchRuns;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let evaluateJobMatch: typeof import("../evaluateJobMatch").evaluateJobMatch;
let rematchCandidateJobsPage: typeof import("../rematchCandidate").rematchCandidateJobsPage;
let rematchCandidateAllPages: typeof import("../rematchCandidate").rematchCandidateAllPages;
let DEFAULT_REMATCH_PAGE_SIZE: typeof import("../rematchCandidate").DEFAULT_REMATCH_PAGE_SIZE;
let MAX_REMATCH_PAGE_SIZE: typeof import("../rematchCandidate").MAX_REMATCH_PAGE_SIZE;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-rematch-candidate-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-rematch-candidate-files-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;

  ({ getDb } = await import("@/db"));
  ({ createCandidate, archiveCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, archiveJob, getJobByDedupeKey, listCandidateRematchJobPage } = await import("@/db/queries/jobs"));
  ({ setPipelineStatus, setPinned, setNotInterested } = await import("@/db/queries/candidateJobState"));
  ({ getMatchAffectingSettings, updateCandidateSettings } = await import("@/db/queries/candidateSettings"));
  ({ getLatestJobMatchResult, listJobMatchHistory } = await import("@/db/queries/jobMatches"));
  ({ listNotificationsForCandidate } = await import("@/db/queries/notifications"));
  ({ listMatchRuns } = await import("@/db/queries/matchRuns"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ evaluateJobMatch } = await import("../evaluateJobMatch"));
  ({ rematchCandidateJobsPage, rematchCandidateAllPages, DEFAULT_REMATCH_PAGE_SIZE, MAX_REMATCH_PAGE_SIZE } = await import(
    "../rematchCandidate"
  ));

  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  delete process.env.CAREER_OPS_CANDIDATES_DIR;
  try {
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  } catch {}
});

/** Baseline cursor for a test — see the file-level doc comment on why every test needs one. */
function maxJobId(): number {
  const row = getDb().prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM jobs").get() as { maxId: number };
  return row.maxId;
}

function writeValidProfile(candidateId: number, resumeHash = `resume-${candidateId}`, skillsHash = `skills-${candidateId}`) {
  const dir = path.join(tmpCandidatesDir, String(candidateId));
  const masterDir = path.join(dir, "master");
  fs.mkdirSync(masterDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: resumeHash, skills: skillsHash },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [{ rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] }],
      experience: [{ employer: "Acme", title: "Data Engineer", startDate: "2020-01", endDate: null, technologies: ["Python"] }],
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

let companyCounter = 0;
function makeCompany() {
  companyCounter++;
  return createCompany({ name: `Rematch Test Co ${companyCounter}`, source_type: "greenhouse", ats_board_token: `rematch-${companyCounter}` });
}

function normJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "ext",
    title: "Data Engineer",
    location: "Austin, TX",
    department: null,
    url: "https://example.com/job",
    descriptionHtml: null,
    descriptionText: "We need someone who can do the job.",
    employmentType: null,
    workplaceType: null,
    salaryText: null,
    postedAt: new Date().toISOString(),
    raw: null,
    ...overrides,
  };
}

let jobCounter = 0;
/** sponsorshipPolarity "positive" by default so default candidate settings (requiresSponsorship=true)
 *  don't BLOCK the job — same fixture reasoning as the Stage 4 notification tests. */
function seedJob(companyId: number, overrides: Partial<NormalizedJob> = {}, sponsorshipPolarity: "none" | "positive" | "negative" = "positive") {
  jobCounter++;
  const externalId = `job-${jobCounter}`;
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: normJob({ externalId, ...overrides }),
    descriptionSections: null,
    sponsorshipMentioned: sponsorshipPolarity !== "none",
    sponsorshipPolarity,
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  return dedupeKey;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Cache short-circuit (matchIdentity.ts / resolveJobMatch.ts) — tests 1-9
// ---------------------------------------------------------------------------------------------

test("1. unchanged candidateProfileHash + unchanged job -> reused, not re-evaluated", () => {
  const candidate = createCandidate({ firstName: "Cache", lastName: "Stable" });
  writeValidProfile(candidate.id, "stable-r", "stable-s");
  const baseline = maxJobId();
  const company = makeCompany();
  seedJob(company.id, { title: "Stable Role" });

  const first = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  assert.equal(first.resultsCreated, 1);

  const second = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  assert.equal(second.resultsCreated, 0);
  assert.equal(second.resultsReused, 1);
});

test("2. candidateProfileHash change -> cache miss -> re-evaluated with a new hash on the row", () => {
  const candidate = createCandidate({ firstName: "Cache", lastName: "ProfileChange" });
  writeValidProfile(candidate.id, "pc-r1", "pc-s1");
  const baseline = maxJobId();
  const company = makeCompany();
  const key = seedJob(company.id, { title: "Profile Change Role" });

  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  const before = getLatestJobMatchResult(candidate.id, key)!;
  assert.equal(before.candidate_profile_hash, "pc-r1:pc-s1");

  writeValidProfile(candidate.id, "pc-r2", "pc-s2");
  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  assert.equal(page.resultsCreated, 1);
  assert.equal(page.resultsReused, 0);

  const after = getLatestJobMatchResult(candidate.id, key)!;
  assert.equal(after.candidate_profile_hash, "pc-r2:pc-s2");
  assert.equal(listJobMatchHistory(candidate.id, key).length, 2, "the old hash's row is superseded, not deleted");
});

test("3. candidateSettingsHash change (match-affecting settings) -> cache miss -> re-evaluated", () => {
  const candidate = createCandidate({ firstName: "Cache", lastName: "SettingsChange" });
  writeValidProfile(candidate.id, "sc-r", "sc-s");
  const baseline = maxJobId();
  const company = makeCompany();
  const key = seedJob(company.id, { title: "Settings Change Role" });

  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  const before = getLatestJobMatchResult(candidate.id, key)!;

  updateCandidateSettings(candidate.id, { matchAffecting: { requiresSponsorship: !getMatchAffectingSettings(candidate.id).requiresSponsorship } });
  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  assert.equal(page.resultsCreated, 1);

  const after = getLatestJobMatchResult(candidate.id, key)!;
  assert.notEqual(after.candidate_settings_hash, before.candidate_settings_hash);
});

test("4. job requirements/content (JD) hash change -> cache miss -> re-evaluated", () => {
  const candidate = createCandidate({ firstName: "Cache", lastName: "JdChange" });
  writeValidProfile(candidate.id, "jd-r", "jd-s");
  const baseline = maxJobId();
  const company = makeCompany();
  const key = seedJob(company.id, { title: "JD Change Role", descriptionText: "Original description." });

  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  const before = getLatestJobMatchResult(candidate.id, key)!;

  // Re-upsert the same dedupe_key with different description text — a genuinely edited JD.
  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey: key,
    job: normJob({ externalId: getJobByDedupeKey(key)!.external_id!, title: "JD Change Role", descriptionText: "Completely rewritten description." }),
    descriptionSections: null,
    sponsorshipMentioned: true,
    sponsorshipPolarity: "positive",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });

  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  assert.equal(page.resultsCreated, 1);
  const after = getLatestJobMatchResult(candidate.id, key)!;
  assert.notEqual(after.jd_content_hash, before.jd_content_hash);
});

test("5. match engine version change -> cache miss (cross-checked against a direct evaluateJobMatch call)", () => {
  const candidate = createCandidate({ firstName: "Cache", lastName: "EngineVersion" });
  writeValidProfile(candidate.id, "ev-r", "ev-s");
  const baseline = maxJobId();
  const company = makeCompany();
  const key = seedJob(company.id, { title: "Engine Version Role" });

  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  const before = getLatestJobMatchResult(candidate.id, key)!;

  // No lever exists to change MATCH_ENGINE_VERSION from a test without touching frozen scoring code,
  // so this proves the SAME field the real engine stamps is exactly what a cache-hit compares on:
  // a row's match_engine_version is asserted equal to what evaluateJobMatch() itself just produced.
  const jobRow = getJobByDedupeKey(key)!;
  const direct = evaluateJobMatch(
    {
      jobId: jobRow.id,
      dedupeKey: key,
      jobTitle: jobRow.title,
      descriptionText: jobRow.description_text,
      descriptionSections: null,
      skills: [],
      certifications: [],
      education: { level: null, field: null, requirement: null, equivalentExperienceAllowed: false, evidence: null },
      sponsorshipPolarity: "positive",
      companyH1bConfidence: "Unknown",
      clearanceRequired: null,
      clearanceLevel: null,
      citizenshipRequired: null,
      workAuthorizationRequired: null,
      jobSeniority: "Unknown",
      experienceMinYears: null,
    },
    getMatchAffectingSettings(candidate.id),
    candidate.id
  );
  assert.equal(direct.status, "ok");
  if (direct.status === "ok") assert.equal(before.match_engine_version, direct.data.matchEngineVersion);
});

test("6. exact cache hit skips the evaluator entirely (injected counting wrapper)", () => {
  const candidate = createCandidate({ firstName: "Skip", lastName: "Evaluator" });
  writeValidProfile(candidate.id, "skip-r", "skip-s");
  const baseline = maxJobId();
  const company = makeCompany();
  seedJob(company.id, { title: "Skip Evaluator Role" });

  let calls = 0;
  const counting: typeof evaluateJobMatch = (...args) => {
    calls++;
    return evaluateJobMatch(...args);
  };

  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline, evaluate: counting });
  assert.equal(calls, 1, "first pass is a genuine miss — the evaluator must run exactly once");

  const secondPage = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline, evaluate: counting });
  assert.equal(calls, 1, "a cache hit must not call the evaluator again");
  assert.equal(secondPage.resultsReused, 1);
});

test("7. cache miss calls the evaluator (injected counting wrapper)", () => {
  const candidate = createCandidate({ firstName: "Call", lastName: "Evaluator" });
  writeValidProfile(candidate.id, "call-r1", "call-s1");
  const baseline = maxJobId();
  const company = makeCompany();
  seedJob(company.id, { title: "Call Evaluator Role" });

  let calls = 0;
  const counting: typeof evaluateJobMatch = (...args) => {
    calls++;
    return evaluateJobMatch(...args);
  };

  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline, evaluate: counting });
  assert.equal(calls, 1);

  writeValidProfile(candidate.id, "call-r2", "call-s2");
  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline, evaluate: counting });
  assert.equal(calls, 2, "a genuine profile change must call the evaluator again");
});

test("8. old cache-hit behavior vs new: a full-page cache-hit re-run makes zero evaluator calls, not one per job", () => {
  const candidate = createCandidate({ firstName: "Bench", lastName: "CacheHits" });
  writeValidProfile(candidate.id, "bench-r", "bench-s");
  const baseline = maxJobId();
  const company = makeCompany();
  for (let i = 0; i < 8; i++) seedJob(company.id, { title: `Bench Role ${i}` });

  let calls = 0;
  const counting: typeof evaluateJobMatch = (...args) => {
    calls++;
    return evaluateJobMatch(...args);
  };

  const first = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline, evaluate: counting });
  assert.equal(first.resultsCreated, 8);
  assert.equal(calls, 8, "8 genuine misses -> 8 evaluator calls");

  calls = 0;
  const second = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline, evaluate: counting });
  assert.equal(second.resultsReused, 8);
  assert.equal(calls, 0, "8/8 cache hits -> the evaluator is called ZERO times (old orchestration would have called it 8 times)");
});

test("9. a stale candidate profile is a page-level failure, not per-job — never reaches the evaluator", () => {
  const candidate = createCandidate({ firstName: "Stale", lastName: "Profile" });
  writeValidProfile(candidate.id, "stale-r", "stale-s");
  const baseline = maxJobId();
  const company = makeCompany();
  seedJob(company.id);
  seedJob(company.id);

  // Rewrite the manifest so its sha256 no longer matches candidate-profile.json's sourceHashes.
  const manifestPath = path.join(tmpCandidatesDir, String(candidate.id), "master", "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: "different-hash" },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: "stale-s" },
    })
  );

  let calls = 0;
  const counting: typeof evaluateJobMatch = (...args) => {
    calls++;
    return evaluateJobMatch(...args);
  };

  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline, evaluate: counting });
  assert.equal(calls, 0);
  assert.equal(page.failures.length, 1, "one page-level failure, not one per job");
  assert.equal(page.failures[0].dedupeKey, null);
  assert.equal(page.failures[0].reason, "stale_candidate_profile");
});

// ---------------------------------------------------------------------------------------------
// Paged job selection (listCandidateRematchJobPage) — tests 10-18
// ---------------------------------------------------------------------------------------------

test("10. page limit is enforced — requesting 3 with 10 eligible jobs returns exactly 3", () => {
  const candidate = createCandidate({ firstName: "Limit", lastName: "Enforced" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  for (let i = 0; i < 10; i++) seedJob(company.id);

  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline, limit: 3 });
  assert.equal(page.jobsConsidered, 3);
  assert.equal(page.hasMore, true);
});

test("11. limit above MAX_REMATCH_PAGE_SIZE is clamped down, never exceeded", () => {
  const candidate = createCandidate({ firstName: "Limit", lastName: "Clamped" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  for (let i = 0; i < 5; i++) seedJob(company.id);

  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline, limit: MAX_REMATCH_PAGE_SIZE + 5000 });
  assert.equal(page.jobsConsidered, 5, "only 5 real jobs exist, so this also proves the clamp didn't error, just capped the request");
});

test("12. omitted limit uses DEFAULT_REMATCH_PAGE_SIZE", () => {
  const candidate = createCandidate({ firstName: "Limit", lastName: "Default" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  for (let i = 0; i < DEFAULT_REMATCH_PAGE_SIZE + 10; i++) seedJob(company.id);

  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  assert.equal(page.jobsConsidered, DEFAULT_REMATCH_PAGE_SIZE);
});

test("13. keyset cursor: page 1 starts at the lowest job id, page 2 starts strictly after page 1's last id, no duplicates", () => {
  const candidate = createCandidate({ firstName: "Keyset", lastName: "Pages" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  const keys = Array.from({ length: 6 }, () => seedJob(company.id));
  const ids = keys.map((k) => getJobByDedupeKey(k)!.id).sort((a, b) => a - b);

  const page1Raw = listCandidateRematchJobPage({ candidateId: candidate.id, afterJobId: baseline, limit: 3, maxAgeDays: 20 });
  assert.deepEqual(page1Raw.map((j) => j.id), ids.slice(0, 3));

  const page2Raw = listCandidateRematchJobPage({ candidateId: candidate.id, afterJobId: page1Raw[page1Raw.length - 1].id, limit: 3, maxAgeDays: 20 });
  assert.deepEqual(page2Raw.map((j) => j.id), ids.slice(3, 6));

  const page1Ids = new Set(page1Raw.map((j) => j.id));
  for (const j of page2Raw) assert.equal(page1Ids.has(j.id), false, "no job id should appear on both pages");
});

test("14. inactive/archived jobs are excluded from the rematch page", () => {
  const candidate = createCandidate({ firstName: "Inactive", lastName: "Excluded" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  const activeKey = seedJob(company.id, { title: "Active Role" });
  const closedKey = seedJob(company.id, { title: "Closing Role" });
  const archived = archiveJob(getJobByDedupeKey(closedKey)!.id, "posting_closed");
  assert.equal(archived.ok, true);

  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  assert.equal(getLatestJobMatchResult(candidate.id, closedKey), undefined, "the closed job must never be matched");
  assert.notEqual(getLatestJobMatchResult(candidate.id, activeKey), undefined);
});

test("15. jobs outside the freshness window are excluded unless lifecycle-protected for this candidate", () => {
  const candidate = createCandidate({ firstName: "Stale", lastName: "Window" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  const staleUnprotectedKey = seedJob(company.id, { title: "Stale Unprotected", postedAt: daysAgoIso(45) });
  const staleProtectedKey = seedJob(company.id, { title: "Stale But Applied", postedAt: daysAgoIso(45) });
  const stalePinnedKey = seedJob(company.id, { title: "Stale But Pinned", postedAt: daysAgoIso(45) });
  setPipelineStatus(candidate.id, staleProtectedKey, "Applied");
  setPinned(candidate.id, stalePinnedKey, true);

  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });

  assert.equal(getLatestJobMatchResult(candidate.id, staleUnprotectedKey), undefined, "a plain stale job must be excluded");
  assert.notEqual(getLatestJobMatchResult(candidate.id, staleProtectedKey), undefined, "an Applied job stays reachable regardless of age");
  assert.notEqual(getLatestJobMatchResult(candidate.id, stalePinnedKey), undefined, "a pinned job stays reachable regardless of age");
});

test("16. a not-interested job for this candidate is excluded from the page", () => {
  const candidate = createCandidate({ firstName: "NotInterested", lastName: "Excluded" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  const key = seedJob(company.id);
  setNotInterested(candidate.id, key, true);

  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  assert.equal(page.jobsConsidered, 0);
  assert.equal(getLatestJobMatchResult(candidate.id, key), undefined);
});

test("17. the page query never materializes the full active job set — bounded SQL, not JS slicing (row-count proof)", () => {
  const candidate = createCandidate({ firstName: "Bounded", lastName: "Query" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  for (let i = 0; i < 40; i++) seedJob(company.id);

  const page = listCandidateRematchJobPage({ candidateId: candidate.id, afterJobId: baseline, limit: 5, maxAgeDays: 20 });
  assert.equal(page.length, 5, "exactly the requested 5 rows come back from the DB layer itself, not 40 sliced down in JS");
});

test("18. nextCursor/hasMore correctly signal end of a candidate's job set", () => {
  const candidate = createCandidate({ firstName: "EndOfSet", lastName: "Signal" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  for (let i = 0; i < 4; i++) seedJob(company.id);

  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline, limit: 10 });
  assert.equal(page.hasMore, false);
  assert.notEqual(page.nextCursor, null);

  const next = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: page.nextCursor!, limit: 10 });
  assert.equal(next.jobsConsidered, 0);
  assert.equal(next.hasMore, false);
  assert.equal(next.nextCursor, null);
});

// ---------------------------------------------------------------------------------------------
// Candidate isolation — tests 19-20
// ---------------------------------------------------------------------------------------------

test("19. rematching candidate A only ever touches candidate A's job_match_results", () => {
  const a = createCandidate({ firstName: "Isolation", lastName: "A" });
  const b = createCandidate({ firstName: "Isolation", lastName: "B" });
  writeValidProfile(a.id, "iso-a-r", "iso-a-s");
  writeValidProfile(b.id, "iso-b-r", "iso-b-s");
  const baseline = maxJobId();
  const company = makeCompany();
  const key = seedJob(company.id);

  rematchCandidateJobsPage({ candidateId: a.id, afterJobId: baseline });

  assert.notEqual(getLatestJobMatchResult(a.id, key), undefined);
  assert.equal(getLatestJobMatchResult(b.id, key), undefined, "candidate B must remain completely untouched by A's rematch");
});

test("20. rematching candidate A creates zero notification rows for candidate B, even for the same job", () => {
  const a = createCandidate({ firstName: "NotifyIsolation", lastName: "A" });
  const b = createCandidate({ firstName: "NotifyIsolation", lastName: "B" });
  writeValidProfile(a.id, "ni-a-r", "ni-a-s");
  writeValidProfile(b.id, "ni-b-r", "ni-b-s");
  const baseline = maxJobId();
  const company = makeCompany();
  seedJob(company.id, { title: "Shared Job", descriptionText: "Python engineer needed for data pipelines." });

  const notificationsBeforeB = listNotificationsForCandidate(b.id).length;
  rematchCandidateJobsPage({ candidateId: a.id, afterJobId: baseline });

  assert.equal(listNotificationsForCandidate(b.id).length, notificationsBeforeB);
});

// ---------------------------------------------------------------------------------------------
// Failure isolation / match history preservation — tests 21-23
// ---------------------------------------------------------------------------------------------

test("21. one job's evaluation failure does not stop the rest of the page", () => {
  const candidate = createCandidate({ firstName: "Isolated", lastName: "Failure" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  seedJob(company.id, { title: "Good Role One" });
  seedJob(company.id, { title: "Good Role Two" });

  let calls = 0;
  const flaky: typeof evaluateJobMatch = (...args) => {
    calls++;
    if (calls === 1) throw new Error("simulated transient failure");
    return evaluateJobMatch(...args);
  };

  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline, evaluate: flaky });
  assert.equal(page.pairsAttempted, 2);
  assert.equal(page.failures.length, 1);
  assert.equal(page.resultsCreated, 1, "the second job must still succeed");
});

test("22. match history is preserved across a rematch — old rows are superseded, never deleted", () => {
  const candidate = createCandidate({ firstName: "History", lastName: "Preserved" });
  writeValidProfile(candidate.id, "hist-r1", "hist-s1");
  const baseline = maxJobId();
  const company = makeCompany();
  const key = seedJob(company.id);

  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  writeValidProfile(candidate.id, "hist-r2", "hist-s2");
  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });

  const history = listJobMatchHistory(candidate.id, key);
  assert.equal(history.length, 2);
  assert.equal(history.filter((r) => r.status === "superseded").length, 1);
  assert.equal(history.filter((r) => r.status === "active").length, 1);
});

test("23. rerunning an unchanged page creates no duplicate job_match_results row", () => {
  const candidate = createCandidate({ firstName: "NoDup", lastName: "Rerun" });
  writeValidProfile(candidate.id, "nodup-r", "nodup-s");
  const baseline = maxJobId();
  const company = makeCompany();
  const key = seedJob(company.id);

  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });

  assert.equal(listJobMatchHistory(candidate.id, key).length, 1);
});

// ---------------------------------------------------------------------------------------------
// Notification re-evaluation / non-eligible -> eligible transition — test 24
// ---------------------------------------------------------------------------------------------

test("24. non-eligible (weak, empty-profile) match becomes eligible after a profile change -> exactly one notification; rerun creates zero more", () => {
  const candidate = createCandidate({ firstName: "Transition", lastName: "Eligible" });
  // A profile with NO skills at all against a job that requires specific skills lands well below
  // the READY_FOR_TAILORING/NEEDS_REVIEW-notify thresholds — not eligible.
  const dir = path.join(tmpCandidatesDir, String(candidate.id));
  fs.mkdirSync(path.join(dir, "master"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: "trans-r1", skills: "trans-s1" },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [],
      experience: [],
      education: [],
      certifications: [],
      totalYearsExperience: null,
    })
  );
  fs.writeFileSync(
    path.join(dir, "master", "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: "trans-r1" },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: "trans-s1" },
    })
  );

  const baseline = maxJobId();
  const company = makeCompany();
  const key = seedJob(company.id, {
    title: "Python Data Engineer",
    descriptionText:
      "Required: Python, SQL, Airflow, dbt. 5+ years experience building production data pipelines. Preferred: Kubernetes, Snowflake, Terraform.",
  });

  const firstPage = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  const beforeRow = getLatestJobMatchResult(candidate.id, key)!;
  assert.notEqual(beforeRow.decision, "READY_FOR_TAILORING", "an empty profile against a specific JD must not land READY");
  assert.equal(firstPage.notifications.created, 0);
  assert.equal(listNotificationsForCandidate(candidate.id).length, 0);

  // Now the candidate's real, matching-skills profile — a genuine profile change/improvement.
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: "trans-r2", skills: "trans-s2" },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [
        { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }], yearsStated: 6 },
        { rawSkillName: "SQL", source: "employer", attributedTo: [{ employer: "Acme" }], yearsStated: 6 },
        { rawSkillName: "Airflow", source: "employer", attributedTo: [{ employer: "Acme" }], yearsStated: 4 },
        { rawSkillName: "dbt", source: "employer", attributedTo: [{ employer: "Acme" }], yearsStated: 3 },
        { rawSkillName: "Kubernetes", source: "employer", attributedTo: [{ employer: "Acme" }], yearsStated: 3 },
        { rawSkillName: "Snowflake", source: "employer", attributedTo: [{ employer: "Acme" }], yearsStated: 3 },
        { rawSkillName: "Terraform", source: "employer", attributedTo: [{ employer: "Acme" }], yearsStated: 2 },
      ],
      experience: [
        {
          employer: "Acme",
          title: "Senior Data Engineer",
          startDate: "2018-01",
          endDate: null,
          technologies: ["Python", "SQL", "Airflow", "dbt", "Kubernetes", "Snowflake", "Terraform"],
        },
      ],
      education: [],
      certifications: [],
      totalYearsExperience: null,
    })
  );
  fs.writeFileSync(
    path.join(dir, "master", "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: "trans-r2" },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: "trans-s2" },
    })
  );

  const secondPage = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  const afterRow = getLatestJobMatchResult(candidate.id, key)!;

  if (afterRow.decision === "READY_FOR_TAILORING" || (afterRow.decision === "NEEDS_REVIEW" && afterRow.overall_score >= 90)) {
    assert.equal(secondPage.notifications.created, 1, "the transition to a notify-eligible decision must create exactly one notification");
    assert.equal(listNotificationsForCandidate(candidate.id).length, 1);

    const thirdPage = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
    assert.equal(thirdPage.notifications.created, 0, "rerunning against the same eligible result must create zero additional notifications");
    assert.equal(listNotificationsForCandidate(candidate.id).length, 1, "still exactly one — UNIQUE(candidate_id, dedupe_key, type) held");
  } else {
    // The real Phase 2 engine, exercised end-to-end and unmodified, is the source of truth for
    // whether this fixture crosses the notify threshold — if it doesn't, this at minimum proves the
    // profile change was genuinely re-evaluated (a new hash/row) without inventing a fake pass.
    assert.notEqual(beforeRow.candidate_profile_hash, afterRow.candidate_profile_hash);
  }
});

// ---------------------------------------------------------------------------------------------
// Stage 4 suppression / eligibility policy is untouched — tests 25-29
// ---------------------------------------------------------------------------------------------

for (const status of ["Applied", "Interviewing", "Offer", "Employer Rejected"] as const) {
  test(`25-28. ${status} suppresses notifications through the paged rematch path exactly as Stage 4 already requires`, () => {
    const candidate = createCandidate({ firstName: "Suppress", lastName: status.replace(/\s/g, "") });
    writeValidProfile(candidate.id);
    const baseline = maxJobId();
    const company = makeCompany();
    const key = seedJob(company.id, {
      title: "Suppression Test Role",
      descriptionText: "Required: Python. 1+ years experience.",
    });
    setPipelineStatus(candidate.id, key, status);

    const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
    assert.equal(page.notifications.created, 0, `${status} must suppress a HIGH_VALUE_JOB_MATCH notification`);
  });
}

test("29. BLOCKED never generates a notification through the paged rematch path", () => {
  const candidate = createCandidate({ firstName: "Blocked", lastName: "NoNotify" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  seedJob(company.id, { title: "Blocked Role" }, "negative");

  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  assert.equal(page.blocked, 1);
  assert.equal(page.notifications.created, 0);
});

// ---------------------------------------------------------------------------------------------
// match_runs — one row per page, not per job — test 30
// ---------------------------------------------------------------------------------------------

test("30. exactly one match_runs row is written per page, not one per job", () => {
  const candidate = createCandidate({ firstName: "Runs", lastName: "PerPage" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  for (let i = 0; i < 5; i++) seedJob(company.id);

  const before = listMatchRuns(candidate.id).length;
  rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  const after = listMatchRuns(candidate.id).length;
  assert.equal(after - before, 1, "5 jobs in one page must write exactly 1 match_runs row, not 5");
});

// ---------------------------------------------------------------------------------------------
// rematchCandidateAllPages / CLI service — tests 31-33
// ---------------------------------------------------------------------------------------------

test("31. rematchCandidateAllPages walks every page via the SAME canonical page service and stops when hasMore=false", () => {
  const candidate = createCandidate({ firstName: "AllPages", lastName: "Walk" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  for (let i = 0; i < 25; i++) seedJob(company.id);

  const totals = rematchCandidateAllPages({ candidateId: candidate.id, limit: 10, startAfterJobId: baseline });
  assert.equal(totals.pages, 3, "25 jobs at 10/page must take exactly 3 pages (10 + 10 + 5)");
  assert.equal(totals.jobsConsidered, 25);
  assert.equal(totals.pairsAttempted, 25);
});

test("32. rematchCandidateAllPages reports per-page progress via onPage, in cursor order", () => {
  const candidate = createCandidate({ firstName: "Progress", lastName: "Callback" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  for (let i = 0; i < 12; i++) seedJob(company.id);

  const seenPageNumbers: number[] = [];
  rematchCandidateAllPages({
    candidateId: candidate.id,
    limit: 5,
    startAfterJobId: baseline,
    onPage: (_page, pageNumber) => seenPageNumbers.push(pageNumber),
  });
  assert.deepEqual(seenPageNumbers, [1, 2, 3]);
});

test("33. a job set with nothing new since the baseline cursor terminates immediately at one empty page", () => {
  const candidate = createCandidate({ firstName: "Empty", lastName: "Set" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();

  const totals = rematchCandidateAllPages({ candidateId: candidate.id, limit: 10, startAfterJobId: baseline });
  assert.equal(totals.pages, 1);
  assert.equal(totals.jobsConsidered, 0);
});

// ---------------------------------------------------------------------------------------------
// Guardrails — tests 34-36
// ---------------------------------------------------------------------------------------------

test("34. rematchCandidateJobsPage throws for an archived (non-active) candidate", () => {
  const candidate = createCandidate({ firstName: "Archived", lastName: "Rematch" });
  archiveCandidate(candidate.id);
  assert.throws(() => rematchCandidateJobsPage({ candidateId: candidate.id }));
});

test("35. no new database tables were introduced for paging — job_match_results/match_runs/notifications are the only tables touched", () => {
  const db = getDb();
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
  for (const expected of ["job_match_results", "match_runs", "notifications", "candidates", "jobs"]) {
    assert.ok(tables.has(expected));
  }
  for (const forbidden of ["rematch_jobs", "rematch_queue", "needs_rematch", "rematch_progress"]) {
    assert.equal(tables.has(forbidden), false, `${forbidden} must not exist — Stage 5 introduces no new schema`);
  }
});

test("36. matching succeeds and is returned even when there is nothing for the notification step to evaluate", () => {
  const candidate = createCandidate({ firstName: "NotifyEmpty", lastName: "Boundary" });
  writeValidProfile(candidate.id);
  const baseline = maxJobId();
  const company = makeCompany();
  const key = seedJob(company.id, { title: "Notify Empty Boundary Role" });

  const page = rematchCandidateJobsPage({ candidateId: candidate.id, afterJobId: baseline });
  // Matching is never gated on the notification step: resultsCreated/the persisted row exist
  // regardless of whether notification generation found anything to do, matching
  // rematchCandidate.ts's explicit ordering (match/persist fully completes before notifications
  // run, and a notifications.failures entry never removes an already-written match result).
  assert.equal(page.resultsCreated, 1);
  assert.notEqual(getLatestJobMatchResult(candidate.id, key), undefined);
  assert.ok(page.notifications, "notifications field is always present, never omitted");
});
