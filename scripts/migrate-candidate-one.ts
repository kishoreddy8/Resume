import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/db";

/**
 * One-time Phase 2.5 migration: copies (never moves) the existing singleton data/master/** into
 * data/candidates/1/**, and backfills candidate_job_state/candidate_job_state_history from the
 * legacy jobs.* personal-state columns and job_status_history rows. Idempotent and additive:
 *   - data/master/** is left completely untouched (read-only source, copy only).
 *   - jobs.pipeline_status/pinned/notes/tags/marked_for_tailoring are left completely untouched.
 *   - job_status_history rows are left completely untouched (read-only source for the backfill).
 *   - Re-running this script is safe: file copies overwrite only the data/candidates/1/ copies (not
 *     the originals), and the candidate_job_state backfill uses INSERT OR IGNORE keyed on
 *     (candidate_id, dedupe_key) so it never duplicates or overwrites a row a live API call already
 *     wrote after this script's first run.
 *
 * Usage: CAREER_OPS_CANDIDATE_ONE_DEST=<dir> npx tsx scripts/migrate-candidate-one.ts   (dry run)
 *        npx tsx scripts/migrate-candidate-one.ts                                        (live run)
 */

const REPO_ROOT = path.join(__dirname, "..");
const SOURCE_MASTER_DIR = path.join(REPO_ROOT, "data", "master");
const DEST_ROOT = process.env.CAREER_OPS_CANDIDATE_ONE_DEST
  ? path.join(process.env.CAREER_OPS_CANDIDATE_ONE_DEST, "candidates", "1")
  : path.join(REPO_ROOT, "data", "candidates", "1");

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyMasterFiles() {
  const destMaster = path.join(DEST_ROOT, "master");
  const destHistory = path.join(destMaster, "history");
  fs.mkdirSync(destHistory, { recursive: true });

  const manifestPath = path.join(SOURCE_MASTER_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.log("No data/master/manifest.json found — nothing to migrate for master files (fresh install, no candidate uploaded yet).");
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
    resume?: { filename: string; sha256: string };
    skills?: { filename: string; sha256: string };
  };

  for (const slot of ["resume", "skills"] as const) {
    const entry = manifest[slot];
    if (!entry) continue;
    const ext = path.extname(entry.filename) || ".docx";
    const sourceFile = path.join(SOURCE_MASTER_DIR, `${slot}${ext}`);
    if (!fs.existsSync(sourceFile)) {
      throw new Error(`manifest.json references ${slot} but data/master/${slot}${ext} is missing — refusing to proceed`);
    }
    const sourceHash = sha256(sourceFile);
    if (sourceHash !== entry.sha256) {
      throw new Error(`data/master/${slot}${ext}'s current sha256 (${sourceHash}) does not match manifest.json's recorded hash (${entry.sha256}) — refusing to proceed on a mismatched source`);
    }
    const destFile = path.join(destMaster, `${slot}${ext}`);
    fs.copyFileSync(sourceFile, destFile);
    const destHash = sha256(destFile);
    if (destHash !== sourceHash) {
      throw new Error(`Copy verification failed for ${slot}: source hash ${sourceHash}, dest hash ${destHash}`);
    }
    console.log(`✓ ${slot}${ext} copied and hash-verified (${sourceHash})`);
  }

  fs.copyFileSync(manifestPath, path.join(destMaster, "manifest.json"));
  console.log("✓ manifest.json copied");

  const sourceHistoryDir = path.join(SOURCE_MASTER_DIR, "history");
  if (fs.existsSync(sourceHistoryDir)) {
    for (const entry of fs.readdirSync(sourceHistoryDir)) {
      if (entry === ".gitkeep") continue;
      const sourceFile = path.join(sourceHistoryDir, entry);
      if (!fs.statSync(sourceFile).isFile()) continue;
      const destFile = path.join(destHistory, entry);
      fs.copyFileSync(sourceFile, destFile);
      const sourceHash = sha256(sourceFile);
      const destHash = sha256(destFile);
      if (sourceHash !== destHash) {
        throw new Error(`Copy verification failed for history/${entry}`);
      }
    }
    console.log(`✓ history/ copied and hash-verified (${fs.readdirSync(sourceHistoryDir).filter((f) => f !== ".gitkeep").length} file(s))`);
  }

  const profilePath = path.join(SOURCE_MASTER_DIR, "candidate-profile.json");
  if (fs.existsSync(profilePath)) {
    const destProfilePath = path.join(DEST_ROOT, "candidate-profile.json");
    fs.copyFileSync(profilePath, destProfilePath);
    const sourceHash = sha256(profilePath);
    const destHash = sha256(destProfilePath);
    if (sourceHash !== destHash) {
      throw new Error("Copy verification failed for candidate-profile.json");
    }
    console.log(`✓ candidate-profile.json copied and hash-verified (${sourceHash})`);
  } else {
    console.log("No candidate-profile.json found — nothing to copy (run build-candidate-profile after this migration).");
  }
}

function backfillCandidateOneIdentity() {
  const db = getDb();
  const row = db.prepare("SELECT first_name FROM candidates WHERE id = 1").get() as { first_name: string } | undefined;
  if (!row) throw new Error("Candidate #1 row is missing — schema migration must run before this script");
  if (row.first_name !== "Candidate") {
    console.log(`Candidate #1 already has a real name ("${row.first_name}") — leaving identity untouched.`);
    return;
  }
  db.prepare(
    "UPDATE candidates SET first_name = 'Sai Kishore', last_name = 'Reddy', display_name = 'Sai Kishore Reddy', updated_at = datetime('now') WHERE id = 1"
  ).run();
  console.log("✓ Candidate #1 identity set to 'Sai Kishore Reddy' (inferred from build-candidate-profile skill metadata and account email — verify/correct via the candidate selector once onboarding UI is available).");
}

function backfillCandidateJobState() {
  const db = getDb();
  const jobs = db
    .prepare(
      `SELECT dedupe_key, pipeline_status, pinned, marked_for_tailoring, tailoring_marked_at,
              pipeline_updated_at, notes, tags
       FROM jobs
       WHERE pipeline_status != 'New' OR pinned = 1 OR marked_for_tailoring = 1
          OR notes IS NOT NULL OR tags IS NOT NULL`
    )
    .all() as {
    dedupe_key: string; pipeline_status: string; pinned: number; marked_for_tailoring: number;
    tailoring_marked_at: string | null; pipeline_updated_at: string | null; notes: string | null; tags: string | null;
  }[];

  let inserted = 0;
  for (const job of jobs) {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO candidate_job_state
          (candidate_id, dedupe_key, pipeline_status, pipeline_updated_at, marked_for_tailoring,
           tailoring_marked_at, pinned, notes, tags)
         VALUES (1, @dedupeKey, @pipelineStatus, @pipelineUpdatedAt, @markedForTailoring,
                 @tailoringMarkedAt, @pinned, @notes, @tags)`
      )
      .run({
        dedupeKey: job.dedupe_key,
        pipelineStatus: job.pipeline_status,
        pipelineUpdatedAt: job.pipeline_updated_at,
        markedForTailoring: job.marked_for_tailoring,
        tailoringMarkedAt: job.tailoring_marked_at,
        pinned: job.pinned,
        notes: job.notes,
        tags: job.tags,
      });
    if (result.changes > 0) inserted++;
  }
  console.log(`✓ candidate_job_state backfilled for Candidate #1: ${inserted} row(s) inserted (of ${jobs.length} job(s) with non-default state; jobs with all-default state get no row by design).`);

  const historyRows = db
    .prepare(
      `SELECT jsh.change_type, jsh.old_value, jsh.new_value, jsh.reason, jsh.changed_at, j.dedupe_key
       FROM job_status_history jsh JOIN jobs j ON j.id = jsh.job_id
       WHERE jsh.change_type IN ('pipeline_status', 'tailoring')`
    )
    .all() as { change_type: string; old_value: string | null; new_value: string | null; reason: string | null; changed_at: string; dedupe_key: string }[];

  let historyInserted = 0;
  for (const h of historyRows) {
    db.prepare(
      `INSERT INTO candidate_job_state_history (candidate_id, dedupe_key, change_type, old_value, new_value, reason, changed_at)
       VALUES (1, @dedupeKey, @changeType, @oldValue, @newValue, @reason, @changedAt)`
    ).run({ dedupeKey: h.dedupe_key, changeType: h.change_type, oldValue: h.old_value, newValue: h.new_value, reason: h.reason, changedAt: h.changed_at });
    historyInserted++;
  }
  console.log(`✓ candidate_job_state_history backfilled for Candidate #1: ${historyInserted} row(s) from legacy job_status_history.`);
}

function main() {
  console.log(`Migrating singleton candidate data -> Candidate #1 at ${DEST_ROOT}`);
  copyMasterFiles();
  backfillCandidateOneIdentity();
  backfillCandidateJobState();
  console.log("Done. data/master/** and jobs.* legacy columns were left completely untouched.");
}

main();
