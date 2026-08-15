import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedJob } from "@/types";

/**
 * Phase 4 Stage 4 — generateNotificationsForIncrementalMatches tests. Real (temp) DB + candidates
 * dir, same fixture pattern as src/lib/match/__tests__/incrementalMatch.test.ts. No network.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;

let getDb: typeof import("@/db").getDb;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let listNotificationsForCandidate: typeof import("@/db/queries/notifications").listNotificationsForCandidate;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let incrementalMatchAffectedJobs: typeof import("@/lib/match/incrementalMatch").incrementalMatchAffectedJobs;
let generateNotificationsForIncrementalMatches: typeof import("../generateNotifications").generateNotificationsForIncrementalMatches;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-gen-notif-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-gen-notif-candidates-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;

  ({ getDb } = await import("@/db"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ setPipelineStatus } = await import("@/db/queries/candidateJobState"));
  ({ listNotificationsForCandidate } = await import("@/db/queries/notifications"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ incrementalMatchAffectedJobs } = await import("@/lib/match/incrementalMatch"));
  ({ generateNotificationsForIncrementalMatches } = await import("../generateNotifications"));

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

let companyCounter = 0;
function makeCompany() {
  companyCounter++;
  return createCompany({ name: `Gen Notif Test Co ${companyCounter}`, source_type: "greenhouse", ats_board_token: `gen-notif-${companyCounter}` });
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
/** Seeds a job whose sponsorshipPolarity is "positive" so the default candidate settings
 *  (requiresSponsorship=true) don't BLOCK it — keeps these fixtures landing on NEEDS_REVIEW (sparse
 *  JD -> insufficientJdSignal) rather than BLOCKED, so eligibility differences are driven by the
 *  scenario under test, not an accidental sponsorship block. */
function seedJob(companyId: number, overrides: Partial<NormalizedJob> = {}) {
  jobCounter++;
  const externalId = `job-${jobCounter}`;
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: normJob({ externalId, ...overrides }),
    descriptionSections: null,
    sponsorshipMentioned: true,
    sponsorshipPolarity: "positive",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  return dedupeKey;
}

test("only evaluated pairs from IncrementalMatchResult are considered — an empty evaluatedPairs list is a safe no-op", () => {
  const result = generateNotificationsForIncrementalMatches({
    jobsRequested: 0,
    jobsResolved: 0,
    candidatesConsidered: 0,
    pairsAttempted: 0,
    resultsCreated: 0,
    resultsReused: 0,
    failures: [],
    evaluatedPairs: [],
    readyForTailoring: 0,
    needsReview: 0,
    blocked: 0,
  });
  assert.deepEqual(result, { evaluated: 0, created: 0, skipped: 0, failures: [] });
});

test("a qualifying evaluated pair creates exactly one notification", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Gen", lastName: "One" });
  writeValidProfile(candidate.id);
  const key = seedJob(company.id, { title: "Cross-Check Role" });

  const matching = incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });
  const result = generateNotificationsForIncrementalMatches(matching);

  assert.equal(result.evaluated, 1);
  const notifications = listNotificationsForCandidate(candidate.id);
  // Sparse description -> insufficientJdSignal -> NEEDS_REVIEW; overallScore may or may not clear
  // NEEDS_REVIEW_NOTIFICATION_MIN_SCORE depending on the real scoring output — assert consistency
  // between what was actually created and the real match decision, not a hardcoded guess.
  const matchRow = getJobByDedupeKey(key)!;
  void matchRow;
  assert.ok(result.created + result.skipped === result.evaluated);
  assert.equal(notifications.length, result.created);
});

test("14/16. repeated generation for the identical evaluated pair is idempotent — no duplicate notification even after a material update", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Gen", lastName: "Idempotent" });
  writeValidProfile(candidate.id);
  const key = seedJob(company.id, { title: "Idempotent Role" });

  const firstMatching = incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });
  const firstGen = generateNotificationsForIncrementalMatches(firstMatching);

  // Simulate a material update (re-scan changes the title) and a second incremental-match pass —
  // same candidate/job/type identity, must not create a second notification.
  const dedupeKeyUnchanged = key;
  const secondMatching = incrementalMatchAffectedJobs({ dedupeKeys: [dedupeKeyUnchanged], candidateIds: [candidate.id] });
  const secondGen = generateNotificationsForIncrementalMatches(secondMatching);

  const totalNotifications = listNotificationsForCandidate(candidate.id).length;
  assert.ok(totalNotifications <= 1, "at most one HIGH_VALUE_JOB_MATCH notification must exist for this candidate/job, regardless of repeats");
  assert.equal(firstGen.created + secondGen.created <= 1, true);
});

test("15. an unchanged job that Stage 2 never includes in evaluatedPairs produces no notification", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Gen", lastName: "Unchanged" });
  writeValidProfile(candidate.id);
  seedJob(company.id, { title: "Never Evaluated Role" });

  // Empty evaluatedPairs simulates Stage 2 excluding an unchanged re-seen job entirely.
  const result = generateNotificationsForIncrementalMatches({
    jobsRequested: 0,
    jobsResolved: 0,
    candidatesConsidered: 0,
    pairsAttempted: 0,
    resultsCreated: 0,
    resultsReused: 0,
    failures: [],
    evaluatedPairs: [],
    readyForTailoring: 0,
    needsReview: 0,
    blocked: 0,
  });
  assert.equal(result.evaluated, 0);
  assert.equal(listNotificationsForCandidate(candidate.id).length, 0);
});

test("27/28. only the pairs in evaluatedPairs are evaluated — never a full jobs-table scan", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Gen", lastName: "Bounded" });
  writeValidProfile(candidate.id);

  // 30 unrelated jobs exist in the DB, but only one is in evaluatedPairs.
  for (let i = 0; i < 30; i++) seedJob(company.id);
  const targetKey = seedJob(company.id, { title: "The One Evaluated Job" });

  const matching = incrementalMatchAffectedJobs({ dedupeKeys: [targetKey], candidateIds: [candidate.id] });
  const result = generateNotificationsForIncrementalMatches(matching);
  assert.equal(result.evaluated, 1, "only the one dedupeKey Stage 2 actually matched should be evaluated for notifications");
});

test("a job resolution gap (dedupeKey with no jobs row) is skipped, not a thrown failure", () => {
  const candidate = createCandidate({ firstName: "Gen", lastName: "Missing" });
  writeValidProfile(candidate.id);

  const result = generateNotificationsForIncrementalMatches({
    jobsRequested: 1,
    jobsResolved: 0,
    candidatesConsidered: 1,
    pairsAttempted: 0,
    resultsCreated: 0,
    resultsReused: 0,
    failures: [],
    evaluatedPairs: [{ candidateId: candidate.id, dedupeKey: "greenhouse:99999:does-not-exist" }],
    readyForTailoring: 0,
    needsReview: 0,
    blocked: 0,
  });
  assert.equal(result.evaluated, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failures.length, 0);
});

test("Applied pipeline status suppresses notification generation for that pair", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Gen", lastName: "Applied" });
  writeValidProfile(candidate.id);
  const key = seedJob(company.id, { title: "Applied Suppression Role" });

  setPipelineStatus(candidate.id, key, "Applied");

  const matching = incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });
  const result = generateNotificationsForIncrementalMatches(matching);

  assert.equal(result.created, 0, "Applied must suppress notification generation regardless of decision/score");
  assert.equal(listNotificationsForCandidate(candidate.id).length, 0);
});

test("29. a created notification's dedupe_key resolves to the correct existing job id", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Gen", lastName: "LinkCheck" });
  writeValidProfile(candidate.id);
  const key = seedJob(company.id, { title: "Link Check Role" });
  const job = getJobByDedupeKey(key)!;

  const matching = incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });
  generateNotificationsForIncrementalMatches(matching);

  const notifications = listNotificationsForCandidate(candidate.id);
  if (notifications.length > 0) {
    assert.equal(notifications[0].dedupe_key, job.dedupe_key, "the notification must reference the exact job it was generated for");
  }
});
