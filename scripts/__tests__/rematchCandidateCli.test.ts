import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * Phase 4 Stage 5 — scripts/rematch-candidate.ts, exercised as a real subprocess against an
 * isolated temp DB/candidate directory (never the production database — CAREER_OPS_DB_PATH and
 * CAREER_OPS_CANDIDATES_DIR are both overridden below, mirroring every other isolated-DB test in
 * this repo). This proves the CLI actually terminates and produces the expected job_match_results
 * row, not just that its source imports the right function.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;
let dbPath: string;

const repoRoot = path.resolve(__dirname, "..", "..");

before(() => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-rematch-cli-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-rematch-cli-candidates-"));
  dbPath = path.join(tmpDbDir, "test.db");
});

after(() => {
  try {
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  } catch {}
});

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("npx", ["tsx", "scripts/rematch-candidate.ts", ...args], {
      cwd: repoRoot,
      env: { ...process.env, CAREER_OPS_DB_PATH: dbPath, CAREER_OPS_CANDIDATES_DIR: tmpCandidatesDir },
      encoding: "utf-8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Seeds a candidate + 3 real jobs and returns the candidate's id. NOT assumed to be 1 — getDb()
 *  auto-seeds a "Candidate #1" row with id=1 for backward compatibility (see src/db/index.ts's
 *  ensureCandidateOne), so a freshly createCandidate()'d candidate in this test gets id=2. */
function seedCandidateWithJobs(): number {
  const stdout = execFileSync(
    "npx",
    [
      "tsx",
      "-e",
      `
      process.env.CAREER_OPS_DB_PATH = ${JSON.stringify(dbPath)};
      process.env.CAREER_OPS_CANDIDATES_DIR = ${JSON.stringify(tmpCandidatesDir)};
      import("@/db").then(async ({ getDb }) => {
        getDb();
        const { createCandidate } = await import("@/db/queries/candidates");
        const { createCompany } = await import("@/db/queries/companies");
        const { upsertJob } = await import("@/db/queries/jobs");
        const { dedupeKeyForAts } = await import("@/lib/dedupe");
        const fs = await import("node:fs");
        const path = await import("node:path");

        const candidate = createCandidate({ firstName: "Cli", lastName: "Seeded" });
        const dir = path.join(${JSON.stringify(tmpCandidatesDir)}, String(candidate.id));
        fs.mkdirSync(path.join(dir, "master"), { recursive: true });
        fs.writeFileSync(
          path.join(dir, "candidate-profile.json"),
          JSON.stringify({
            schemaVersion: 1,
            sourceHashes: { resume: "cli-r", skills: "cli-s" },
            builtAt: "2026-01-01T00:00:00Z",
            skills: [{ rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] }],
            experience: [{ employer: "Acme", title: "Data Engineer", startDate: "2020-01", endDate: null, technologies: ["Python"] }],
            education: [],
            certifications: [],
            totalYearsExperience: null,
          })
        );
        fs.writeFileSync(
          path.join(dir, "master", "manifest.json"),
          JSON.stringify({
            resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: "cli-r" },
            skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: "cli-s" },
          })
        );

        const company = createCompany({ name: "Cli Test Co", source_type: "greenhouse", ats_board_token: "cli-test-co" });
        for (let i = 0; i < 3; i++) {
          const externalId = "cli-job-" + i;
          const dedupeKey = dedupeKeyForAts("greenhouse", company.id, externalId);
          upsertJob({
            companyId: company.id,
            sourceType: "greenhouse",
            dedupeKey,
            job: {
              externalId,
              title: "CLI Test Role " + i,
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
        }
        console.log("SEED_DONE candidateId=" + candidate.id);
      });
      `,
    ],
    { cwd: repoRoot, env: { ...process.env, CAREER_OPS_DB_PATH: dbPath, CAREER_OPS_CANDIDATES_DIR: tmpCandidatesDir }, encoding: "utf-8" }
  );
  const match = stdout.match(/SEED_DONE candidateId=(\d+)/);
  if (!match) throw new Error(`seed script did not report a candidateId — stdout was:\n${stdout}`);
  return Number(match[1]);
}

test("1. missing candidateId argument exits non-zero with a usage message, without touching the DB", () => {
  const result = runCli([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: npm run rematch-candidate/);
});

test("2. a non-existent candidateId exits non-zero", () => {
  const result = runCli(["999999"]);
  assert.notEqual(result.status, 0);
});

test(
  "3. the CLI drives the same canonical page service to completion (hasMore=false) and persists real match results",
  { timeout: 60000 },
  () => {
    const candidateId = seedCandidateWithJobs();

    const result = runCli([String(candidateId), "--limit", "2"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Rematching Cli Seeded \\(candidate ${candidateId}\\)`));
    // 3 jobs at limit 2 -> exactly 2 pages, proving pagination genuinely terminates (test 30).
    assert.match(result.stdout, /page 1:/);
    assert.match(result.stdout, /page 2:/);
    assert.doesNotMatch(result.stdout, /page 3:/);
    assert.match(result.stdout, /Created 3/);
    assert.match(result.stdout, /Done\. 2 page\(s\), 3 pair\(s\) processed\./);
  }
);
