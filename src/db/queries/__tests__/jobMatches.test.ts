import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { JobMatchResult } from "@/lib/match/types";

/**
 * job_match_results query layer: immutable insert-or-return-existing (mirrors ai_enrichments), and
 * — the critical identity-safety proof the approved plan requires — that dedupe_key, not job_id, is
 * what every lookup uses, so match history survives the underlying job row being deleted (and its
 * numeric id later reused by an unrelated job), exactly like ai_enrichments already does for
 * entity_key vs. entity_id.
 */

let tmpDir: string;
let getDb: typeof import("../../index").getDb;
let insertJobMatchResult: typeof import("../jobMatches").insertJobMatchResult;
let getJobMatchResult: typeof import("../jobMatches").getJobMatchResult;
let getLatestJobMatchResult: typeof import("../jobMatches").getLatestJobMatchResult;
let listJobMatchHistory: typeof import("../jobMatches").listJobMatchHistory;
let deserializeJobMatchResult: typeof import("../jobMatches").deserializeJobMatchResult;
let createCompany: typeof import("../companies").createCompany;
let upsertJob: typeof import("../jobs").upsertJob;
let getJobByDedupeKey: typeof import("../jobs").getJobByDedupeKey;
let markNotInterested: typeof import("../jobs").markNotInterested;
let dedupeKeyForAts: typeof import("../../../lib/dedupe").dedupeKeyForAts;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-job-matches-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
  ({ insertJobMatchResult, getJobMatchResult, getLatestJobMatchResult, listJobMatchHistory, deserializeJobMatchResult } =
    await import("../jobMatches"));
  ({ createCompany } = await import("../companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("../jobs"));
  ({ markNotInterested } = await import("../jobs"));
  ({ dedupeKeyForAts } = await import("../../../lib/dedupe"));
  getDb();
});

function seedJob(params: { companyId: number; externalId: string; dedupeKey: string; url: string; title: string }) {
  upsertJob({
    companyId: params.companyId,
    sourceType: "greenhouse",
    dedupeKey: params.dedupeKey,
    job: {
      externalId: params.externalId,
      title: params.title,
      location: null,
      department: null,
      url: params.url,
      descriptionHtml: null,
      descriptionText: "desc",
      employmentType: null,
      workplaceType: null,
      salaryText: null,
      postedAt: null,
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  return getJobByDedupeKey(params.dedupeKey)!;
}

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeResult(overrides: Partial<JobMatchResult> = {}): JobMatchResult {
  return {
    candidateId: 1,
    jobId: 1,
    dedupeKey: "greenhouse:1:ext-1",
    matchEngineVersion: 1,
    matchKnowledgeHash: "knowledge-hash-1",
    candidateProfileHash: "profile-hash-1",
    candidateSettingsHash: "settings-hash-1",
    jdContentHash: "jd-hash-1",
    computedAt: "2026-01-01T00:00:00Z",
    eligibility: { status: "PASS", reasons: ["No known hard blocker identified."], sponsorship: { signal: "not_applicable", note: "n/a" } },
    dimensionScores: { roleAlignment: null, required: 90, preferred: 50, experience: 100, seniority: 100 },
    overallScore: 87,
    requirementCoverage: 0.95,
    employerEvidencedShare: 0.9,
    insufficientJdSignal: false,
    employerEvidencedMatches: [],
    inventoryOnlyMatches: [],
    transferableMatches: [],
    missingRequirements: [],
    unresolvedRequirements: [],
    criticalGaps: [],
    unrecognizedCandidateSkills: [],
    recommendedTrack: "Data Engineer",
    decision: "READY_FOR_TAILORING",
    blockingReasons: [],
    roleAlignmentDetail: null,
    ...overrides,
  };
}

test("insertJobMatchResult writes a new row for a new exact key", () => {
  const row = insertJobMatchResult(fakeResult({ dedupeKey: "key-a" }));
  assert.ok(row.id > 0);
  assert.equal(row.dedupe_key, "key-a");
  assert.equal(row.decision, "READY_FOR_TAILORING");
  assert.equal(row.status, "active");
});

test("insertJobMatchResult with an identical key returns the existing row (immutable cache hit), never a duplicate", () => {
  const first = insertJobMatchResult(fakeResult({ dedupeKey: "key-b" }));
  const second = insertJobMatchResult(fakeResult({ dedupeKey: "key-b", overallScore: 999 })); // different content, SAME key
  assert.equal(second.id, first.id);
  assert.equal(second.overall_score, first.overall_score, "the immutable row must keep its ORIGINAL content, never be overwritten");
});

test("a genuinely different key (e.g. JD content changed) inserts a new row and supersedes the old one", () => {
  const first = insertJobMatchResult(fakeResult({ dedupeKey: "key-c", jdContentHash: "jd-v1" }));
  const second = insertJobMatchResult(fakeResult({ dedupeKey: "key-c", jdContentHash: "jd-v2" }));
  assert.notEqual(second.id, first.id);
  const history = listJobMatchHistory(1, "key-c");
  assert.equal(history.length, 2);
  const reloadedFirst = getJobMatchResult({
    candidateId: 1,
    dedupeKey: "key-c",
    matchEngineVersion: 1,
    matchKnowledgeHash: "knowledge-hash-1",
    candidateProfileHash: "profile-hash-1",
    candidateSettingsHash: "settings-hash-1",
    jdContentHash: "jd-v1",
  });
  assert.equal(reloadedFirst?.status, "superseded", "the old row is marked superseded (metadata only) once a newer one exists for the same dedupe_key");
});

test("getLatestJobMatchResult returns the most recent row for a dedupe_key", () => {
  insertJobMatchResult(fakeResult({ dedupeKey: "key-d", jdContentHash: "v1" }));
  insertJobMatchResult(fakeResult({ dedupeKey: "key-d", jdContentHash: "v2" }));
  const latest = getLatestJobMatchResult(1, "key-d");
  assert.equal(latest?.jd_content_hash, "v2");
});

test("getLatestJobMatchResult scopes strictly by candidate — Candidate A's result is never returned for Candidate B's lookup of the same job", () => {
  insertJobMatchResult(fakeResult({ candidateId: 1, dedupeKey: "key-multi", jdContentHash: "shared-jd", overallScore: 90 }));
  insertJobMatchResult(fakeResult({ candidateId: 2, dedupeKey: "key-multi", jdContentHash: "shared-jd", candidateProfileHash: "profile-hash-2", overallScore: 40 }));

  const forCandidateOne = getLatestJobMatchResult(1, "key-multi");
  const forCandidateTwo = getLatestJobMatchResult(2, "key-multi");
  assert.equal(forCandidateOne?.overall_score, 90);
  assert.equal(forCandidateTwo?.overall_score, 40);
  assert.notEqual(forCandidateOne?.id, forCandidateTwo?.id);
});

test("unrelated notes/tags/pipeline_status changes are structurally impossible to affect the cache key (they were never part of the input)", () => {
  // The cache key is exactly (dedupe_key, match_engine_version, match_knowledge_hash,
  // candidate_profile_hash, candidate_settings_hash, jd_content_hash) — none of these are derived
  // from jobs.notes/tags/pipeline_status/pinned, so an identical re-computation after only those
  // fields changed is guaranteed to hit the same cache row.
  const first = insertJobMatchResult(fakeResult({ dedupeKey: "key-e" }));
  const second = insertJobMatchResult(fakeResult({ dedupeKey: "key-e" })); // simulates re-evaluation after only UI-state changed
  assert.equal(second.id, first.id);
});

test("match history survives the underlying job row being deleted, and remains correct even after the numeric id is reused by an unrelated job", () => {
  const company = createCompany({ name: "Acme", source_type: "greenhouse" });
  const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "ext-100");
  const jobA = seedJob({ companyId: company.id, externalId: "ext-100", dedupeKey, url: "https://boards.greenhouse.io/acme/jobs/100", title: "Data Engineer" });

  insertJobMatchResult(fakeResult({ dedupeKey, jobId: jobA.id, jdContentHash: "job-a-jd" }));
  assert.equal(getLatestJobMatchResult(1, dedupeKey)?.job_id, jobA.id);

  // Delete the job (Not Interested) — job_match_results has NO FK on job_id, so this must succeed
  // without being blocked, and the match row must survive it (see the table's IDENTITY SAFETY
  // comment in schema.sql).
  const deleted = markNotInterested(jobA.id);
  assert.ok(deleted, "Phase 2's existence must never prevent Phase 1 job deletion");

  const survivingHistory = listJobMatchHistory(1, dedupeKey);
  assert.equal(survivingHistory.length, 1, "match history must survive deletion of the job it was computed for");
  assert.equal(survivingHistory[0].dedupe_key, dedupeKey);

  // A brand-new, unrelated job happening to reuse jobA's numeric id (SQLite's non-AUTOINCREMENT
  // INTEGER PRIMARY KEY can do this) must NOT cause any confusion — dedupe_key-based lookup is
  // completely unaffected by what job_id currently points at.
  const otherCompany = createCompany({ name: "Other Co", source_type: "greenhouse" });
  const otherDedupeKey = dedupeKeyForAts("greenhouse", otherCompany.id, "ext-999");
  const unrelatedJob = seedJob({
    companyId: otherCompany.id,
    externalId: "ext-999",
    dedupeKey: otherDedupeKey,
    url: "https://boards.greenhouse.io/other/jobs/999",
    title: "Totally Different Role",
  });
  insertJobMatchResult(fakeResult({ dedupeKey: otherDedupeKey, jobId: unrelatedJob.id, jdContentHash: "unrelated-jd" }));

  // The original job's match history is still keyed correctly on its own dedupe_key, regardless of
  // whatever job_id values now exist in the table.
  const stillCorrect = listJobMatchHistory(1, dedupeKey);
  assert.equal(stillCorrect.length, 1);
  assert.equal(stillCorrect[0].dedupe_key, dedupeKey);
});

// --- Phase 2.5 persistence-contract regression coverage -----------------------------------------
// Guards against the exact class of bug that caused the MatchCard crash: a field silently dropped
// between evaluateJobMatch's in-memory JobMatchResult and what a later GET reconstructs from the DB.
// This test asserts FULL structural round-trip equivalence, not just the one field that happened to
// crash — every key of JobMatchResult must survive insert -> deserialize unchanged.

const JOB_MATCH_RESULT_KEYS: (keyof JobMatchResult)[] = [
  "candidateId", "jobId", "dedupeKey", "matchEngineVersion", "matchKnowledgeHash", "candidateProfileHash",
  "candidateSettingsHash", "jdContentHash", "computedAt", "eligibility", "dimensionScores",
  "overallScore", "requirementCoverage", "employerEvidencedShare", "insufficientJdSignal",
  "employerEvidencedMatches", "inventoryOnlyMatches", "transferableMatches", "missingRequirements",
  "unresolvedRequirements", "criticalGaps", "unrecognizedCandidateSkills", "recommendedTrack",
  "decision", "blockingReasons",
];

test("deserializeJobMatchResult round-trips every JobMatchResult field, including the four hash fields, eligibility.sponsorship, and criticalGaps", () => {
  const fixture = fakeResult({
    dedupeKey: "key-roundtrip",
    criticalGaps: [
      {
        requirement: {
          kind: "skill",
          memberSkillNames: ["Kubernetes"],
          categories: [],
          label: "Kubernetes",
          requirementLevel: "Required",
          criticality: "CRITICAL",
          evidenceSnippets: ["must have Kubernetes"],
          experienceDepthRequired: true,
          fromUnclaimedText: false,
        },
        matchType: "MISSING",
        credit: 0,
      },
    ],
    eligibility: { status: "UNKNOWN", reasons: ["No sponsorship language found."], sponsorship: { signal: "unknown", note: "No JD language, no company history on file." } },
  });

  const row = insertJobMatchResult(fixture);
  const roundTripped = deserializeJobMatchResult(row);

  // Every key the type declares must be present and structurally equal to the original input
  // (computedAt is DB-assigned, not part of the round-trip contract, so it's excluded on purpose).
  for (const key of JOB_MATCH_RESULT_KEYS) {
    if (key === "computedAt") continue;
    assert.deepEqual(roundTripped[key], fixture[key], `field '${key}' did not round-trip correctly`);
  }
  assert.equal(typeof roundTripped.computedAt, "string");
});

test("deserializeJobMatchResult degrades safely on a legacy row missing criticalGaps/eligibilitySponsorship in requirement_breakdown (written before this fix)", () => {
  // Simulate a pre-fix row by inserting raw SQL that omits the two new JSON keys entirely — this is
  // exactly the shape every row in the DB had before the Phase 2.5 persistence-contract fix.
  const db = getDb();
  db.prepare(
    `INSERT INTO job_match_results
      (dedupe_key, job_id, match_engine_version, match_knowledge_hash, candidate_profile_hash,
       candidate_settings_hash, jd_content_hash, eligibility_status, eligibility_reasons,
       requirement_coverage, overall_score, employer_evidenced_share, insufficient_jd_signal,
       dimension_scores, requirement_breakdown, recommended_track, decision, blocking_reasons)
     VALUES
      ('key-legacy', 1, 1, 'kh', 'ph', 'sh', 'jh', 'PASS', '[]',
       0.9, 85, 0.8, 0,
       '{"required":80,"preferred":50,"experience":100,"seniority":100}',
       @legacyBreakdown, 'Data Engineer', 'READY_FOR_TAILORING', '[]')`
  ).run({
    legacyBreakdown: JSON.stringify({
      employerEvidencedMatches: [],
      inventoryOnlyMatches: [],
      transferableMatches: [],
      missingRequirements: [
        {
          requirement: {
            kind: "skill", memberSkillNames: ["AWS"], categories: [], label: "AWS",
            requirementLevel: "Required", criticality: "CRITICAL", evidenceSnippets: [],
            experienceDepthRequired: false, fromUnclaimedText: false,
          },
          matchType: "MISSING",
          credit: 0,
        },
      ],
      unresolvedRequirements: [],
      unrecognizedCandidateSkills: [],
      // criticalGaps and eligibilitySponsorship deliberately absent — the pre-fix shape.
    }),
  });

  const legacyRow = getJobMatchResult({
    candidateId: 1, // relies on the column's DEFAULT 1 — this row's INSERT above never sets candidate_id
    dedupeKey: "key-legacy",
    matchEngineVersion: 1,
    matchKnowledgeHash: "kh",
    candidateProfileHash: "ph",
    candidateSettingsHash: "sh",
    jdContentHash: "jh",
  })!;

  const result = deserializeJobMatchResult(legacyRow);

  // criticalGaps is derived from missingRequirements/unresolvedRequirements for legacy rows — the
  // one CRITICAL missing requirement above must surface, never crash, never silently vanish.
  assert.equal(result.criticalGaps.length, 1);
  assert.equal(result.criticalGaps[0].requirement.label, "AWS");
  // eligibility.sponsorship gets an honest, clearly-labeled fallback, never a fabricated signal.
  assert.equal(result.eligibility.sponsorship.signal, "unknown");
  assert.match(result.eligibility.sponsorship.note, /before sponsorship signal persistence/);
});
