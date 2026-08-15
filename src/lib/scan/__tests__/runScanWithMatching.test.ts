import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Company } from "@/types";

/**
 * Phase 4 Stage 2 — runScanWithIncrementalMatching (the ONE shared post-scan orchestration both
 * POST /api/scan and the scheduler tick call). Real (temp) DB + candidates dir, stubbed
 * globalThis.fetch for Greenhouse — no network. See src/lib/scan/runScanWithMatching.ts's doc
 * comment for the exact "catastrophic scan failure skips matching" contract under test here.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;
let getDb: typeof import("@/db").getDb;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let listMatchRuns: typeof import("@/db/queries/matchRuns").listMatchRuns;
let runScanWithIncrementalMatching: typeof import("../runScanWithMatching").runScanWithIncrementalMatching;

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-run-scan-matching-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-run-scan-matching-candidates-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;

  ({ getDb } = await import("@/db"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ listMatchRuns } = await import("@/db/queries/matchRuns"));
  ({ runScanWithIncrementalMatching } = await import("../runScanWithMatching"));

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
  return createCompany({ name: `RunScanMatching Co ${companyCounter}`, source_type: "greenhouse", ats_board_token: `run-scan-matching-${companyCounter}` });
}

function stubGreenhouseResponse(jobs: { id: number; title: string }[]) {
  const body = {
    jobs: jobs.map((j) => ({
      id: j.id,
      title: j.title,
      location: { name: "Austin, TX" },
      departments: [{ name: "Engineering" }],
      absolute_url: `https://boards.greenhouse.io/co/jobs/${j.id}`,
      content: "<p>Job description.</p>",
      updated_at: new Date().toISOString(),
    })),
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

let originalFetch: typeof fetch;

test("88. zero affected jobs (empty company response) means the matcher is never invoked", async () => {
  originalFetch = globalThis.fetch;
  try {
    const company = makeCompany();
    stubGreenhouseResponse([]); // no jobs at all -> zero affected
    const runsBefore = listMatchRuns().length;

    const { scan, matching } = await runScanWithIncrementalMatching([company]);
    assert.equal(scan.affectedJobDedupeKeys.length, 0);
    assert.equal(matching.candidatesConsidered, 0);
    assert.equal(matching.pairsAttempted, 0);
    assert.equal(listMatchRuns().length, runsBefore, "no match_runs row is written when the matcher was never invoked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("89. scan and matching are both populated when there are affected jobs and active candidates", async () => {
  originalFetch = globalThis.fetch;
  try {
    const company = makeCompany();
    const candidate = createCandidate({ firstName: "Populated", lastName: "Result" });
    writeValidProfile(candidate.id);
    stubGreenhouseResponse([{ id: 101, title: "Data Engineer" }]);

    const { scan, matching } = await runScanWithIncrementalMatching([company]);
    assert.equal(scan.affectedJobDedupeKeys.length, 1);
    assert.equal(matching.jobsResolved, 1);
    assert.ok(matching.candidatesConsidered >= 1);
    assert.equal(matching.resultsCreated + matching.resultsReused + matching.failures.length, matching.pairsAttempted);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("90. a matching-side failure (missing candidate profile) does not affect the scan's own success result", async () => {
  originalFetch = globalThis.fetch;
  try {
    const company = makeCompany();
    const candidate = createCandidate({ firstName: "No", lastName: "ProfileHere" });
    // Deliberately no writeValidProfile call.
    stubGreenhouseResponse([{ id: 102, title: "Backend Engineer" }]);

    const { scan, matching } = await runScanWithIncrementalMatching([company]);
    assert.equal(scan.results[0].status, "ok", "the scan itself succeeded regardless of matching outcomes");
    assert.ok(matching.failures.some((f) => f.candidateId === candidate.id));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("91. runScan throwing before returning skips incremental matching entirely", async () => {
  const runsBefore = listMatchRuns().length;
  await assert.rejects(() => runScanWithIncrementalMatching(undefined as unknown as Company[]));
  assert.equal(listMatchRuns().length, runsBefore, "matching must never run when the scan itself throws");
});
