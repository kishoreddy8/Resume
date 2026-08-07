import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");

function ensureDataDirs() {
  for (const dir of [
    DATA_DIR,
    path.join(DATA_DIR, "master", "history"),
    path.join(DATA_DIR, "generated"),
    path.join(DATA_DIR, "h1b"),
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
  runAdditiveMigrations(db);
  return db;
}

export function getDb(): Database.Database {
  if (!global.__careerOpsDb) {
    global.__careerOpsDb = createConnection();
  }
  return global.__careerOpsDb;
}
