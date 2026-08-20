import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/db";

/**
 * Destructive candidate operations, authorised by the owner account.
 *
 * Deleting a profile is irreversible and removes real work — match results, notifications, resume
 * workflows and the uploaded Master Resume/Skills files on disk. So it carries guards that cannot
 * be argued around by a caller:
 *
 *   - the OWNER can never be deleted, by anyone, including themselves. Losing the owner would leave
 *     the install with nobody able to authorise anything, and no path to recover.
 *   - the LAST remaining candidate can never be deleted.
 *   - every candidate-scoped table is cleared inside one transaction, so a failure part-way cannot
 *     leave a profile that exists in some tables and not others.
 *
 * Files are removed only after the transaction commits: a rolled-back database with deleted files
 * would be far worse than an orphaned directory.
 */

export type DeleteCandidateResult =
  | { ok: true; deletedRows: Record<string, number>; filesRemoved: boolean }
  | { ok: false; reason: "not_found" | "is_owner" | "last_candidate" };

/** Tables carrying a candidate_id, discovered from the schema so a new one cannot be missed. */
function candidateScopedTables(): string[] {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return tables
    .filter((t) => {
      const cols = db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[];
      return cols.some((c) => c.name === "candidate_id");
    })
    .map((t) => t.name);
}

function candidateDir(candidateId: number): string {
  return path.join(process.cwd(), "data", "candidates", String(candidateId));
}

export function deleteCandidate(candidateId: number): DeleteCandidateResult {
  const db = getDb();
  const target = db.prepare("SELECT id, is_owner FROM candidates WHERE id = ?").get(candidateId) as
    | { id: number; is_owner: number }
    | undefined;
  if (!target) return { ok: false, reason: "not_found" };
  if (target.is_owner === 1) return { ok: false, reason: "is_owner" };

  const total = (db.prepare("SELECT COUNT(*) AS n FROM candidates").get() as { n: number }).n;
  if (total <= 1) return { ok: false, reason: "last_candidate" };

  const tables = candidateScopedTables();
  const deletedRows: Record<string, number> = {};

  const run = db.transaction(() => {
    for (const t of tables) {
      const info = db.prepare(`DELETE FROM ${t} WHERE candidate_id = ?`).run(candidateId);
      if (info.changes > 0) deletedRows[t] = info.changes;
    }
    const c = db.prepare("DELETE FROM candidates WHERE id = ?").run(candidateId);
    deletedRows.candidates = c.changes;
  });
  run();

  // Only after the commit — see the header.
  let filesRemoved = false;
  const dir = candidateDir(candidateId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    filesRemoved = true;
  }

  return { ok: true, deletedRows, filesRemoved };
}
