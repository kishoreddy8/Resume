import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { JobMatchResult } from "@/lib/match/types";
import type { ForYouJobInput } from "@/lib/rank/forYou";

/**
 * Multi-candidate end-to-end fixture — the repeatable regression test the Phase 2.5 checkpoint
 * flagged as missing (verified live/manually in a prior session, never captured as an automated
 * test; see AGENTS.md §23). Two synthetic candidates ("Data Engineer" and "Java") share one company's
 * jobs and exercise the full stack together: shared job inventory, candidate-scoped match results,
 * pipeline/not-interested/notes/pins state, candidate settings/preferences, For You ranking, cross-
 * candidate lifecycle protection, and per-candidate profile file isolation — proving every Phase 2.5
 * isolation claim holds when everything runs together, not just in each module's own unit tests.
 *
 * Isolated temp SQLite DB (CAREER_OPS_DB_PATH) + isolated temp candidates directory
 * (CAREER_OPS_CANDIDATES_DIR) — never touches data/app.db or data/candidates/**.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;

let createCandidate: typeof import("../candidates").createCandidate;
let createCompany: typeof import("../companies").createCompany;
let upsertJob: typeof import("../jobs").upsertJob;
let getJobByDedupeKey: typeof import("../jobs").getJobByDedupeKey;
let listJobs: typeof import("../jobs").listJobs;
let updateCandidateSettings: typeof import("../candidateSettings").updateCandidateSettings;
let getRankingPreferences: typeof import("../candidateSettings").getRankingPreferences;
let getMatchAffectingSettings: typeof import("../candidateSettings").getMatchAffectingSettings;
let setPipelineStatus: typeof import("../candidateJobState").setPipelineStatus;
let setPinned: typeof import("../candidateJobState").setPinned;
let setNotInterested: typeof import("../candidateJobState").setNotInterested;
let setNotesAndTags: typeof import("../candidateJobState").setNotesAndTags;
let getCandidateJobState: typeof import("../candidateJobState").getCandidateJobState;
let isProtectedForAnyCandidate: typeof import("../candidateJobState").isProtectedForAnyCandidate;
let insertJobMatchResult: typeof import("../jobMatches").insertJobMatchResult;
let getLatestJobMatchResult: typeof import("../jobMatches").getLatestJobMatchResult;
let rankForYou: typeof import("@/lib/rank/forYou").rankForYou;
let computeRoleFamilyTier: typeof import("@/lib/rank/roleFamily").computeRoleFamilyTier;
let loadCandidateProfile: typeof import("@/lib/match/candidateProfile").loadCandidateProfile;
let candidateProfileHash: typeof import("@/lib/match/candidateProfile").candidateProfileHash;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let getDb: typeof import("../../index").getDb;

let dataEngCandidateId: number;
let javaCandidateId: number;
let companyId: number;
let dataEngJob: { id: number; dedupe_key: string };
let javaJob: { id: number; dedupe_key: string };

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-multi-candidate-e2e-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-multi-candidate-e2e-candidates-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;

  ({ getDb } = await import("../../index"));
  ({ createCandidate } = await import("../candidates"));
  ({ createCompany } = await import("../companies"));
  ({ upsertJob, getJobByDedupeKey, listJobs } = await import("../jobs"));
  ({ updateCandidateSettings, getRankingPreferences, getMatchAffectingSettings } = await import("../candidateSettings"));
  ({ setPipelineStatus, setPinned, setNotInterested, setNotesAndTags, getCandidateJobState, isProtectedForAnyCandidate } = await import(
    "../candidateJobState"
  ));
  ({ insertJobMatchResult, getLatestJobMatchResult } = await import("../jobMatches"));
  ({ rankForYou } = await import("@/lib/rank/forYou"));
  ({ computeRoleFamilyTier } = await import("@/lib/rank/roleFamily"));
  ({ loadCandidateProfile, candidateProfileHash } = await import("@/lib/match/candidateProfile"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  getDb();

  dataEngCandidateId = createCandidate({ firstName: "Data", lastName: "Engineer" }).id;
  javaCandidateId = createCandidate({ firstName: "Java", lastName: "Dev" }).id;

  companyId = createCompany({ name: "SharedCo", source_type: "greenhouse", ats_board_token: "sharedco" }).id;

  function seedJob(externalId: string, title: string) {
    const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
    upsertJob({
      companyId,
      sourceType: "greenhouse",
      dedupeKey,
      job: {
        externalId,
        title,
        location: null,
        department: null,
        url: `https://boards.greenhouse.io/sharedco/${externalId}`,
        descriptionHtml: null,
        descriptionText: "desc",
        employmentType: null,
        workplaceType: null,
        salaryText: null,
        postedAt: new Date().toISOString(),
        raw: null,
      },
      descriptionSections: null,
      sponsorshipMentioned: false,
      sponsorshipPolarity: "none",
      sponsorshipSnippet: null,
      h1bCombinedConfidence: "Unknown",
    });
    return getJobByDedupeKey(dedupeKey)!;
  }

  dataEngJob = seedJob("ext-1", "Senior Data Engineer");
  javaJob = seedJob("ext-2", "Senior Java Developer");
});

after(() => {
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  delete process.env.CAREER_OPS_CANDIDATES_DIR;
});

function fakeResult(overrides: Partial<JobMatchResult>): JobMatchResult {
  return {
    candidateId: 1,
    jobId: 1,
    dedupeKey: "x",
    matchEngineVersion: 1,
    matchKnowledgeHash: "knowledge-hash",
    candidateProfileHash: "profile-hash",
    candidateSettingsHash: "settings-hash",
    jdContentHash: "jd-hash",
    computedAt: "2026-01-01T00:00:00Z",
    eligibility: { status: "PASS", reasons: [], sponsorship: { signal: "not_applicable", note: "n/a" } },
    dimensionScores: { required: 90, preferred: 50, experience: 100, seniority: 100 },
    overallScore: 50,
    requirementCoverage: 0.5,
    employerEvidencedShare: 0.5,
    insufficientJdSignal: false,
    employerEvidencedMatches: [],
    inventoryOnlyMatches: [],
    transferableMatches: [],
    missingRequirements: [],
    unresolvedRequirements: [],
    criticalGaps: [],
    unrecognizedCandidateSkills: [],
    recommendedTrack: "General / Unclassified",
    decision: "NEEDS_REVIEW",
    blockingReasons: [],
    ...overrides,
  };
}

test("both candidates see the exact same shared jobs (same ids/dedupe_keys)", () => {
  const forA = listJobs({ candidateId: dataEngCandidateId });
  const forB = listJobs({ candidateId: javaCandidateId });
  assert.deepEqual(
    forA.map((j) => j.dedupe_key).sort(),
    forB.map((j) => j.dedupe_key).sort()
  );
  assert.equal(forA.length, 2);
});

test("independent match results: same job, different candidate, different score/decision", () => {
  insertJobMatchResult(
    fakeResult({
      candidateId: dataEngCandidateId,
      jobId: dataEngJob.id,
      dedupeKey: dataEngJob.dedupe_key,
      candidateProfileHash: "data-eng-profile-v1",
      overallScore: 92,
      decision: "READY_FOR_TAILORING",
    })
  );
  insertJobMatchResult(
    fakeResult({
      candidateId: javaCandidateId,
      jobId: dataEngJob.id,
      dedupeKey: dataEngJob.dedupe_key,
      candidateProfileHash: "java-profile-v1",
      overallScore: 30,
      decision: "BLOCKED",
    })
  );

  const aResult = getLatestJobMatchResult(dataEngCandidateId, dataEngJob.dedupe_key)!;
  const bResult = getLatestJobMatchResult(javaCandidateId, dataEngJob.dedupe_key)!;
  assert.equal(aResult.overall_score, 92);
  assert.equal(aResult.decision, "READY_FOR_TAILORING");
  assert.equal(bResult.overall_score, 30);
  assert.equal(bResult.decision, "BLOCKED");
});

test("independent pipeline status on the same shared job", () => {
  setPipelineStatus(dataEngCandidateId, dataEngJob.dedupe_key, "Applied");
  setPipelineStatus(javaCandidateId, dataEngJob.dedupe_key, "New");

  assert.equal(getCandidateJobState(dataEngCandidateId, dataEngJob.dedupe_key)!.pipeline_status, "Applied");
  assert.equal(getCandidateJobState(javaCandidateId, dataEngJob.dedupe_key)?.pipeline_status ?? "New", "New");
});

test("lifecycle protection is a cross-candidate OR — one candidate's Applied status protects the job for everyone", () => {
  // dataEngCandidateId already set to Applied on dataEngJob in the previous test; javaCandidateId's
  // state for the SAME job is 'New' (unprotected) — the job must still read as protected overall.
  assert.equal(isProtectedForAnyCandidate(dataEngJob.dedupe_key), true);
  // The Java job has neither candidate in a protected state yet.
  assert.equal(isProtectedForAnyCandidate(javaJob.dedupe_key), false);
});

test("Not Interested for one candidate never deletes/hides the job for another candidate", () => {
  const jobsBefore = listJobs({}).length;

  setNotInterested(dataEngCandidateId, javaJob.dedupe_key, true, "Not my track");

  assert.equal(getCandidateJobState(dataEngCandidateId, javaJob.dedupe_key)!.not_interested, 1);
  // Java candidate's own state for the same job is untouched.
  assert.equal(getCandidateJobState(javaCandidateId, javaJob.dedupe_key)?.not_interested ?? 0, 0);
  // The global jobs table is completely unaffected — no delete, no row count change.
  assert.equal(listJobs({}).length, jobsBefore);
  const stillThere = listJobs({ candidateId: javaCandidateId }).find((j) => j.dedupe_key === javaJob.dedupe_key);
  assert.ok(stillThere, "job must still be visible to the other candidate");
});

test("independent notes/tags/pins on the same shared job", () => {
  setNotesAndTags(dataEngCandidateId, javaJob.dedupe_key, "Interesting but not my stack", ["maybe"]);
  setPinned(javaCandidateId, javaJob.dedupe_key, true);

  const aState = getCandidateJobState(dataEngCandidateId, javaJob.dedupe_key)!;
  const bState = getCandidateJobState(javaCandidateId, javaJob.dedupe_key)!;
  assert.equal(aState.notes, "Interesting but not my stack");
  assert.equal(aState.pinned, 0);
  assert.equal(bState.notes, null);
  assert.equal(bState.pinned, 1);
});

test("independent candidate settings/preferences — changing one candidate's target role never touches the other's", () => {
  updateCandidateSettings(dataEngCandidateId, { preferences: { primaryTargetRole: "Data Engineer", secondaryTargetRoles: ["Azure Data Engineer"] } });
  updateCandidateSettings(javaCandidateId, { preferences: { primaryTargetRole: "Java Developer", secondaryTargetRoles: [] } });

  assert.equal(getRankingPreferences(dataEngCandidateId).primaryTargetRole, "Data Engineer");
  assert.equal(getRankingPreferences(javaCandidateId).primaryTargetRole, "Java Developer");

  // Match-affecting eligibility settings are untouched by either preference change (both still the
  // conservative defaults) — the ranking/match-affecting boundary holds even across two real
  // candidates sharing a database, not just within one candidate's own hash test.
  assert.equal(getMatchAffectingSettings(dataEngCandidateId).requiresSponsorship, true);
  assert.equal(getMatchAffectingSettings(javaCandidateId).requiresSponsorship, true);
});

test("For You produces different ordering for each candidate over the exact same shared jobs", () => {
  const dataEngPrefs = getRankingPreferences(dataEngCandidateId);
  const javaPrefs = getRankingPreferences(javaCandidateId);

  function buildInputs(prefs: { primaryTargetRole: string | null; secondaryTargetRoles: string[] }): ForYouJobInput[] {
    return [dataEngJob, javaJob].map((job) => ({
      jobId: job.id,
      dedupeKey: job.dedupe_key,
      title: job.id === dataEngJob.id ? "Senior Data Engineer" : "Senior Java Developer",
      postedAt: new Date().toISOString(),
      h1bCombinedConfidence: "Unknown",
      sponsorshipMentioned: false,
      sponsorshipPolarity: "none",
      notInterested: false,
      roleFamilyTier: computeRoleFamilyTier(job.id === dataEngJob.id ? "Senior Data Engineer" : "Senior Java Developer", prefs),
    }));
  }

  const rankedForDataEng = rankForYou(buildInputs(dataEngPrefs));
  const rankedForJava = rankForYou(buildInputs(javaPrefs));

  assert.equal(rankedForDataEng[0].dedupeKey, dataEngJob.dedupe_key, "Data Engineer candidate should see the Data Engineer role first");
  assert.equal(rankedForJava[0].dedupeKey, javaJob.dedupe_key, "Java candidate should see the Java role first");
});

test("candidate profile files are isolated per candidate — no fallback to another candidate's files", () => {
  function writeProfile(candidateId: number, resumeHash: string, skillsHash: string) {
    const dir = path.join(tmpCandidatesDir, String(candidateId));
    const masterDir = path.join(dir, "master");
    fs.mkdirSync(masterDir, { recursive: true });
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
        resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: resumeHash },
        skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: skillsHash },
      })
    );
  }

  writeProfile(dataEngCandidateId, "resume-hash-dataeng", "skills-hash-dataeng");
  writeProfile(javaCandidateId, "resume-hash-java", "skills-hash-java");

  const dataEngResult = loadCandidateProfile(dataEngCandidateId);
  const javaResult = loadCandidateProfile(javaCandidateId);
  assert.equal(dataEngResult.status, "ok");
  assert.equal(javaResult.status, "ok");
  if (dataEngResult.status !== "ok" || javaResult.status !== "ok") return;

  const dataEngHash = candidateProfileHash(dataEngResult.profile);
  const javaHash = candidateProfileHash(javaResult.profile);
  assert.notEqual(dataEngHash, javaHash);

  // Delete the Java candidate's files entirely — the Data Engineer candidate's profile must still
  // load correctly, and the Java candidate must report "missing", never silently fall back to
  // Candidate A's files (see candidateProfile.ts's own "no implicit current-candidate fallback" rule).
  fs.rmSync(path.join(tmpCandidatesDir, String(javaCandidateId)), { recursive: true, force: true });
  assert.equal(loadCandidateProfile(javaCandidateId).status, "missing");
  assert.equal(loadCandidateProfile(dataEngCandidateId).status, "ok");
});

test("changing one candidate's resume (new sourceHashes) never invalidates the other's already-stored match cache row", () => {
  const beforeRow = getLatestJobMatchResult(javaCandidateId, dataEngJob.dedupe_key)!;
  assert.equal(beforeRow.candidate_profile_hash, "java-profile-v1");

  // Simulate the Data Engineer candidate uploading a new resume — a brand new profile hash.
  const dir = path.join(tmpCandidatesDir, String(dataEngCandidateId));
  fs.mkdirSync(path.join(dir, "master"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: "resume-hash-dataeng-v2", skills: "skills-hash-dataeng" },
      builtAt: "2026-02-01T00:00:00Z",
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
      resume: { filename: "resume.docx", uploadedAt: "2026-02-01T00:00:00Z", sizeBytes: 100, sha256: "resume-hash-dataeng-v2" },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: "skills-hash-dataeng" },
    })
  );

  const updated = loadCandidateProfile(dataEngCandidateId);
  assert.equal(updated.status, "ok");
  if (updated.status !== "ok") return;
  assert.equal(candidateProfileHash(updated.profile), "resume-hash-dataeng-v2:skills-hash-dataeng");

  // The Java candidate's previously-inserted, immutable job_match_results row is byte-for-byte
  // unchanged — no shared mutable state, no accidental cross-candidate cache invalidation.
  const afterRow = getLatestJobMatchResult(javaCandidateId, dataEngJob.dedupe_key)!;
  assert.equal(afterRow.candidate_profile_hash, "java-profile-v1");
  assert.equal(afterRow.id, beforeRow.id);
});
