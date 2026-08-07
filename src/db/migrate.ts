import { getDb } from "./index";

const db = getDb();
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all() as { name: string }[];

console.log("Migration complete. Tables:", tables.map((t) => t.name).join(", "));
