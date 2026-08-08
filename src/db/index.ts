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
  // Must run after the loop above, not from schema.sql's single db.exec(schema) call: on an
  // existing database is_archived doesn't exist until the ADD COLUMN above runs, so an index on it
  // declared inside schema.sql would fail with "no such column" every time (schema.sql's own
  // CREATE TABLE IF NOT EXISTS jobs is a no-op there, since the table already exists without that
  // column). Safe to run unconditionally — IF NOT EXISTS makes it a no-op on fresh installs where
  // schema.sql's CREATE TABLE already included the column from the start.
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_archived ON jobs(is_archived)");
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
  return db;
}

export function getDb(): Database.Database {
  if (!global.__careerOpsDb) {
    global.__careerOpsDb = createConnection();
  }
  return global.__careerOpsDb;
}
