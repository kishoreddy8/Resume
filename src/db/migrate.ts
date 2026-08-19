import fs from "node:fs";
import path from "node:path";
import { DB_PATH, getDb } from "./index";

const BACKUP_RETENTION = 20;

/**
 * Stage 27 — refuse to create a snapshot that would leave the volume dangerously full.
 *
 * Why this is a real risk rather than a theoretical one: app.db is a multi-gigabyte file and the
 * retention policy above keeps BACKUP_RETENTION *sets* of it. On the machine this runs on, free space
 * is already a small multiple of the database's own size, so a run of migrations can consume the
 * remaining disk — and a full disk while SQLite is writing is a far worse failure than any migration
 * this backup exists to protect against.
 *
 * The floor is what must remain free AFTER the copy. Deliberately checked before any bytes are
 * written, so the outcome is a clean refusal rather than a half-written snapshot beside a full disk.
 * The existing CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP escape hatch still applies, unchanged.
 */
const MIN_FREE_BYTES_AFTER_BACKUP = 5 * 1024 * 1024 * 1024; // 5 GiB

export class InsufficientDiskSpaceForBackupError extends Error {
  constructor(requiredBytes: number, freeBytes: number) {
    const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;
    super(
      `Refusing to write a pre-migration backup: it needs ${gib(requiredBytes)} and only ${gib(freeBytes)} is free, ` +
        `which would leave less than ${gib(MIN_FREE_BYTES_AFTER_BACKUP)} on the volume. ` +
        `Free up space (data/backups/ is the usual culprit) and retry.`
    );
    this.name = "InsufficientDiskSpaceForBackupError";
  }
}

/** Total bytes the snapshot about to be written will occupy (db + whichever sidecars exist). */
function plannedBackupBytes(suffixes: readonly string[]): number {
  let total = 0;
  for (const suffix of suffixes) {
    const source = `${DB_PATH}${suffix}`;
    if (!fs.existsSync(source)) continue;
    total += fs.statSync(source).size;
  }
  return total;
}

/**
 * Free bytes on the volume holding the backups directory, or null when the platform/runtime cannot
 * report it. A null result deliberately SKIPS the check rather than blocking the migration: refusing
 * to migrate because we could not measure free space would be a worse default than proceeding, and
 * the copy itself still fails closed if the disk really is full.
 */
function freeBytesOn(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
/** Explicit, non-default escape hatch — see backupBeforeMigration's doc comment. Never set this in
 *  normal use; it exists only for a genuine "I understand the risk and need to proceed anyway" case
 *  (e.g. disk truly full and the migration itself is more urgent than the safety net). */
const BYPASS_ENV_VAR = "CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP";

export class MigrationBackupError extends Error {
  constructor(cause: unknown) {
    super(
      `Pre-migration backup failed — refusing to modify the live database without a safety snapshot. ` +
        `Set ${BYPASS_ENV_VAR}=true to explicitly bypass this (not recommended). Underlying error: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "MigrationBackupError";
  }
}

/**
 * Automatic pre-migration snapshot — before this, backups only existed if a developer remembered to
 * make one by hand (data/backups/ has 46+ manual "pre-<feature>-<timestamp>.bak" snapshots proving
 * this was already standard practice, just undertooled). Copies the live app.db + its WAL/SHM
 * sidecar files using the SAME naming convention those manual snapshots already used, so this is a
 * drop-in continuation, not a new scheme.
 *
 * FAIL-CLOSED BY DEFAULT: if a backup is required (the DB already exists) and it cannot be created —
 * permission failure, disk-full, I/O error, invalid destination — the migration does NOT proceed.
 * An automatic "migration safety" step that silently lets the migration run anyway on backup failure
 * defeats its own purpose. The only way to bypass this is the explicit, non-default
 * CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP=true environment variable — never the default behavior.
 *
 * Returns without doing anything if DB_PATH doesn't exist yet (first-ever run — nothing to snapshot,
 * this is not a failure).
 */
export function backupBeforeMigration(): void {
  if (!fs.existsSync(DB_PATH)) return;

  try {
    const backupsDir = path.join(path.dirname(DB_PATH), "backups");
    fs.mkdirSync(backupsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = path.basename(DB_PATH); // "app.db"
    const suffixes = ["", "-wal", "-shm"];

    // Stage 27 — preflight before a single byte is copied.
    const required = plannedBackupBytes(suffixes);
    const free = freeBytesOn(backupsDir);
    if (free !== null && free - required < MIN_FREE_BYTES_AFTER_BACKUP) {
      throw new InsufficientDiskSpaceForBackupError(required, free);
    }

    for (const suffix of suffixes) {
      const source = `${DB_PATH}${suffix}`;
      if (!fs.existsSync(source)) continue; // WAL/SHM sidecars don't always exist
      const dest = path.join(backupsDir, `${baseName}${suffix}.pre-migration-${timestamp}.bak`);
      fs.copyFileSync(source, dest);
    }
    console.log(`Pre-migration backup written: ${baseName}.pre-migration-${timestamp}.bak`);

    pruneOldBackups(backupsDir);
  } catch (err) {
    if (process.env[BYPASS_ENV_VAR] === "true") {
      console.warn(
        `WARNING: pre-migration backup failed, but ${BYPASS_ENV_VAR}=true — proceeding anyway. ` +
          `This is NOT the default; unset this variable to restore the safe (fail-closed) behavior.`,
        err
      );
      return;
    }
    throw new MigrationBackupError(err);
  }
}

/** Keeps only the newest BACKUP_RETENTION "pre-migration-*" snapshot sets so data/backups/ doesn't
 *  grow unbounded. Manual "pre-<feature>-*" snapshots from earlier sessions are untouched — this
 *  only prunes the ones this automatic step itself created. */
function pruneOldBackups(backupsDir: string): void {
  const files = fs.readdirSync(backupsDir).filter((f) => f.includes(".pre-migration-"));
  const timestamps = Array.from(
    new Set(files.map((f) => f.match(/\.pre-migration-(.+)\.bak$/)?.[1]).filter((t): t is string => !!t))
  ).sort();

  const toDelete = timestamps.slice(0, Math.max(0, timestamps.length - BACKUP_RETENTION));
  for (const ts of toDelete) {
    for (const f of files.filter((f) => f.includes(`.pre-migration-${ts}.bak`))) {
      fs.unlinkSync(path.join(backupsDir, f));
    }
  }
}

// Only runs the actual migration (and, on failure, exits the process) when this file is executed
// directly as a script (`npm run migrate`) — not when backupBeforeMigration is imported for testing.
if (require.main === module) {
  try {
    backupBeforeMigration();
  } catch (err) {
    if (err instanceof MigrationBackupError) {
      console.error(`FATAL: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // getDb() applies schema.sql + every additive migration — called only after the backup above.
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];

  console.log("Migration complete. Tables:", tables.map((t) => t.name).join(", "));
}
