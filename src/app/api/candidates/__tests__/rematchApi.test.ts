import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { NormalizedJob } from "@/types";

/**
 * Tests src/app/api/candidates/[candidateId]/rematch/route.ts (POST). Relative import from OUTSIDE
 * the bracketed route directory — see tailoringRunsRoute.test.ts's doc comment for why (Node's test
 * runner glob-matches `[...]` path segments as character classes).
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let archiveCandidate: typeof import("@/db/queries/candidates").archiveCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getDb: typeof import("@/db").getDb;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let getLatestJobMatchResult: typeof import("@/db/queries/jobMatches").getLatestJobMatchResult;
let MAX_REMATCH_PAGE_SIZE: typeof import("@/lib/match/rematchCandidate").MAX_REMATCH_PAGE_SIZE;
let POST: typeof import("../[candidateId]/rematch/route").POST;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-rematch-api-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-rematch-api-candidates-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;

  ({ getDb } = await import("@/db"));
  ({ createCandidate, archiveCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ getLatestJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ MAX_REMATCH_PAGE_SIZE } = await import("@/lib/match/rematchCandidate"));
  ({ POST } = await import("../[candidateId]/rematch/route"));
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
  return createCompany({ name: `Rematch API Co ${companyCounter}`, source_type: "greenhouse", ats_board_token: `rematch-api-${companyCounter}` });
}

let jobCounter = 0;
function seedJob(companyId: number, overrides: Partial<NormalizedJob> = {}) {
  jobCounter++;
  const externalId = `job-${jobCounter}`;
  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, externalId);
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId,
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
    },
    descriptionSections: null,
    sponsorshipMentioned: true,
    sponsorshipPolarity: "positive",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  return dedupeKey;
}

function callPOST(candidateId: number, body: unknown = {}) {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateId}/rematch`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ candidateId: String(candidateId) }) });
}

test("1. an invalid (non-integer) candidateId is rejected with 400", async () => {
  const res = await callPOST(NaN as unknown as number);
  assert.equal(res.status, 400);
});

test("2. a non-existent candidateId is rejected with 404, cross-candidate access impossible", async () => {
  const res = await callPOST(999999);
  assert.equal(res.status, 404);
});

test("3. an archived candidateId is rejected with 404", async () => {
  const candidate = createCandidate({ firstName: "Archived", lastName: "Api" });
  archiveCandidate(candidate.id);
  const res = await callPOST(candidate.id);
  assert.equal(res.status, 404);
});

test("4. limit above MAX_REMATCH_PAGE_SIZE is rejected with 400 (API limit validation)", async () => {
  const candidate = createCandidate({ firstName: "Limit", lastName: "Api" });
  writeValidProfile(candidate.id);
  const res = await callPOST(candidate.id, { limit: MAX_REMATCH_PAGE_SIZE + 1 });
  assert.equal(res.status, 400);
});

test("5. a negative afterJobId cursor is rejected with 400 (API cursor validation)", async () => {
  const candidate = createCandidate({ firstName: "Cursor", lastName: "Api" });
  writeValidProfile(candidate.id);
  const res = await callPOST(candidate.id, { afterJobId: -1 });
  assert.equal(res.status, 400);
});

test("6. a valid request returns exactly one bounded page and persists a match result", async () => {
  const candidate = createCandidate({ firstName: "Valid", lastName: "Api" });
  writeValidProfile(candidate.id);
  const company = makeCompany();
  const key = seedJob(company.id, { title: "API Rematch Role" });

  const res = await callPOST(candidate.id, { limit: 50 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.candidateId, candidate.id);
  assert.equal(body.jobsConsidered, 1);
  assert.equal(body.resultsCreated, 1);
  assert.notEqual(getLatestJobMatchResult(candidate.id, key), undefined);
});

test("7. an omitted body is treated as a valid first-page-default-size request", async () => {
  const candidate = createCandidate({ firstName: "NoBody", lastName: "Api" });
  writeValidProfile(candidate.id);
  const req = new NextRequest(`http://localhost/api/candidates/${candidate.id}/rematch`, { method: "POST" });
  const res = await POST(req, { params: Promise.resolve({ candidateId: String(candidate.id) }) });
  assert.equal(res.status, 200);
});
