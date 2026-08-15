import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

/**
 * Phase 4 Stage 5 — the PATCH /api/candidates/[candidateId]/settings trigger: a genuine
 * match-affecting settings change (candidateSettingsHash moves) fires exactly one bounded rematch
 * page; re-saving the SAME values must fire none. See settings/route.ts's PATCH handler doc comment.
 *
 * Relative import from OUTSIDE the bracketed route directory — same reasoning as
 * tailoringRunsRoute.test.ts (Node's test runner glob-matches `[...]` as character classes).
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getDb: typeof import("@/db").getDb;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let getLatestJobMatchResult: typeof import("@/db/queries/jobMatches").getLatestJobMatchResult;
let PATCH: typeof import("../[candidateId]/settings/route").PATCH;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-settings-rematch-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-settings-rematch-candidates-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;

  ({ getDb } = await import("@/db"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ getLatestJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ PATCH } = await import("../[candidateId]/settings/route"));
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
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: `r-${candidateId}`, skills: `s-${candidateId}` },
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
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: `r-${candidateId}` },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: `s-${candidateId}` },
    })
  );
}

let companyCounter = 0;
function makeCompany() {
  companyCounter++;
  return createCompany({ name: `Settings Rematch Co ${companyCounter}`, source_type: "greenhouse", ats_board_token: `settings-rematch-${companyCounter}` });
}

let jobCounter = 0;
function seedJob(companyId: number) {
  jobCounter++;
  const externalId = `job-${jobCounter}`;
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId,
      title: "Settings Rematch Role",
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
    },
    descriptionSections: null,
    sponsorshipMentioned: true,
    sponsorshipPolarity: "positive",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  return dedupeKey;
}

function callPATCH(candidateId: number, body: unknown) {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateId}/settings`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ candidateId: String(candidateId) }) });
}

test("1. a genuine match-affecting settings change triggers exactly one bounded rematch page", async () => {
  const candidate = createCandidate({ firstName: "Settings", lastName: "Trigger" });
  writeValidProfile(candidate.id);
  const company = makeCompany();
  const key = seedJob(company.id);

  const res = await callPATCH(candidate.id, { matchAffecting: { requiresSponsorship: false } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.notEqual(body.rematch, null, "a changed matchAffecting settings hash must trigger a rematch page");
  assert.equal(body.rematch.candidateId, candidate.id);
  assert.notEqual(getLatestJobMatchResult(candidate.id, key), undefined);
});

test("2. re-saving the SAME match-affecting values does not trigger a rematch", async () => {
  const candidate = createCandidate({ firstName: "Settings", lastName: "NoOp" });
  writeValidProfile(candidate.id);

  const first = await callPATCH(candidate.id, { matchAffecting: { requiresSponsorship: true } });
  assert.equal(first.status, 200);

  const second = await callPATCH(candidate.id, { matchAffecting: { requiresSponsorship: true } });
  const body = await second.json();
  assert.equal(body.rematch, null, "identical values must not move candidateSettingsHash, so no rematch fires");
});

test("3. changing only ranking preferences (never part of the match hash) does not trigger a rematch", async () => {
  const candidate = createCandidate({ firstName: "Settings", lastName: "RankingOnly" });
  writeValidProfile(candidate.id);

  const res = await callPATCH(candidate.id, { preferences: { primaryTargetRole: "Data Engineer" } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rematch, null, "ranking-only preferences must never invalidate the Phase 2 match cache");
});

test("4. an invalid candidateId is rejected before any settings/rematch work happens", async () => {
  const res = await callPATCH(999999, { matchAffecting: { requiresSponsorship: false } });
  assert.equal(res.status, 404);
});
