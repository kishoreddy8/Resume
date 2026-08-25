import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { backfillOrganizationDiscoveryState, runOrganizationRegistryBackfill } from "@/db/organizationRegistryCore";

const DATA_DIR = path.join(process.cwd(), "data");
// Override lets integration tests point at an isolated temp file instead of the real database —
// unset in normal app/script usage, so production behavior is unchanged.
// Exported so migrate.ts can locate the live file for its pre-migration backup step — no other
export function getDbPath(): string {
  return process.env.CAREER_OPS_DB_PATH ?? path.join(DATA_DIR, "app.db");
}
export const DB_PATH = process.env.CAREER_OPS_DB_PATH ?? path.join(DATA_DIR, "app.db");

function ensureDataDirs() {
  const currentDbPath = getDbPath();
  for (const dir of [
    DATA_DIR,
    path.join(DATA_DIR, "master", "history"),
    path.join(DATA_DIR, "generated"),
    path.join(DATA_DIR, "h1b"),
    path.dirname(currentDbPath),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

declare global {
  var __careerOpsDb: Database.Database | undefined;
}

// Columns added after the initial schema. schema.sql's CREATE TABLE IF NOT EXISTS only covers
// fresh databases — existing ones need an additive ALTER TABLE for each new column.
const JOBS_ADDITIVE_COLUMNS: { name: string; ddl: string }[] = [
  { name: "description_sections", ddl: "ALTER TABLE jobs ADD COLUMN description_sections TEXT" },
  { name: "employment_type", ddl: "ALTER TABLE jobs ADD COLUMN employment_type TEXT" },
  { name: "workplace_type", ddl: "ALTER TABLE jobs ADD COLUMN workplace_type TEXT" },
  { name: "salary_text", ddl: "ALTER TABLE jobs ADD COLUMN salary_text TEXT" },
  { name: "sponsorship_snippet", ddl: "ALTER TABLE jobs ADD COLUMN sponsorship_snippet TEXT" },
  // Job Lifecycle Management (closed/archived tracking, notes, tags) — see schema.sql for the
  // fresh-install column definitions these mirror.
  { name: "closed_at", ddl: "ALTER TABLE jobs ADD COLUMN closed_at TEXT" },
  { name: "missed_scan_count", ddl: "ALTER TABLE jobs ADD COLUMN missed_scan_count INTEGER NOT NULL DEFAULT 0" },
  { name: "is_archived", ddl: "ALTER TABLE jobs ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0" },
  { name: "archived_at", ddl: "ALTER TABLE jobs ADD COLUMN archived_at TEXT" },
  { name: "archived_reason", ddl: "ALTER TABLE jobs ADD COLUMN archived_reason TEXT" },
  { name: "notes", ddl: "ALTER TABLE jobs ADD COLUMN notes TEXT" },
  { name: "tags", ddl: "ALTER TABLE jobs ADD COLUMN tags TEXT" },
  // Age-based lifecycle policy (see src/lib/jobLifecycle.ts) — manual override, never auto-archived
  // or auto-deleted regardless of age or pipeline_status.
  { name: "pinned", ddl: "ALTER TABLE jobs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0" },
];

function runAdditiveMigrations(db: Database.Database) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const column of JOBS_ADDITIVE_COLUMNS) {
    if (!existingColumns.has(column.name)) {
      db.exec(column.ddl);
    }
  }
}

/**
 * Indexes on columns that don't exist on a fresh checkout of an existing database until the
 * additive migrations (or the pipeline_status rebuild, which drops and recreates the table) run —
 * declaring them in schema.sql would fail with "no such column" the first time db.exec(schema)
 * runs against an existing DB. Safe to call unconditionally and repeatedly (IF NOT EXISTS); called
 * at the very end of createConnection so it's correct whether or not a rebuild just happened
 * (DROP TABLE removes a table's indexes along with it).
 */
/**
 * Covering index for the job-list projection.
 *
 * WHY IT IS THIS WIDE. `jobs` has 76 columns and stores description_html / description_text /
 * description_sections at positions 8-10, averaging 18.6 KB per row. SQLite reads a record
 * sequentially, so every list column — all of which sit at position 15 or later — can only be
 * reached by walking past those blobs and their overflow pages. Measured on the real table: four
 * early columns 28ms, the same rows with thirteen columns 1,810ms. The companies join is
 * innocent (26ms with it, 28ms without); it is column position, not the join.
 *
 * WHY THE COLUMN ORDER IS WHAT IT IS. The leading columns must match the list queries' WHERE and
 * ORDER BY or SQLite will not use this as a covering index at all. Measured on a copy of the
 * production database, both list query shapes:
 *
 *   index shape                         For You        All Jobs
 *   (none)                               2,381ms        2,414ms
 *   is_archived first, no sort keys      1,961ms          — not covering
 *   posted_at, first_seen_at first          56ms  cov     588ms
 *   is_archived, posted_at, first_seen      205ms         43ms  cov      <- chosen
 *
 * The chosen order has the better worst case: both queries land far under a second, and the
 * heavier All Jobs path (16k rows to the client) gets the fully covered plan. Either way the
 * temp B-tree sort disappears, which is most of the win even when the plan is not covering.
 *
 * COST, stated because it is real: 10.2 MB on disk, and writes to jobs get more expensive —
 * 2,000 last_seen_at updates measured 48ms without it and 306ms with it, because each scan write
 * must also maintain a wide index entry. That is a background cost paid by the hourly scanner,
 * traded against ~2.2s saved on every page load. Additive only: no existing index is removed, no
 * schema or writer behaviour changes, and no data is rewritten.
 *
 * The column list must stay in step with JOB_LIST_SELECT in db/queries/jobs.ts. If a column is
 * added there and not here, SQLite silently stops covering and the query quietly returns to ~2s.
 */
function ensureJobsListCoveringIndex(db: Database.Database) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_list_covering ON jobs(
    is_archived, posted_at DESC, first_seen_at DESC,
    id, company_id, source_type, external_id, title, location, department, url,
    employment_type, workplace_type, salary_text, sponsorship_snippet,
    last_seen_at, is_active, dedupe_key,
    sponsorship_mentioned, sponsorship_polarity, h1b_combined_confidence,
    pipeline_status, pipeline_updated_at, marked_for_tailoring, tailoring_marked_at,
    closed_at, missed_scan_count, archived_at, archived_reason,
    pinned, notes, tags, created_at, updated_at,
    employment_type_normalized, workplace_type_normalized, seniority,
    salary_min, salary_max, salary_currency, salary_period,
    clearance_required, industry_domain
  )`);
}

function ensureJobsIndexes(db: Database.Database) {
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_archived ON jobs(is_archived)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_pinned ON jobs(pinned)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_active_archived_posted ON jobs(is_archived, is_active, posted_at DESC, first_seen_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_company_active ON jobs(company_id, is_active)");


  // Stage 32 — the Operations page's match-decision counts.
  //
  // getCandidateMatchDecisionCounts runs
  //   SELECT decision, COUNT(*) FROM job_match_results WHERE candidate_id=? AND status='active'
  //   GROUP BY decision
  // and idx_job_match_results_dedupe covers only candidate_id of that. SQLite therefore seeked the
  // index and then fetched every one of the candidate's ~152k rows from a 1.48 GB table just to
  // read two small columns: measured at 14-16 seconds, and it was the entire cost of /api/operations
  // (the endpoint's own response is 11 KB). Ordering the index (candidate_id, status, decision)
  // makes the aggregate answerable from the index alone, with no table access at all.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_job_match_results_candidate_status_decision ON job_match_results(candidate_id, status, decision)"
  );

  // Stage 32 — the latest-decision-per-job lookup behind the jobs list badges and the For You feed.
  //
  // listLatestDecisionsForDedupeKeys picks MAX(id) per dedupe_key and then reads three columns from
  // each winning row. idx_job_match_results_dedupe covers the grouping but not those columns, so the
  // outer half degenerated into one random rowid fetch per job into the 1.48 GB table: ~4.9 s cold
  // for a candidate's ~22.9k keys (it measured fast only when the pages happened to still be in the
  // OS cache from a previous identical request). Carrying id and the three read columns in the index
  // makes the whole statement index-only.
  // Superseded within Stage 32 by the wider covering index below, which serves both latest-decision
  // readers. Dropping it keeps one index rather than two overlapping ones on a 152k-row table.
  db.exec("DROP INDEX IF EXISTS idx_job_match_results_latest_decision");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_job_match_results_latest_decision_covering " +
      "ON job_match_results(candidate_id, dedupe_key, id DESC, decision, overall_score, " +
      "employer_evidenced_share, requirement_coverage, insufficient_jd_signal, status)"
  );
}

const COMPANIES_COLUMNS = [
  "id", "name", "source_type", "ats_board_token", "career_page_url", "is_active", "notes",
  "h1b_match_employer_name", "h1b_match_score", "h1b_signal", "h1b_lca_count",
  "last_scanned_at", "last_scan_status", "last_scan_error", "created_at", "updated_at",
].join(", ");

/**
 * The original schema had a CHECK(source_type IN (...)) enum on companies, which SQLite can't
 * ALTER away — it has to be rebuilt. New ATS providers keep getting added (see src/lib/ats/), so
 * existing databases get this one-time rebuild to drop the constraint; schema.sql already omits
 * it for fresh installs. Idempotent: only runs if the constraint is still present.
 *
 * IMPORTANT: this must NOT rename the live `companies` table as an intermediate step. SQLite's
 * ALTER TABLE RENAME auto-rewrites *other* tables' foreign key text to follow the rename — so
 * `ALTER TABLE companies RENAME TO x` silently changes jobs.company_id's declared reference from
 * `REFERENCES companies(id)` to `REFERENCES x(id)`. Dropping `x` afterward then leaves `jobs`
 * permanently referencing a table that no longer exists (found via PRAGMA foreign_key_check after
 * a first attempt at this migration corrupted jobs' FK definition, even with rows intact).
 * Building the new table under a temp name, dropping the OLD `companies`, then renaming the new
 * table INTO the `companies` name avoids this — jobs' FK text is literally never touched, since
 * the table it references by name is never itself the target of a rename.
 */
function migrateCompaniesSourceTypeCheck(db: Database.Database, schemaSql: string) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'companies'")
    .get() as { sql: string } | undefined;
  if (!row || !row.sql.includes("CHECK (source_type IN")) return;

  const bodyMatch = schemaSql.match(/CREATE TABLE IF NOT EXISTS companies \(([\s\S]*?)\n\);/);
  if (!bodyMatch) {
    throw new Error("Could not extract companies table definition from schema.sql for migration");
  }
  const tempTableSql = `CREATE TABLE companies_workday_migration_new (${bodyMatch[1]}\n)`;

  // CRITICAL: foreign_keys must be OFF for this rebuild — DROP TABLE companies while jobs.company_id
  // has ON DELETE CASCADE would otherwise cascade-delete every row in `jobs`. PRAGMA foreign_keys
  // also cannot be changed inside a transaction (SQLite silently ignores it), so it's toggled
  // outside, with try/finally to guarantee it's restored even if the rebuild fails partway.
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(tempTableSql);
      db.exec(
        `INSERT INTO companies_workday_migration_new (${COMPANIES_COLUMNS}) SELECT ${COMPANIES_COLUMNS} FROM companies`
      );
      db.exec("DROP TABLE companies");
      db.exec("ALTER TABLE companies_workday_migration_new RENAME TO companies");
      // Indexes don't carry over from the dropped table — schema.sql's CREATE INDEX IF NOT EXISTS
      // statements now actually run (companies exists again but has none yet) instead of no-op'ing.
      db.exec(schemaSql);
    })();
    const jobsViolations = db.pragma("foreign_key_check(jobs)") as unknown[];
    if (jobsViolations.length > 0) {
      throw new Error(`Post-migration integrity check failed: ${JSON.stringify(jobsViolations)}`);
    }
    const jobsFkTarget = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
      .get() as { sql: string };
    if (!jobsFkTarget.sql.includes('REFERENCES "companies"') && !jobsFkTarget.sql.includes("REFERENCES companies")) {
      throw new Error("Post-migration check failed: jobs.company_id no longer references companies");
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

// Full current jobs column list, in schema.sql's declared order. Used by migrateJobsPipelineStatusCheck
// to rebuild the table explicitly (never SELECT * across a rebuild — column order/count drifting
// between the old and new table shape would silently misalign data).
const JOBS_COLUMNS = [
  "id", "company_id", "source_type", "external_id", "title", "location", "department", "url",
  "description_html", "description_text", "description_sections", "employment_type",
  "workplace_type", "salary_text", "sponsorship_snippet", "posted_at", "first_seen_at",
  "last_seen_at", "is_active", "dedupe_key", "sponsorship_mentioned", "sponsorship_polarity",
  "h1b_combined_signal", "pipeline_status", "pipeline_updated_at", "marked_for_tailoring",
  "tailoring_marked_at", "closed_at", "missed_scan_count", "is_archived", "archived_at",
  "archived_reason", "pinned", "notes", "tags", "raw_json", "created_at", "updated_at",
];

/**
 * jobs.pipeline_status originally had a CHECK(... IN ('New','Interested','Applied','Interview',
 * 'Rejected','Offer')) — the age-based lifecycle policy renames two of those (Interview ->
 * Interviewing, Rejected -> Employer Rejected) and, like companies.source_type before it, drops the
 * CHECK entirely going forward (schema.sql's CREATE TABLE IF NOT EXISTS already omits it for fresh
 * installs). Idempotent: only runs if the old CHECK is still present in the live schema.
 *
 * Must run AFTER runAdditiveMigrations — by the time this executes, the live `jobs` table already
 * has every column in JOBS_COLUMNS (pinned included), so the rebuild only needs to transform one
 * column's values, not backfill missing ones.
 *
 * Same danger as migrateCompaniesSourceTypeCheck, mirrored the same way: `jobs` is a table other
 * tables reference by name (job_status_history.job_id REFERENCES jobs(id) ON DELETE CASCADE), so
 * this must never rename the live `jobs` table itself mid-migration — that would silently rewrite
 * job_status_history's stored FK text to point at the temporary name. Build the new table under a
 * temp name, DROP the OLD `jobs`, then RENAME the new table INTO `jobs` — the name other tables'
 * FK text refers to is never itself renamed, so it's never rewritten.
 */
function migrateJobsPipelineStatusCheck(db: Database.Database, schemaSql: string) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
    .get() as { sql: string } | undefined;
  if (!row || !row.sql.includes("CHECK (pipeline_status IN")) return;

  const bodyMatch = schemaSql.match(/CREATE TABLE IF NOT EXISTS jobs \(([\s\S]*?)\n\);/);
  if (!bodyMatch) {
    throw new Error("Could not extract jobs table definition from schema.sql for migration");
  }
  const tempTableSql = `CREATE TABLE jobs_lifecycle_v2_migration_new (${bodyMatch[1]}\n)`;

  const selectList = JOBS_COLUMNS.map((col) =>
    col === "pipeline_status"
      ? "CASE pipeline_status WHEN 'Interview' THEN 'Interviewing' WHEN 'Rejected' THEN 'Employer Rejected' ELSE pipeline_status END"
      : col
  ).join(", ");
  const insertList = JOBS_COLUMNS.join(", ");

  // CRITICAL: foreign_keys must be OFF for this rebuild — DROP TABLE jobs while
  // job_status_history.job_id has ON DELETE CASCADE would otherwise cascade-delete every history
  // row. PRAGMA foreign_keys also cannot be changed inside a transaction (SQLite silently ignores
  // it), so it's toggled outside, with try/finally to guarantee it's restored even on failure.
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(tempTableSql);
      db.exec(
        `INSERT INTO jobs_lifecycle_v2_migration_new (${insertList}) SELECT ${selectList} FROM jobs`
      );
      db.exec("DROP TABLE jobs");
      db.exec("ALTER TABLE jobs_lifecycle_v2_migration_new RENAME TO jobs");
      // Indexes/other tables don't carry over from the dropped table — re-running the full schema
      // recreates jobs' own indexes and is a no-op (IF NOT EXISTS) for everything else.
      db.exec(schemaSql);
    })();
    const historyViolations = db.pragma("foreign_key_check(job_status_history)") as unknown[];
    if (historyViolations.length > 0) {
      throw new Error(`Post-migration integrity check failed: ${JSON.stringify(historyViolations)}`);
    }
    const jobsViolations = db.pragma("foreign_key_check(jobs)") as unknown[];
    if (jobsViolations.length > 0) {
      throw new Error(`Post-migration integrity check failed: ${JSON.stringify(jobsViolations)}`);
    }
    const historyFkTarget = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'job_status_history'")
      .get() as { sql: string } | undefined;
    if (
      historyFkTarget &&
      !historyFkTarget.sql.includes('REFERENCES "jobs"') &&
      !historyFkTarget.sql.includes("REFERENCES jobs")
    ) {
      throw new Error("Post-migration check failed: job_status_history.job_id no longer references jobs");
    }
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE pipeline_status IN ('Interview', 'Rejected')")
      .get() as { n: number };
    if (remaining.n > 0) {
      throw new Error(`Post-migration check failed: ${remaining.n} row(s) still have an old-style pipeline_status`);
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

// --- H1B Sponsor Intelligence migrations ---------------------------------------------------

// New, purely-additive company columns (see schema.sql for what each means).
const COMPANIES_H1B_ADDITIVE_COLUMNS: { name: string; ddl: string }[] = [
  { name: "h1b_match_normalized", ddl: "ALTER TABLE companies ADD COLUMN h1b_match_normalized TEXT" },
  { name: "h1b_match_tier", ddl: "ALTER TABLE companies ADD COLUMN h1b_match_tier TEXT" },
  { name: "h1b_latest_fiscal_year", ddl: "ALTER TABLE companies ADD COLUMN h1b_latest_fiscal_year INTEGER" },
  { name: "h1b_confidence_evidence", ddl: "ALTER TABLE companies ADD COLUMN h1b_confidence_evidence TEXT" },
  { name: "h1b_updated_at", ddl: "ALTER TABLE companies ADD COLUMN h1b_updated_at TEXT" },
];

function runAdditiveCompaniesMigrations(db: Database.Database) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(companies)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const column of COMPANIES_H1B_ADDITIVE_COLUMNS) {
    if (!existingColumns.has(column.name)) {
      db.exec(column.ddl);
    }
  }
}

// companies' full column set as it exists on a live DB just before this rebuild (h1b_signal, the
// old name) vs. just after (h1b_confidence). Built once, not shared with migrateCompaniesSourceTypeCheck's
// own COMPANIES_COLUMNS above — that function's guard targets an already-migrated-away CHECK on any
// database this project has touched, and its list must keep reflecting the shape a database looked
// like at THAT migration's moment in history, not this one.
const COMPANIES_H1B_COLUMNS_OLD = [
  "id", "name", "source_type", "ats_board_token", "career_page_url", "is_active", "notes",
  "h1b_match_employer_name", "h1b_match_normalized", "h1b_match_tier", "h1b_match_score",
  "h1b_signal", "h1b_lca_count", "h1b_latest_fiscal_year", "h1b_confidence_evidence",
  "h1b_updated_at", "last_scanned_at", "last_scan_status", "last_scan_error", "created_at", "updated_at",
];
const COMPANIES_H1B_COLUMNS_NEW = COMPANIES_H1B_COLUMNS_OLD.map((c) =>
  c === "h1b_signal" ? "h1b_confidence" : c
);

/**
 * companies.h1b_signal had a CHECK(... IN ('High','Medium','Low','Unknown')) — H1B Sponsor
 * Intelligence renames it to h1b_confidence and adds 'Very High' to the vocabulary (company-level
 * confidence never includes 'Not Sponsoring' — DOL data is purely positive evidence of sponsorship,
 * it never asserts a company won't sponsor; that's job-level-only, from JD language). Same
 * precedent as source_type/pipeline_status above: the CHECK is dropped rather than rebuilt with a
 * longer allowed-list. Idempotent: only runs if the old CHECK is still present.
 *
 * Must run after runAdditiveCompaniesMigrations, so the live table already has every new H1B
 * column before the rebuild copies it (only h1b_signal itself needs a name change, not a backfill).
 *
 * Same danger/same fix as migrateCompaniesSourceTypeCheck: companies is referenced by
 * jobs.company_id AND suppressed_jobs.company_id (added since), so this must never rename the live
 * `companies` table itself mid-migration — build the replacement under a temp name, DROP the OLD
 * `companies`, RENAME the new table INTO `companies`, so neither referencing table's FK text is
 * ever touched.
 */
function migrateCompaniesH1bConfidenceCheck(db: Database.Database, schemaSql: string) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'companies'")
    .get() as { sql: string } | undefined;
  if (!row || !row.sql.includes("CHECK (h1b_signal IN")) return;

  const bodyMatch = schemaSql.match(/CREATE TABLE IF NOT EXISTS companies \(([\s\S]*?)\n\);/);
  if (!bodyMatch) {
    throw new Error("Could not extract companies table definition from schema.sql for migration");
  }
  const tempTableSql = `CREATE TABLE companies_h1b_intel_migration_new (${bodyMatch[1]}\n)`;

  const selectList = COMPANIES_H1B_COLUMNS_OLD.join(", ");
  const insertList = COMPANIES_H1B_COLUMNS_NEW.join(", ");

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(tempTableSql);
      db.exec(
        `INSERT INTO companies_h1b_intel_migration_new (${insertList}) SELECT ${selectList} FROM companies`
      );
      db.exec("DROP TABLE companies");
      db.exec("ALTER TABLE companies_h1b_intel_migration_new RENAME TO companies");
      db.exec(schemaSql);
    })();
    for (const child of ["jobs", "suppressed_jobs"]) {
      const violations = db.pragma(`foreign_key_check(${child})`) as unknown[];
      if (violations.length > 0) {
        throw new Error(`Post-migration integrity check failed on ${child}: ${JSON.stringify(violations)}`);
      }
      const fkTarget = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(child) as { sql: string } | undefined;
      if (fkTarget && !fkTarget.sql.includes('REFERENCES "companies"') && !fkTarget.sql.includes("REFERENCES companies")) {
        throw new Error(`Post-migration check failed: ${child}.company_id no longer references companies`);
      }
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

// jobs' full column set just before (h1b_combined_signal) vs. just after (h1b_combined_confidence)
// this rebuild — a fresh, independent list from JOBS_COLUMNS above for the same reason
// COMPANIES_H1B_COLUMNS_OLD is independent of migrateCompaniesSourceTypeCheck's list.
const JOBS_H1B_COLUMNS_OLD = [
  "id", "company_id", "source_type", "external_id", "title", "location", "department", "url",
  "description_html", "description_text", "description_sections", "employment_type",
  "workplace_type", "salary_text", "sponsorship_snippet", "posted_at", "first_seen_at",
  "last_seen_at", "is_active", "dedupe_key", "sponsorship_mentioned", "sponsorship_polarity",
  "h1b_combined_signal", "pipeline_status", "pipeline_updated_at", "marked_for_tailoring",
  "tailoring_marked_at", "closed_at", "missed_scan_count", "is_archived", "archived_at",
  "archived_reason", "pinned", "notes", "tags", "raw_json", "created_at", "updated_at",
];
const JOBS_H1B_COLUMNS_NEW = JOBS_H1B_COLUMNS_OLD.map((c) =>
  c === "h1b_combined_signal" ? "h1b_combined_confidence" : c
);

/**
 * jobs.h1b_combined_signal had a CHECK(... IN ('High','Medium','Low','Unknown','Likely','Unlikely'))
 * — H1B Sponsor Intelligence renames it to h1b_combined_confidence with the vocabulary Very High/
 * High/Medium/Low/Unknown/Not Sponsoring (Likely -> Very High, Unlikely -> Not Sponsoring is the
 * closest-meaning remap: both were the JD-override tier, now expressed on the same unified scale
 * used everywhere else). Idempotent: only runs if the old CHECK is still present.
 *
 * Same danger/same fix as migrateJobsPipelineStatusCheck: jobs is referenced by
 * job_status_history.job_id, so this must never rename the live `jobs` table itself mid-migration.
 */
function migrateJobsH1bConfidenceCheck(db: Database.Database, schemaSql: string) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
    .get() as { sql: string } | undefined;
  if (!row || !row.sql.includes("CHECK (h1b_combined_signal IN")) return;

  const bodyMatch = schemaSql.match(/CREATE TABLE IF NOT EXISTS jobs \(([\s\S]*?)\n\);/);
  if (!bodyMatch) {
    throw new Error("Could not extract jobs table definition from schema.sql for migration");
  }
  const tempTableSql = `CREATE TABLE jobs_h1b_intel_migration_new (${bodyMatch[1]}\n)`;

  const selectList = JOBS_H1B_COLUMNS_OLD.map((col) =>
    col === "h1b_combined_signal"
      ? "CASE h1b_combined_signal WHEN 'Likely' THEN 'Very High' WHEN 'Unlikely' THEN 'Not Sponsoring' ELSE h1b_combined_signal END"
      : col
  ).join(", ");
  const insertList = JOBS_H1B_COLUMNS_NEW.join(", ");

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(tempTableSql);
      db.exec(
        `INSERT INTO jobs_h1b_intel_migration_new (${insertList}) SELECT ${selectList} FROM jobs`
      );
      db.exec("DROP TABLE jobs");
      db.exec("ALTER TABLE jobs_h1b_intel_migration_new RENAME TO jobs");
      db.exec(schemaSql);
    })();
    const historyViolations = db.pragma("foreign_key_check(job_status_history)") as unknown[];
    if (historyViolations.length > 0) {
      throw new Error(`Post-migration integrity check failed: ${JSON.stringify(historyViolations)}`);
    }
    const jobsViolations = db.pragma("foreign_key_check(jobs)") as unknown[];
    if (jobsViolations.length > 0) {
      throw new Error(`Post-migration integrity check failed: ${JSON.stringify(jobsViolations)}`);
    }
    const historyFkTarget = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'job_status_history'")
      .get() as { sql: string } | undefined;
    if (
      historyFkTarget &&
      !historyFkTarget.sql.includes('REFERENCES "jobs"') &&
      !historyFkTarget.sql.includes("REFERENCES jobs")
    ) {
      throw new Error("Post-migration check failed: job_status_history.job_id no longer references jobs");
    }
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE h1b_combined_confidence IN ('Likely', 'Unlikely')")
      .get() as { n: number };
    if (remaining.n > 0) {
      throw new Error(`Post-migration check failed: ${remaining.n} row(s) still have an old-style h1b_combined_confidence`);
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

// --- Structured Job Intelligence ------------------------------------------------------------

// New, purely-additive job columns (see src/lib/jobIntel/ for what populates each). All nullable,
// no CHECK constraints — nothing here needs a table rebuild, only ALTER TABLE ADD COLUMN.
const JOBS_STRUCTURED_INTEL_ADDITIVE_COLUMNS: { name: string; ddl: string }[] = [
  { name: "seniority", ddl: "ALTER TABLE jobs ADD COLUMN seniority TEXT" },
  { name: "seniority_evidence", ddl: "ALTER TABLE jobs ADD COLUMN seniority_evidence TEXT" },
  { name: "employment_type_normalized", ddl: "ALTER TABLE jobs ADD COLUMN employment_type_normalized TEXT" },
  { name: "workplace_type_normalized", ddl: "ALTER TABLE jobs ADD COLUMN workplace_type_normalized TEXT" },
  { name: "workplace_office_days", ddl: "ALTER TABLE jobs ADD COLUMN workplace_office_days TEXT" },
  { name: "location_city", ddl: "ALTER TABLE jobs ADD COLUMN location_city TEXT" },
  { name: "location_state", ddl: "ALTER TABLE jobs ADD COLUMN location_state TEXT" },
  { name: "location_country", ddl: "ALTER TABLE jobs ADD COLUMN location_country TEXT" },
  { name: "location_list_json", ddl: "ALTER TABLE jobs ADD COLUMN location_list_json TEXT" },
  { name: "location_relocation", ddl: "ALTER TABLE jobs ADD COLUMN location_relocation TEXT" },
  { name: "location_travel_pct", ddl: "ALTER TABLE jobs ADD COLUMN location_travel_pct TEXT" },
  { name: "experience_min_years", ddl: "ALTER TABLE jobs ADD COLUMN experience_min_years REAL" },
  { name: "experience_preferred_years", ddl: "ALTER TABLE jobs ADD COLUMN experience_preferred_years REAL" },
  { name: "experience_by_tech_json", ddl: "ALTER TABLE jobs ADD COLUMN experience_by_tech_json TEXT" },
  { name: "experience_evidence", ddl: "ALTER TABLE jobs ADD COLUMN experience_evidence TEXT" },
  { name: "education_level", ddl: "ALTER TABLE jobs ADD COLUMN education_level TEXT" },
  { name: "education_field", ddl: "ALTER TABLE jobs ADD COLUMN education_field TEXT" },
  { name: "education_requirement", ddl: "ALTER TABLE jobs ADD COLUMN education_requirement TEXT" },
  {
    name: "education_equivalent_experience_allowed",
    ddl: "ALTER TABLE jobs ADD COLUMN education_equivalent_experience_allowed INTEGER",
  },
  { name: "education_evidence", ddl: "ALTER TABLE jobs ADD COLUMN education_evidence TEXT" },
  { name: "salary_min", ddl: "ALTER TABLE jobs ADD COLUMN salary_min REAL" },
  { name: "salary_max", ddl: "ALTER TABLE jobs ADD COLUMN salary_max REAL" },
  { name: "salary_currency", ddl: "ALTER TABLE jobs ADD COLUMN salary_currency TEXT" },
  { name: "salary_period", ddl: "ALTER TABLE jobs ADD COLUMN salary_period TEXT" },
  { name: "salary_bonus", ddl: "ALTER TABLE jobs ADD COLUMN salary_bonus TEXT" },
  { name: "salary_commission", ddl: "ALTER TABLE jobs ADD COLUMN salary_commission TEXT" },
  { name: "salary_equity", ddl: "ALTER TABLE jobs ADD COLUMN salary_equity TEXT" },
  { name: "clearance_required", ddl: "ALTER TABLE jobs ADD COLUMN clearance_required TEXT" },
  { name: "clearance_level", ddl: "ALTER TABLE jobs ADD COLUMN clearance_level TEXT" },
  { name: "citizenship_required", ddl: "ALTER TABLE jobs ADD COLUMN citizenship_required TEXT" },
  { name: "work_authorization_required", ddl: "ALTER TABLE jobs ADD COLUMN work_authorization_required TEXT" },
  { name: "clearance_evidence", ddl: "ALTER TABLE jobs ADD COLUMN clearance_evidence TEXT" },
  { name: "industry_domain", ddl: "ALTER TABLE jobs ADD COLUMN industry_domain TEXT" },
  { name: "industry_domain_evidence", ddl: "ALTER TABLE jobs ADD COLUMN industry_domain_evidence TEXT" },
  { name: "job_quality_flags", ddl: "ALTER TABLE jobs ADD COLUMN job_quality_flags TEXT" },
  { name: "structured_extraction_version", ddl: "ALTER TABLE jobs ADD COLUMN structured_extraction_version INTEGER" },
  { name: "structured_extracted_at", ddl: "ALTER TABLE jobs ADD COLUMN structured_extracted_at TEXT" },
];

function runStructuredIntelMigrations(db: Database.Database) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const column of JOBS_STRUCTURED_INTEL_ADDITIVE_COLUMNS) {
    if (!existingColumns.has(column.name)) {
      db.exec(column.ddl);
    }
  }
}

// Same reasoning as ensureJobsIndexes above: these columns don't exist on an existing database
// until runStructuredIntelMigrations() has just added them, so schema.sql's CREATE TABLE IF NOT
// EXISTS (which runs before any migration) can't declare indexes on them. Safe to call
// unconditionally and repeatedly.
function ensureStructuredIntelIndexes(db: Database.Database) {
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_seniority ON jobs(seniority)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_employment_type_normalized ON jobs(employment_type_normalized)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_workplace_type_normalized ON jobs(workplace_type_normalized)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_clearance_required ON jobs(clearance_required)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_salary_min ON jobs(salary_min)");
}

// --- Scanner Reliability & Observability ----------------------------------------------------

// New, purely-additive company columns (see schema.sql's scan_runs table doc comment and
// src/db/queries/companies.ts's recordScanSuccess/recordScanPartial/recordScanFailure for what
// writes each). All nullable/defaulted, no CHECK constraints — plain ALTER TABLE ADD COLUMN.
const COMPANIES_SCAN_HEALTH_ADDITIVE_COLUMNS: { name: string; ddl: string }[] = [
  { name: "last_successful_scan_at", ddl: "ALTER TABLE companies ADD COLUMN last_successful_scan_at TEXT" },
  { name: "last_failed_scan_at", ddl: "ALTER TABLE companies ADD COLUMN last_failed_scan_at TEXT" },
  {
    name: "consecutive_failures",
    ddl: "ALTER TABLE companies ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0",
  },
  { name: "last_error_category", ddl: "ALTER TABLE companies ADD COLUMN last_error_category TEXT" },
  { name: "last_error_message", ddl: "ALTER TABLE companies ADD COLUMN last_error_message TEXT" },
  {
    name: "connector_health",
    ddl: "ALTER TABLE companies ADD COLUMN connector_health TEXT NOT NULL DEFAULT 'unknown'",
  },
];

function runScanHealthMigrations(db: Database.Database) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(companies)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const column of COMPANIES_SCAN_HEALTH_ADDITIVE_COLUMNS) {
    if (!existingColumns.has(column.name)) {
      db.exec(column.ddl);
    }
  }
}

// Connector Reliability Control Plane V1 — the ONE new persisted signal this feature needs beyond
// what scan health/discovery already write (see src/lib/ats/reliability/'s own doc comments for why
// every other piece of state is derived, never migrated). A rediscovery attempt (Discovery V2
// against a currently-failing company) is expensive (real browser render — see discoveryConfig.ts's
// MAX_V2_TOTAL_BUDGET_MS) and, unlike a normal scan, does not always leave a durable trace: a
// NO_SOURCE_FOUND/GENERIC_ONLY outcome creates no ats_source_proposals row at all, so without this
// timestamp the reliability controller would have no way to tell "we already tried and found
// nothing five minutes ago" from "never tried" and would re-attempt on every tick — exactly the
// thrashing/repair-loop risk the mission's Phase 6/8 explicitly warn against.
const COMPANIES_RELIABILITY_ADDITIVE_COLUMNS: { name: string; ddl: string }[] = [
  { name: "last_rediscovery_attempted_at", ddl: "ALTER TABLE companies ADD COLUMN last_rediscovery_attempted_at TEXT" },
];

function runReliabilityMigrations(db: Database.Database) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(companies)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const column of COMPANIES_RELIABILITY_ADDITIVE_COLUMNS) {
    if (!existingColumns.has(column.name)) {
      db.exec(column.ddl);
    }
  }
}

// ATS Health Semantics V2 — two new scan_runs columns, purely additive, mirroring
// description_failures' own existing pattern exactly (same INTEGER NOT NULL DEFAULT 0 shape). Both
// are per-run observability data src/lib/scan.ts already computes locally but previously only
// folded into free-text error_message; recorded here as clean, queryable numbers so
// src/db/queries/atsCoverage.ts can derive data-quality warnings from the latest run per company
// without parsing text or touching companies.connector_health's own, unchanged, operational meaning.
// Old rows default to 0 (not retroactively decomposed from their historical text) — this only
// changes what NEW scan runs record going forward, matching the same non-backfill philosophy every
// other additive column in this file already follows.
const SCAN_RUNS_WARNING_ADDITIVE_COLUMNS: { name: string; ddl: string }[] = [
  {
    name: "unknown_location_count",
    ddl: "ALTER TABLE scan_runs ADD COLUMN unknown_location_count INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "is_sample_scan",
    ddl: "ALTER TABLE scan_runs ADD COLUMN is_sample_scan INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "jobs_non_us_rejected",
    ddl: "ALTER TABLE scan_runs ADD COLUMN jobs_non_us_rejected INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "jobs_stale_rejected",
    ddl: "ALTER TABLE scan_runs ADD COLUMN jobs_stale_rejected INTEGER NOT NULL DEFAULT 0",
  },
];

// Exported (unlike this file's other migration functions, except runCompaniesDiscoveryMigrations)
// specifically so the additive-upgrade path can be regression-tested directly against a hand-built
// "old shape" scan_runs table — these are the first scan_runs columns that live only in this
// migration function rather than schema.sql's CREATE TABLE, so unlike every other scan_runs column
// (including description_failures, its closest sibling), this exact path had no prior test coverage.
// --- Stage 26B: candidate contact details ------------------------------------------------------
//
// The renderer requires a real email (tools/tailoring-engine/generate.ts validates resume.email), and
// a resume needs a phone/location a recruiter can actually use. CareerOps stored none of these
// anywhere — the only contact values that ever reached a rendered document were the fabricated
// "candidate@example.com" / "555-0100" the pre-Stage-26 placeholder seed injected, which is why
// removing that fabrication made DOCX rendering start failing with "resume.email is required".
//
// Added to candidate_settings because that IS the candidate-specific configuration row. Nullable with
// no default, following this file's own non-backfill philosophy: an unconfigured candidate reads as
// "not provided" and blocks tailoring, and is never silently given a plausible-looking value.
const CANDIDATE_CONTACT_ADDITIVE_COLUMNS: { name: string; ddl: string }[] = [
  { name: "contact_email", ddl: "ALTER TABLE candidate_settings ADD COLUMN contact_email TEXT" },
  { name: "contact_phone", ddl: "ALTER TABLE candidate_settings ADD COLUMN contact_phone TEXT" },
  { name: "contact_location", ddl: "ALTER TABLE candidate_settings ADD COLUMN contact_location TEXT" },
  { name: "contact_linkedin", ddl: "ALTER TABLE candidate_settings ADD COLUMN contact_linkedin TEXT" },
  { name: "contact_github", ddl: "ALTER TABLE candidate_settings ADD COLUMN contact_github TEXT" },
];

export function runCandidateContactMigrations(db: Database.Database) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(candidate_settings)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const column of CANDIDATE_CONTACT_ADDITIVE_COLUMNS) {
    if (!existingColumns.has(column.name)) {
      db.exec(column.ddl);
    }
  }
}

export function runScanRunsWarningMigrations(db: Database.Database) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(scan_runs)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const column of SCAN_RUNS_WARNING_ADDITIVE_COLUMNS) {
    if (!existingColumns.has(column.name)) {
      db.exec(column.ddl);
    }
  }
}

// --- AI Infrastructure: entity_key identity-safety fix ---------------------------------------

/**
 * Adds ai_enrichments.entity_key (see schema.sql's IDENTITY SAFETY comment on that table) to a
 * database that already has the table from before this fix, and rebuilds idx_ai_enrichments_key /
 * idx_ai_enrichments_entity to filter on entity_key instead of the reuse-prone entity_id.
 *
 * A plain ALTER TABLE ADD COLUMN can't declare NOT NULL without a default, so the column is added
 * nullable here; src/db/queries/aiEnrichments.ts never inserts a null value regardless, so this
 * never weakens what the application actually writes.
 *
 * Both pre-existing index NAMES are reused by schema.sql's current (entity_key-based) definitions,
 * so schema.sql's own CREATE INDEX IF NOT EXISTS — already run once at the top of createConnection,
 * before this function executes — silently no-ops against the OLD (entity_id-based) index bodies
 * still sitting under those names on an existing database; they must be dropped explicitly before
 * schema.sql's current definitions can ever actually take effect. Re-running the (idempotent) full
 * schema afterward recreates both under their current bodies and also picks up
 * idx_ai_enrichments_entity_id_debug, a brand-new index name that needed no drop.
 *
 * Safe regardless of row count: ai_enrichments is new, additive infrastructure with no feature
 * writing to it yet, and this only ever adds a nullable column and rebuilds indexes — it never
 * drops or transforms a column that could hold real data.
 */
function migrateAiEnrichmentsEntityKey(db: Database.Database, schemaSql: string) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(ai_enrichments)").all() as { name: string }[]).map((c) => c.name)
  );
  if (existingColumns.has("entity_key")) return;

  db.exec("ALTER TABLE ai_enrichments ADD COLUMN entity_key TEXT");
  db.exec("DROP INDEX IF EXISTS idx_ai_enrichments_key");
  db.exec("DROP INDEX IF EXISTS idx_ai_enrichments_entity");
  db.exec(schemaSql);
}

// --- Phase 2.5: multi-candidate support ------------------------------------------------------

const COMPANIES_DISCOVERY_ADDITIVE_COLUMNS: { name: string; ddl: string }[] = [
  { name: "resolution_status", ddl: "ALTER TABLE companies ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'UNRESOLVED'" },
  { name: "discovered_jobs_url", ddl: "ALTER TABLE companies ADD COLUMN discovered_jobs_url TEXT" },
  { name: "discovery_attempted_at", ddl: "ALTER TABLE companies ADD COLUMN discovery_attempted_at TEXT" },
  { name: "discovery_reason", ddl: "ALTER TABLE companies ADD COLUMN discovery_reason TEXT" },
  { name: "suspected_ats", ddl: "ALTER TABLE companies ADD COLUMN suspected_ats TEXT" },
];

// Exported (unlike this file's other migration functions) specifically so the resolution_status
// backfill predicate can be regression-tested directly against a hand-built "old shape" database —
// going through getDb()/DB_PATH for this scenario doesn't work in-process, since DB_PATH is a
// module-level constant captured once at import time, not re-read from the env per call.
export function runCompaniesDiscoveryMigrations(db: Database.Database) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(companies)").all() as { name: string }[]).map((c) => c.name)
  );
  const resolutionStatusIsNew = !existingColumns.has("resolution_status");
  for (const column of COMPANIES_DISCOVERY_ADDITIVE_COLUMNS) {
    if (!existingColumns.has(column.name)) {
      db.exec(column.ddl);
    }
  }
  // One-time backfill, only at the moment resolution_status is introduced: a company that already
  // has a working ats_board_token or career_page_url is demonstrably an already-resolved source (it
  // was successfully added and is scanning today) — defaulting it to 'UNRESOLVED' like a brand-new,
  // never-attempted company would misrepresent working sources. This does not run again on
  // subsequent connections (resolutionStatusIsNew is only true the first time), so it never
  // overwrites a resolution_status the discovery pipeline later sets deliberately.
  if (resolutionStatusIsNew) {
    db.exec(
      `UPDATE companies SET resolution_status = 'VERIFIED'
       WHERE (ats_board_token IS NOT NULL OR career_page_url IS NOT NULL)`
    );
  }
  // Same reasoning as ensureJobsIndexes/ensureStructuredIntelIndexes: resolution_status doesn't
  // exist on an existing database until the ALTER TABLEs above run, so schema.sql can't declare
  // this index unconditionally. Safe to call unconditionally and repeatedly (IF NOT EXISTS).
  db.exec("CREATE INDEX IF NOT EXISTS idx_companies_resolution_status ON companies(resolution_status)");
}

/**
 * Adds candidate_id to job_match_results/match_runs, backfilled to Candidate #1 (id 1) via a
 * constant DEFAULT — every row that existed before multi-candidate support becomes Candidate #1's
 * data, exactly as the approved migration plan requires. Then rebuilds job_match_results' unique/
 * lookup indexes to include candidate_id. Mirrors migrateAiEnrichmentsEntityKey's drop-index-then-
 * re-exec-schema pattern exactly — a table rebuild is NOT needed here, since this only adds a column
 * and changes an index, never a column type or a CHECK constraint.
 */
/**
 * Profile access control: per-candidate PIN, lockout state, and the owner flag.
 *
 * Additive only — new nullable columns on an existing table, no rewrite, no index change. A
 * candidate with pin_hash NULL is UNPROTECTED BY DESIGN: gating a profile that has never set a PIN
 * would have locked every existing profile out on first deploy with no way back in. Protection is
 * opt-in per profile, and the UI has to say so plainly rather than implying everything is guarded.
 *
 * is_owner marks the single account allowed to authorise destructive operations (deleting another
 * profile). It is seeded onto candidate 1 — the account that created this database — and never
 * onto anyone else automatically, because "first user is the owner" is the only rule that cannot be
 * gamed by creating another account.
 */
function runCandidatePinMigrations(db: Database.Database) {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(candidates)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!cols.has("pin_hash")) db.exec("ALTER TABLE candidates ADD COLUMN pin_hash TEXT");
  if (!cols.has("pin_salt")) db.exec("ALTER TABLE candidates ADD COLUMN pin_salt TEXT");
  if (!cols.has("pin_set_at")) db.exec("ALTER TABLE candidates ADD COLUMN pin_set_at TEXT");
  // Lockout state. This — not scrypt — is what makes a 4-digit PIN survive an online attack.
  if (!cols.has("pin_failed_attempts"))
    db.exec("ALTER TABLE candidates ADD COLUMN pin_failed_attempts INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("pin_locked_until")) db.exec("ALTER TABLE candidates ADD COLUMN pin_locked_until TEXT");
  if (!cols.has("is_owner")) db.exec("ALTER TABLE candidates ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0");

  // Seed exactly one owner: the lowest-numbered surviving candidate, which is candidate 1 on every
  // existing database. Guarded so it can never promote a second account on a later startup.
  const ownerCount = (db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE is_owner = 1").get() as { n: number }).n;
  if (ownerCount === 0) {
    db.exec("UPDATE candidates SET is_owner = 1 WHERE id = (SELECT MIN(id) FROM candidates)");
  }
}

function runCandidateScopingMigrations(db: Database.Database, schemaSql: string) {
  const jobMatchResultsColumns = new Set(
    (db.prepare("PRAGMA table_info(job_match_results)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!jobMatchResultsColumns.has("candidate_id")) {
    db.exec("ALTER TABLE job_match_results ADD COLUMN candidate_id INTEGER NOT NULL DEFAULT 1");
    db.exec("DROP INDEX IF EXISTS idx_job_match_results_key");
    db.exec("DROP INDEX IF EXISTS idx_job_match_results_dedupe");
    db.exec(schemaSql);
  }

  const matchRunsColumns = new Set(
    (db.prepare("PRAGMA table_info(match_runs)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!matchRunsColumns.has("candidate_id")) {
    db.exec("ALTER TABLE match_runs ADD COLUMN candidate_id INTEGER NOT NULL DEFAULT 1");
  }
}

/**
 * Candidate #1 is the migrated identity of this project's original single-candidate user — seeded
 * once, idempotent (never re-run if a candidates row already exists), never overwritten. Actual
 * name/master-file backfill happens in the Stage 5 migration script, not here; this only guarantees
 * id=1 exists so the candidate_id DEFAULT 1 backfill above always points at a real row.
 */
// --- H1B Employer Source Discovery + ATS Hardening -------------------------------------------

// New, purely-additive companies columns for domain-identity resolution (see
// src/lib/companyIdentity/). Deliberately independent of resolution_status/discovered_jobs_url/
// discovery_attempted_at/discovery_reason/suspected_ats above — domain_identity_status answers
// "did we identify the real public company/domain," resolution_status answers "did we find its
// careers/ATS source," and the two must never overwrite or gate each other. All nullable, no
// backfill needed (a company that already has a career_page_url/ats_board_token today was added
// via manual URL entry, which says nothing about whether its DOMAIN identity was ever verified
// through this new pipeline — defaulting to 'UNRESOLVED' for domain_identity_status is honest,
// unlike the one-time resolution_status backfill in runCompaniesDiscoveryMigrations above, which
// had real evidence — "it's scanning today" — to justify a non-default backfill).
const COMPANIES_DOMAIN_IDENTITY_ADDITIVE_COLUMNS: { name: string; ddl: string }[] = [
  { name: "verified_domain", ddl: "ALTER TABLE companies ADD COLUMN verified_domain TEXT" },
  {
    name: "domain_identity_status",
    ddl: "ALTER TABLE companies ADD COLUMN domain_identity_status TEXT NOT NULL DEFAULT 'UNRESOLVED'",
  },
  { name: "last_successful_discovery_at", ddl: "ALTER TABLE companies ADD COLUMN last_successful_discovery_at TEXT" },
];

function runCompaniesDomainIdentityMigrations(db: Database.Database) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(companies)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const column of COMPANIES_DOMAIN_IDENTITY_ADDITIVE_COLUMNS) {
    if (!existingColumns.has(column.name)) {
      db.exec(column.ddl);
    }
  }
  // Same reasoning as idx_companies_resolution_status above: domain_identity_status doesn't exist
  // on an existing database until the ALTER TABLE above runs, so schema.sql can't declare this
  // index unconditionally. Safe to call unconditionally and repeatedly (IF NOT EXISTS).
  db.exec("CREATE INDEX IF NOT EXISTS idx_companies_domain_identity_status ON companies(domain_identity_status)");
}

function runJobSourceReviewMigrations(db: Database.Database) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(job_sources)").all() as { name: string }[]).map((c) => c.name)
  );
  const reviewStatusIsNew = !existingColumns.has("review_status");
  if (reviewStatusIsNew) {
    db.exec("ALTER TABLE job_sources ADD COLUMN review_status TEXT NOT NULL DEFAULT 'PENDING'");
  }
  if (!existingColumns.has("reviewed_at")) db.exec("ALTER TABLE job_sources ADD COLUMN reviewed_at TEXT");
  if (!existingColumns.has("review_evidence")) db.exec("ALTER TABLE job_sources ADD COLUMN review_evidence TEXT");
  // One-time compatibility authorization: every structured source predating this gate was manually
  // audited in the bounded cohorts. Future automated discoveries remain PENDING.
  if (reviewStatusIsNew) {
    db.exec(
      `UPDATE job_sources
       SET review_status = 'APPROVED', reviewed_at = datetime('now'),
           review_evidence = 'Approved during pre-bulk bounded connector audit'
       WHERE is_active = 1 AND resolution_status = 'VERIFIED'
         AND provider IN ('greenhouse', 'lever', 'ashby', 'workday')`
    );
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_job_sources_review_status ON job_sources(review_status)");
}

// --- Phase 3 V1: tailoring approval provenance ------------------------------------------------

// Nullable, additive — set only when marked_for_tailoring becomes true (see
// src/db/queries/candidateJobState.ts's setMarkedForTailoring), cleared when it becomes false.
// Never inferred/guessed when approval context is absent; simply stays NULL.
const CANDIDATE_JOB_STATE_TAILORING_APPROVAL_ADDITIVE_COLUMNS: { name: string; ddl: string }[] = [
  { name: "tailoring_approval_type", ddl: "ALTER TABLE candidate_job_state ADD COLUMN tailoring_approval_type TEXT" },
  { name: "tailoring_approved_decision", ddl: "ALTER TABLE candidate_job_state ADD COLUMN tailoring_approved_decision TEXT" },
];

function runTailoringApprovalMigrations(db: Database.Database) {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(candidate_job_state)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const column of CANDIDATE_JOB_STATE_TAILORING_APPROVAL_ADDITIVE_COLUMNS) {
    if (!existingColumns.has(column.name)) {
      db.exec(column.ddl);
    }
  }
}

/**
 * Application Answer Vault — what the user has already told an application form.
 *
 * PURELY ADDITIVE. Three new tables, created only if absent; no existing table is altered and no
 * data is rewritten. An installation that never applies to anything carries three empty tables.
 *
 * WHY THREE. The canonical question is the thing an answer belongs to; the variants are the exact
 * wordings different sites used for it, kept verbatim so a mapping can always be audited against
 * what was really on screen; the answer is per candidate, because two people sharing this app do
 * not share a salary expectation or a work authorisation.
 *
 * `approved_by_user` and `auto_fill_allowed` are separate on purpose. Approving an answer once is
 * not the same as consenting to it being typed into every future form unattended, and collapsing
 * the two would make the second happen silently as a side effect of the first.
 */
function runApplicationVaultMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_key TEXT NOT NULL UNIQUE,
      normalized_question TEXT NOT NULL,
      question_type TEXT NOT NULL,
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      reuse_policy TEXT NOT NULL DEFAULT 'ask_each_time',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS application_question_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL REFERENCES application_questions(id) ON DELETE CASCADE,
      observed_text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      source_ats TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(question_id, normalized_text)
    );

    CREATE TABLE IF NOT EXISTS application_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL REFERENCES application_questions(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      answer_value TEXT NOT NULL,
      answer_source TEXT NOT NULL,
      approved_by_user INTEGER NOT NULL DEFAULT 0,
      auto_fill_allowed INTEGER NOT NULL DEFAULT 0,
      last_confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(question_id, candidate_id)
    );

    CREATE INDEX IF NOT EXISTS idx_app_variants_normalized ON application_question_variants(normalized_text);
    CREATE INDEX IF NOT EXISTS idx_app_answers_candidate ON application_answers(candidate_id);
  `);
}

/**
 * Application runs and their history.
 *
 * PERSISTED, NOT IN MEMORY. A run can sit waiting for a CAPTCHA, an MFA code or an answer for as
 * long as the user needs. Holding that in a process variable means restarting Career-Ops silently
 * loses a half-completed application, and the user only finds out by discovering they never
 * applied. State lives in SQLite so a restart is survivable.
 *
 * NO SECRETS HERE. Passwords and verification codes are never written to these tables — see the
 * credential store for where a secret actually lives. `checkpoint_json` holds navigational state
 * (URL, step, which fields are done), not values typed into sensitive fields.
 *
 * Additive: two new tables, nothing existing altered.
 */
function runApplicationRunMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL,
      ats TEXT,
      apply_url TEXT,
      status TEXT NOT NULL,
      blocking_reason TEXT,
      blocking_question TEXT,
      checkpoint_json TEXT,
      resume_file TEXT,
      cover_letter_file TEXT,
      submit_approved_at TEXT,
      submitted_at TEXT,
      confirmation_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS application_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES application_runs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_app_runs_candidate_status ON application_runs(candidate_id, status);
    CREATE INDEX IF NOT EXISTS idx_app_run_events_run ON application_run_events(run_id, id);
  `);
}

/**
 * Stage: application run duplicate guard.
 *
 * A partial UNIQUE index enforces the single-active-run invariant at the DB layer: at most one
 * protected (non-FAILED, non-CANCELLED) row may exist per (candidate_id, dedupe_key).
 *
 * WHY PARTIAL, NOT FULL. Only FAILED and CANCELLED may be retried; every other status means the
 * run is in progress, waiting on a human, or already confirmed submitted. A full unique index
 * would prevent even retrying a legitimately failed run. The partial form is the minimum-correct
 * constraint.
 *
 * WHY ONE INDEX, NOT TWO. Two separate indexes (e.g., one for active + one for submitted) would
 * allow one SUBMITTED row PLUS one active row simultaneously, defeating the invariant. A single
 * partial index covering all non-retryable statuses is the only shape that works.
 *
 * Additive: CREATE UNIQUE INDEX IF NOT EXISTS is a no-op on a database that already has it.
 */
function runApplicationRunDuplicateGuardMigration(db: Database.Database) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_app_runs_active_per_job
      ON application_runs(candidate_id, dedupe_key)
      WHERE status NOT IN ('FAILED', 'CANCELLED');
  `);
}

/**
 * PHASE 9D — the smallest safe application-profile storage for employment/education facts.
 *
 * EMPTY BY DESIGN. No authoritative structured source for these facts exists yet — the Master
 * Resume is a formatted .docx, not structured data, and parsing its prose into dated employment
 * records would be inventing facts from text exactly like this system refuses to do everywhere
 * else. These tables therefore start, and stay, empty until a human (or an explicit, reviewed
 * future import step) populates them through `candidateEmployment.ts` / `candidateEducation.ts`'s
 * own write functions. Nothing in this migration or anywhere else back-fills a row.
 *
 * CANDIDATE-SCOPED, MULTI-USER READY. `candidate_id` is required and cascades on delete, the same
 * pattern as `application_answers` — a future multi-user Career-Ops needs no schema change here,
 * only a real second candidate.
 *
 * Additive: two new tables, nothing existing altered.
 */
function runCandidateApplicationProfileMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_employment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      employer TEXT NOT NULL,
      title TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      location TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS candidate_education (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      institution TEXT NOT NULL,
      level TEXT NOT NULL,
      field TEXT NOT NULL,
      location TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_candidate_employment_candidate ON candidate_employment(candidate_id, display_order);
    CREATE INDEX IF NOT EXISTS idx_candidate_education_candidate ON candidate_education(candidate_id, display_order);
  `);
}


function ensureCandidateOne(db: Database.Database) {
  const existing = db.prepare("SELECT id FROM candidates WHERE id = 1").get();
  if (existing) return;
  db.prepare(
    `INSERT INTO candidates (id, first_name, last_name, display_name, status) VALUES (1, 'Candidate', 'One', 'Candidate #1', 'active')`
  ).run();
  db.prepare(`INSERT OR IGNORE INTO candidate_settings (candidate_id) VALUES (1)`).run();
}

function createConnection(): Database.Database {
  ensureDataDirs();
  const db = new Database(getDbPath());
  // Configure contention handling before any pragma/schema operation that may itself need SQLite's
  // single writer slot. Five independent local workers share this WAL database; short overlapping
  // checkpoints are normal and should wait rather than fail a whole cohort at process startup.
  db.pragma("busy_timeout = 30000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // This remains a bounded local wait, not a distributed-locking scheme. Long operations still
  // fail visibly after 30 seconds so a wedged writer cannot silently stall the system forever.
  const schema = fs.readFileSync(
    path.join(process.cwd(), "src", "db", "schema.sql"),
    "utf-8"
  );
  db.exec(schema);
  migrateCompaniesSourceTypeCheck(db, schema);
  runAdditiveMigrations(db);
  runAdditiveCompaniesMigrations(db);
  migrateJobsPipelineStatusCheck(db, schema);
  migrateCompaniesH1bConfidenceCheck(db, schema);
  migrateJobsH1bConfidenceCheck(db, schema);
  ensureJobsIndexes(db);
  runStructuredIntelMigrations(db);
  ensureStructuredIntelIndexes(db);
  runScanHealthMigrations(db);
  runReliabilityMigrations(db);
  runScanRunsWarningMigrations(db);
  runCandidateContactMigrations(db);
  migrateAiEnrichmentsEntityKey(db, schema);
  runCompaniesDiscoveryMigrations(db);
  ensureCandidateOne(db);
  runCandidateScopingMigrations(db, schema);
  runCandidatePinMigrations(db);
  runCompaniesDomainIdentityMigrations(db);
  runTailoringApprovalMigrations(db);
  runJobSourceReviewMigrations(db);
  runApplicationVaultMigrations(db);
  runApplicationRunMigrations(db);
  runApplicationRunDuplicateGuardMigration(db);
  runCandidateApplicationProfileMigrations(db);
  // 50K ATS/company registry: schema.sql creates the additive tables; this idempotent projection
  // runs only after every legacy company discovery/domain column is guaranteed to exist.
  runOrganizationRegistryBackfill(db);
  backfillOrganizationDiscoveryState(db);
  /* Last, deliberately: this index spans columns added by several of the additive migrations above
   * (employment_type_normalized, seniority, salary_*, clearance_required, industry_domain). Created
   * inside ensureJobsIndexes it failed with "no such column" on any fresh database — the same
   * ordering hazard idx_jobs_archived is documented for. */
  ensureJobsListCoveringIndex(db);
  return db;
}

export function getDb(): Database.Database {
  if (!global.__careerOpsDb) {
    global.__careerOpsDb = createConnection();
  }
  return global.__careerOpsDb;
}

/**
 * Stage 25B — discards the cached connection so the NEXT getDb() opens a fresh one.
 *
 * This exists because the cached handle is process-lifetime and had no path that ever released it:
 * when its WAL index was pulled out from under it (see src/db/health.ts for the full incident), the
 * server returned HTTP 500 from every API route for six hours while the file on disk was provably
 * intact. Closing is best-effort on purpose — a poisoned handle can fail to close, and refusing to
 * drop the reference in that case would defeat the entire recovery.
 *
 * Not a general-purpose "reset the database" helper: reconnecting re-runs createConnection()'s
 * schema/migration pass, which is idempotent but not free, so this is only called from the health
 * layer's bounded recovery path.
 */
export function closeDbConnection(): void {
  const existing = global.__careerOpsDb;
  global.__careerOpsDb = undefined;
  if (!existing) return;
  try {
    existing.close();
  } catch {
    // Intentionally swallowed: the reference is already dropped, so the next getDb() reconnects
    // regardless of whether this handle could be closed cleanly.
  }
}
