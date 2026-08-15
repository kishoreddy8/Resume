import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedJob } from "@/types";

/**
 * Phase 4 Stage 2 — incrementalMatchAffectedJobs orchestration tests. Real (temp, isolated) SQLite
 * DB via CAREER_OPS_DB_PATH + real (temp, isolated) candidate files directory via
 * CAREER_OPS_CANDIDATES_DIR, same pattern as src/db/queries/__tests__/multiCandidateE2E.test.ts.
 * No network. Deliberately does NOT re-implement or hand-verify Phase 2's scoring formula — several
 * tests instead cross-check incrementalMatchAffectedJobs' output against a DIRECT evaluateJobMatch()
 * call for the identical pair, proving the existing engine is genuinely being called (not a second,
 * drifted implementation) rather than asserting a hand-guessed score/decision.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;

let getDb: typeof import("@/db").getDb;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let archiveCandidate: typeof import("@/db/queries/candidates").archiveCandidate;
let listCandidates: typeof import("@/db/queries/candidates").listCandidates;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getMatchAffectingSettings: typeof import("@/db/queries/candidateSettings").getMatchAffectingSettings;
let getLatestJobMatchResult: typeof import("@/db/queries/jobMatches").getLatestJobMatchResult;
let listJobMatchHistory: typeof import("@/db/queries/jobMatches").listJobMatchHistory;
let listMatchRuns: typeof import("@/db/queries/matchRuns").listMatchRuns;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let buildEvaluateJobMatchInput: typeof import("../buildMatchInput").buildEvaluateJobMatchInput;
let evaluateJobMatch: typeof import("../evaluateJobMatch").evaluateJobMatch;
let incrementalMatchAffectedJobs: typeof import("../incrementalMatch").incrementalMatchAffectedJobs;
let getJob: typeof import("@/db/queries/jobs").getJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-incremental-match-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-incremental-match-candidates-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;

  ({ getDb } = await import("@/db"));
  ({ createCandidate, archiveCandidate, listCandidates } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ getMatchAffectingSettings } = await import("@/db/queries/candidateSettings"));
  ({ getLatestJobMatchResult, listJobMatchHistory } = await import("@/db/queries/jobMatches"));
  ({ listMatchRuns } = await import("@/db/queries/matchRuns"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ buildEvaluateJobMatchInput } = await import("../buildMatchInput"));
  ({ evaluateJobMatch } = await import("../evaluateJobMatch"));
  ({ incrementalMatchAffectedJobs } = await import("../incrementalMatch"));

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
  return createCompany({ name: `Incremental Match Test Co ${companyCounter}`, source_type: "greenhouse", ats_board_token: `inc-match-${companyCounter}` });
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
function seedJob(companyId: number, overrides: Partial<NormalizedJob> = {}, sponsorshipPolarity: "none" | "positive" | "negative" = "none") {
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

test("72. only affected jobs are resolved for matching, not a full jobs-table scan", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Solo", lastName: "One" });
  writeValidProfile(candidate.id);

  // 50 unrelated jobs in the same company, NOT passed as affected.
  for (let i = 0; i < 50; i++) seedJob(company.id);
  const affectedKey = seedJob(company.id);

  const result = incrementalMatchAffectedJobs({ dedupeKeys: [affectedKey], candidateIds: [candidate.id] });
  assert.equal(result.jobsRequested, 1);
  assert.equal(result.jobsResolved, 1, "only the one requested dedupeKey should resolve, not all 51 jobs in the company");
  assert.equal(result.pairsAttempted, 1);
});

test("73. defaults to every active candidate when candidateIds is omitted", () => {
  // Other tests in this file create their own candidates in the same shared temp DB, so this
  // asserts the DELTA (+2 active, not +3) rather than an absolute count.
  const activeBefore = listCandidates().length;

  const company = makeCompany();
  const active1 = createCandidate({ firstName: "Active", lastName: "One" });
  const active2 = createCandidate({ firstName: "Active", lastName: "Two" });
  const archived = createCandidate({ firstName: "Archived", lastName: "Person" });
  archiveCandidate(archived.id);
  writeValidProfile(active1.id);
  writeValidProfile(active2.id);

  assert.equal(listCandidates().length, activeBefore + 2, "archived candidates must never be included in the default active-candidate set");

  const key = seedJob(company.id);
  const result = incrementalMatchAffectedJobs({ dedupeKeys: [key] });
  assert.equal(result.candidatesConsidered, activeBefore + 2);
});

test("74. an explicitly-requested archived candidateId is silently skipped, not matched", () => {
  const company = makeCompany();
  const archived = createCandidate({ firstName: "Archived", lastName: "Explicit" });
  archiveCandidate(archived.id);
  const key = seedJob(company.id);

  const result = incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [archived.id] });
  assert.equal(result.candidatesConsidered, 0);
  assert.equal(result.pairsAttempted, 0);
});

test("75. a candidate with no profile file produces an isolated, recorded failure, not a thrown exception", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "No", lastName: "Profile" });
  // Deliberately never call writeValidProfile for this candidate.
  const key = seedJob(company.id);

  const result = incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });
  assert.equal(result.pairsAttempted, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].candidateId, candidate.id);
  assert.equal(result.failures[0].reason, "missing_candidate_profile");
  assert.equal(result.resultsCreated, 0);
});

test("76. a dedupeKey with no matching jobs row is silently excluded from resolution, not a crash", () => {
  const candidate = createCandidate({ firstName: "Job", lastName: "Missing" });
  writeValidProfile(candidate.id);

  const result = incrementalMatchAffectedJobs({ dedupeKeys: ["greenhouse:99999:does-not-exist"], candidateIds: [candidate.id] });
  assert.equal(result.jobsRequested, 1);
  assert.equal(result.jobsResolved, 0);
  assert.equal(result.pairsAttempted, 0);
  assert.equal(result.failures.length, 0, "an unresolved job is simply excluded, not reported as a pair failure (no pair was ever attempted)");
});

test("77. one candidate's failure does not prevent another candidate's pairing for the same job from succeeding", () => {
  const company = makeCompany();
  const broken = createCandidate({ firstName: "Broken", lastName: "Profile" });
  const healthy = createCandidate({ firstName: "Healthy", lastName: "Profile" });
  writeValidProfile(healthy.id);
  // broken: no profile file written.

  const key = seedJob(company.id);
  const result = incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [broken.id, healthy.id] });

  assert.equal(result.pairsAttempted, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].candidateId, broken.id);
  assert.equal(result.resultsCreated, 1, "the healthy candidate's pairing must still succeed");
});

test("78. the existing Phase 2 evaluator is genuinely called — persisted result matches a direct evaluateJobMatch() call for the same pair", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "CrossCheck", lastName: "Candidate" });
  writeValidProfile(candidate.id, "cc-resume", "cc-skills");
  const key = seedJob(company.id, { title: "Cross-Check Role" });

  incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });
  const persisted = getLatestJobMatchResult(candidate.id, key)!;

  const jobRow = getJobByDedupeKey(key)!;
  const jobWithCompany = getJob(jobRow.id)!;
  const settings = getMatchAffectingSettings(candidate.id);
  const direct = evaluateJobMatch(buildEvaluateJobMatchInput(jobWithCompany), settings, candidate.id);
  assert.equal(direct.status, "ok");
  if (direct.status !== "ok") return;

  assert.equal(persisted.overall_score, direct.data.overallScore);
  assert.equal(persisted.decision, direct.data.decision);
  assert.equal(persisted.match_engine_version, direct.data.matchEngineVersion);
});

test("79. a current cache hit is reused, not re-inserted, on a repeated call with unchanged inputs", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Cache", lastName: "Hit" });
  writeValidProfile(candidate.id, "cache-resume", "cache-skills");
  const key = seedJob(company.id);

  const first = incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });
  assert.equal(first.resultsCreated, 1);
  assert.equal(first.resultsReused, 0);

  const second = incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });
  assert.equal(second.resultsCreated, 0);
  assert.equal(second.resultsReused, 1);
});

test("80. repeated incremental runs are idempotent — job_match_results history does not grow for an unchanged pair", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Idempotent", lastName: "Check" });
  writeValidProfile(candidate.id, "idem-resume", "idem-skills");
  const key = seedJob(company.id);

  incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });
  incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });
  incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });

  assert.equal(listJobMatchHistory(candidate.id, key).length, 1, "three identical runs must not create three rows");
});

test("81. persisted results carry the same engine version/hash provenance evaluateJobMatch itself produces", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Provenance", lastName: "Check" });
  writeValidProfile(candidate.id, "prov-resume", "prov-skills");
  const key = seedJob(company.id);

  incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [candidate.id] });
  const persisted = getLatestJobMatchResult(candidate.id, key)!;
  assert.equal(persisted.candidate_profile_hash, "prov-resume:prov-skills");
  assert.ok(persisted.match_knowledge_hash);
  assert.ok(persisted.jd_content_hash);
  assert.equal(typeof persisted.match_engine_version, "number");
});

test("82/83/84. READY_FOR_TAILORING / NEEDS_REVIEW / BLOCKED are each counted in the bucket matching the real decision", () => {
  const company = makeCompany();
  const candidate = createCandidate({ firstName: "Decision", lastName: "Counts" });
  writeValidProfile(candidate.id, "dec-resume", "dec-skills");

  // Guaranteed BLOCKED: default candidate settings have requiresSponsorship=true, and an explicit
  // "negative" sponsorship polarity is a hard blocker regardless of anything else (eligibility.ts).
  const blockedKey = seedJob(company.id, { title: "Blocked Role" }, "negative");
  // A job with a very sparse description (insufficientJdSignal) is never READY, and isn't a hard
  // BLOCKED either (no sponsorship/clearance/citizenship signal at all) — lands on NEEDS_REVIEW.
  const needsReviewKey = seedJob(company.id, { title: "Sparse Role", descriptionText: "Great job." }, "none");

  const result = incrementalMatchAffectedJobs({ dedupeKeys: [blockedKey, needsReviewKey], candidateIds: [candidate.id] });

  const blockedRow = getLatestJobMatchResult(candidate.id, blockedKey)!;
  const needsReviewRow = getLatestJobMatchResult(candidate.id, needsReviewKey)!;
  assert.equal(blockedRow.decision, "BLOCKED");
  assert.equal(needsReviewRow.decision, "NEEDS_REVIEW");
  assert.equal(result.blocked, 1);
  assert.equal(result.needsReview, 1);
  assert.equal(result.readyForTailoring, 0);
});

test("85. zero affected jobs is a safe no-op — no candidates resolved, nothing persisted", () => {
  const runsBefore = listMatchRuns().length;
  const result = incrementalMatchAffectedJobs({ dedupeKeys: [] });
  assert.deepEqual(result, {
    jobsRequested: 0,
    jobsResolved: 0,
    candidatesConsidered: 0,
    pairsAttempted: 0,
    resultsCreated: 0,
    resultsReused: 0,
    failures: [],
    readyForTailoring: 0,
    needsReview: 0,
    blocked: 0,
  });
  assert.equal(listMatchRuns().length, runsBefore, "no match_runs row is written when there is nothing to do");
});

test("86. exactly one match_runs row is written per candidate processed (reusing the existing table), not per pair", () => {
  const company = makeCompany();
  const c1 = createCandidate({ firstName: "Runs", lastName: "One" });
  const c2 = createCandidate({ firstName: "Runs", lastName: "Two" });
  writeValidProfile(c1.id, "runs1-r", "runs1-s");
  writeValidProfile(c2.id, "runs2-r", "runs2-s");
  const keys = [seedJob(company.id), seedJob(company.id), seedJob(company.id)];

  const before = listMatchRuns().length;
  incrementalMatchAffectedJobs({ dedupeKeys: keys, candidateIds: [c1.id, c2.id] });
  const after = listMatchRuns().length;

  assert.equal(after - before, 2, "2 candidates x 3 jobs must write exactly 2 match_runs rows (one per candidate), not 6");
});

test("87. explicit candidateIds matches only the requested subset, not every active candidate", () => {
  const company = makeCompany();
  const included = createCandidate({ firstName: "Included", lastName: "Candidate" });
  const excluded = createCandidate({ firstName: "Excluded", lastName: "Candidate" });
  writeValidProfile(included.id, "inc-r", "inc-s");
  writeValidProfile(excluded.id, "exc-r", "exc-s");
  const key = seedJob(company.id);

  const result = incrementalMatchAffectedJobs({ dedupeKeys: [key], candidateIds: [included.id] });
  assert.equal(result.candidatesConsidered, 1);
  assert.equal(getLatestJobMatchResult(excluded.id, key), undefined, "an unrequested active candidate must not be matched");
  assert.notEqual(getLatestJobMatchResult(included.id, key), undefined);
});
