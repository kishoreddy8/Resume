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
  return db;
}

export function getDb(): Database.Database {
  if (!global.__careerOpsDb) {
    global.__careerOpsDb = createConnection();
  }
  return global.__careerOpsDb;
}
