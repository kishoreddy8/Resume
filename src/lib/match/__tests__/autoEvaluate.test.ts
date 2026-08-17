import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * STAGE 24B — automatic evaluation completeness (Phase 11) and staleness invalidation (Phase 12).
 *
 * The Stage 24A selector only ever re-selected a job with no result at all, or one whose latest
 * result was insufficient-signal AND whose job row had changed. That left a real hole: once a job
 * had ANY meaningful evaluation, no automatic run would touch it again — not after a
 * MATCH_ENGINE_VERSION bump, not after a scoring-constant change, not after the candidate rebuilt
 * their profile, not after they changed a match-affecting eligibility setting. Stage 24B itself
 * changes both the engine version and the scoring weights, so this hole would have frozen the entire
 * corpus behind the UI. These tests pin the fixed behaviour, including the convergence property the
 * narrow original condition existed to protect.
 */

let tmpDir: string;
let masterDir: string;
let getDb: typeof import("../../../db/index").getDb;
let createCompany: typeof import("../../../db/queries/companies").createCompany;
let upsertJob: typeof import("../../../db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("../../../db/queries/jobs").getJobByDedupeKey;
let runAutomaticJobEvaluation: typeof import("../autoEvaluate").runAutomaticJobEvaluation;
let countJobsNeedingEvaluation: typeof import("../autoEvaluate").countJobsNeedingEvaluation;

const HASH_R = crypto.createHash("sha256").update("resume").digest("hex");
const HASH_S = crypto.createHash("sha256").update("skills").digest("hex");

function writeCandidateProfile(resumeHash = HASH_R) {
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: resumeHash },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: HASH_S },
    })
  );
  fs.writeFileSync(
    path.join(masterDir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: resumeHash, skills: HASH_S },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [
        { rawSkillName: "PySpark", source: "employer", attributedTo: [{ employer: "Acme" }] },
        { rawSkillName: "Snowflake", source: "employer", attributedTo: [{ employer: "Acme" }] },
        { rawSkillName: "SQL", source: "employer", attributedTo: [{ employer: "Acme" }] },
      ],
      experience: [{ employer: "Acme", title: "Data Engineer", startDate: "2019-01", endDate: null, technologies: [] }],
      education: [],
      certifications: [],
      totalYearsExperience: null,
    })
  );
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-auto-eval-"));
  masterDir = path.join(tmpDir, "master");
  fs.mkdirSync(masterDir);
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  process.env.CAREER_OPS_MASTER_DIR = masterDir;
  writeCandidateProfile();

  ({ getDb } = await import("../../../db/index"));
  ({ createCompany } = await import("../../../db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("../../../db/queries/jobs"));
  ({ runAutomaticJobEvaluation, countJobsNeedingEvaluation } = await import("../autoEvaluate"));
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_MASTER_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function seedJob(companyId: number, title = "Senior Data Engineer", descriptionText = "PySpark and Snowflake and SQL required for this data engineering role.") {
  const dedupeKey = `greenhouse:${companyId}:auto-${++seq}`;
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: `auto-${seq}`,
      title,
      location: "Dallas, TX",
      department: null,
      url: `https://example.test/${seq}`,
      descriptionHtml: null,
      descriptionText,
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

test("a newly ingested job is picked up automatically, with no manual Evaluate click", () => {
  const company = createCompany({ name: `Auto Co ${seq}`, source_type: "greenhouse", ats_board_token: `tok-${seq}` });
  const job = seedJob(company.id);

  assert.ok(countJobsNeedingEvaluation(1) >= 1, "the fresh job must show up in the backlog");
  const result = runAutomaticJobEvaluation(1, 50);
  assert.ok(result.evaluated >= 1, "the tick must produce a result without any user interaction");

  const row = getDb().prepare("SELECT COUNT(*) c FROM job_match_results WHERE candidate_id = 1 AND dedupe_key = ?").get(job.dedupe_key) as { c: number };
  assert.equal(row.c, 1);
});

test("an already-evaluated, unchanged job is NOT recomputed on the next run — the backlog converges", () => {
  const company = createCompany({ name: `Converge Co ${seq}`, source_type: "greenhouse", ats_board_token: `tok-${seq}` });
  seedJob(company.id);
  runAutomaticJobEvaluation(1, 500);

  const backlogAfterFirstPass = countJobsNeedingEvaluation(1);
  assert.equal(backlogAfterFirstPass, 0, "nothing should remain outstanding once every active job has a current result");

  const second = runAutomaticJobEvaluation(1, 500);
  assert.equal(second.candidatesFound, 0, "a converged corpus selects zero jobs — no wasted recomputation");
  assert.equal(second.evaluated, 0);
});

test("a job whose JD genuinely never clears the requirement floor is evaluated once, then left alone (no infinite re-selection)", () => {
  const company = createCompany({ name: `Sparse Co ${seq}`, source_type: "greenhouse", ats_board_token: `tok-${seq}` });
  seedJob(company.id, "Classroom Floater", "We are hiring. Apply today.");
  runAutomaticJobEvaluation(1, 500);
  assert.equal(countJobsNeedingEvaluation(1), 0);
  assert.equal(runAutomaticJobEvaluation(1, 500).candidatesFound, 0);
});

test("changing the job itself re-opens it for automatic evaluation", () => {
  const company = createCompany({ name: `Changed Co ${seq}`, source_type: "greenhouse", ats_board_token: `tok-${seq}` });
  const job = seedJob(company.id);
  runAutomaticJobEvaluation(1, 500);
  assert.equal(countJobsNeedingEvaluation(1), 0);

  // Model "the JD changed AFTER it was evaluated" by back-dating the existing result rather than
  // future-dating the job — a future updated_at is not something upsertJob can produce, and using one
  // here would leave the row permanently newer than any evaluation that follows it.
  getDb().prepare("UPDATE job_match_results SET created_at = datetime('now', '-1 minute') WHERE candidate_id = 1 AND dedupe_key = ?").run(job.dedupe_key);
  getDb()
    .prepare("UPDATE jobs SET description_text = ?, updated_at = datetime('now') WHERE id = ?")
    .run("Revised description: PySpark, Snowflake, SQL, Kafka and Flink required.", job.id);

  assert.equal(countJobsNeedingEvaluation(1), 1, "a changed JD must re-enter the backlog");
  const rerun = runAutomaticJobEvaluation(1, 500);
  assert.equal(rerun.evaluated, 1, "and must actually produce a fresh result, not a cache hit");
});

test("a changed candidate profile re-opens EVERY evaluated job — the Stage 24A selector could never do this", () => {
  runAutomaticJobEvaluation(1, 500);
  assert.equal(countJobsNeedingEvaluation(1), 0);

  const totalActive = (getDb().prepare("SELECT COUNT(*) c FROM jobs WHERE is_active = 1").get() as { c: number }).c;
  writeCandidateProfile(crypto.createHash("sha256").update("resume-v2").digest("hex"));

  assert.equal(countJobsNeedingEvaluation(1), totalActive, "a rebuilt profile invalidates every cached result");
  const rerun = runAutomaticJobEvaluation(1, 500);
  assert.equal(rerun.evaluated, totalActive);
  assert.equal(countJobsNeedingEvaluation(1), 0, "and the corpus converges again in one pass");
});

test("an explicit job-id override bypasses backlog selection (operator refresh path) without breaking isolation", () => {
  const company = createCompany({ name: `Explicit Co ${seq}`, source_type: "greenhouse", ats_board_token: `tok-${seq}` });
  const job = seedJob(company.id);
  runAutomaticJobEvaluation(1, 500);

  const forced = runAutomaticJobEvaluation(1, 500, [job.id]);
  assert.equal(forced.processed, 1);
  assert.equal(forced.cached, 1, "re-running an unchanged job explicitly is a cache hit, never a duplicate row");
  assert.equal(forced.errored, 0);
});

test("an unusable candidate profile never produces a match result and never throws", () => {
  const profilePath = path.join(masterDir, "candidate-profile.json");
  const saved = fs.readFileSync(profilePath, "utf-8");
  fs.rmSync(profilePath);
  try {
    const company = createCompany({ name: `NoProfile Co ${seq}`, source_type: "greenhouse", ats_board_token: `tok-${seq}` });
    const job = seedJob(company.id);
    const result = runAutomaticJobEvaluation(1, 500, [job.id]);
    assert.equal(result.evaluated, 0);
    assert.equal(result.unavailable, 1);
    assert.equal(result.errored, 0);
  } finally {
    fs.writeFileSync(profilePath, saved);
  }
});
