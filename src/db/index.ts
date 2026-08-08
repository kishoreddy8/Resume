import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
// Override lets integration tests point at an isolated temp file instead of the real database —
// unset in normal app/script usage, so production behavior is unchanged.
const DB_PATH = process.env.CAREER_OPS_DB_PATH ?? path.join(DATA_DIR, "app.db");

function ensureDataDirs() {
  for (const dir of [
    DATA_DIR,
    path.join(DATA_DIR, "master", "history"),
    path.join(DATA_DIR, "generated"),
    path.join(DATA_DIR, "h1b"),
    path.dirname(DB_PATH),
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
function ensureJobsIndexes(db: Database.Database) {
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_archived ON jobs(is_archived)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_pinned ON jobs(pinned)");
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

function createConnection(): Database.Database {
  ensureDataDirs();
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
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
  migrateAiEnrichmentsEntityKey(db, schema);
  return db;
}

export function getDb(): Database.Database {
  if (!global.__careerOpsDb) {
    global.__careerOpsDb = createConnection();
  }
  return global.__careerOpsDb;
}
