import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/* ================================================================================================
 * ADMIN-SEC-1 — resetAppSettings blast radius.
 *
 * `settings` is not an app-preferences table; it is the process-wide key/value store, shared by the
 * unlock secret, three lease families, and every subsystem's runtime bookkeeping. Reset used to be
 * an unfiltered DELETE, so "Reset Settings" also logged everyone out and released the locks that
 * guarantee two writer passes cannot run at once. These tests pin the boundary.
 *
 * Everything below runs against a temp database. No production secret is read, written or printed;
 * the seeded values are obvious fakes.
 * ============================================================================================== */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let getAppSettings: typeof import("../settings").getAppSettings;
let updateAppSettings: typeof import("../settings").updateAppSettings;
let resetAppSettings: typeof import("../settings").resetAppSettings;
let RESETTABLE_SETTINGS_KEYS: typeof import("../settings").RESETTABLE_SETTINGS_KEYS;

/** Representative non-user-editable keys, one per real owning subsystem. */
const PRESERVED = {
  SECURITY_STATE: { key: "profile_unlock_secret", value: "fake-secret-for-test-only" },
  LEASE_SCAN: { key: "scheduler_lock.acquired_at", value: "2026-08-26T12:00:00.000Z" },
  LEASE_WRITER: { key: "resume_writer_lock.acquired_at", value: "2026-08-26T12:00:00.000Z" },
  LEASE_WRITER_OWNER: { key: "resume_writer_lock.owner_id", value: "fake-owner-id" },
  LEASE_PRODUCTION: { key: "production_cycle_lock.acquired_at", value: "2026-08-26T12:00:00.000Z" },
  RUNTIME_LIVENESS: { key: "scheduler_runtime.last_evaluated_at", value: "2026-08-26T12:00:00.000Z" },
  RUNTIME_OUTCOME: { key: "scheduler_runtime.last_successful_at", value: "2026-08-26T11:00:00.000Z" },
  RUNTIME_WRITER: { key: "resume_writer.last_tick_at", value: "2026-08-26T12:00:00.000Z" },
  RUNTIME_WRITER_BLOCK: { key: "resume_writer.block_class", value: "SUBSCRIPTION_LIMIT_REACHED" },
  RUNTIME_PRODUCTION: { key: "production_cycle.last_status", value: "READY" },
  RUNTIME_EVALUATION: { key: "job_evaluation_tick.last_started_at", value: "2026-08-26T12:00:00.000Z" },
  RUNTIME_MAINTENANCE: { key: "maintenance_runtime.last_started_at", value: "2026-08-26T12:00:00.000Z" },
  RUNTIME_RELIABILITY: { key: "reliability_runtime.last_started_at", value: "2026-08-26T12:00:00.000Z" },
  RUNTIME_EXTERNAL: { key: "external_run.built_in.last_started_at", value: "2026-08-26T12:00:00.000Z" },
  INTERNAL_METADATA: { key: "candidate_ui.active_candidate_id", value: "1" },
  UNKNOWN_FUTURE: { key: "some_future_subsystem.internal_state", value: "must-survive" },
} as const;

function put(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

function read(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-reset-safety-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ getAppSettings, updateAppSettings, resetAppSettings, RESETTABLE_SETTINGS_KEYS } = await import("../settings"));
  getDb();
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  getDb().prepare("DELETE FROM settings").run();
  for (const { key, value } of Object.values(PRESERVED)) put(key, value);
});

test("ADMINSEC-RESET-01: reset preserves the Admin unlock secret", () => {
  /* Erasing this invalidates every unlocked session at once — including the operator's own — and
   * silently mints a new secret on the next read. */
  resetAppSettings();
  assert.equal(read(PRESERVED.SECURITY_STATE.key), PRESERVED.SECURITY_STATE.value);
});

test("ADMINSEC-RESET-02: reset preserves every lease and lock", () => {
  /* Releasing a held lease mid-run defeats the concurrency invariant it exists to provide: a second
   * writer pass could start against work the first is still doing. */
  resetAppSettings();
  for (const entry of [PRESERVED.LEASE_SCAN, PRESERVED.LEASE_WRITER, PRESERVED.LEASE_WRITER_OWNER, PRESERVED.LEASE_PRODUCTION]) {
    assert.equal(read(entry.key), entry.value, `${entry.key} must survive a settings reset`);
  }
});

test("ADMINSEC-RESET-03: reset preserves scheduler liveness and all runtime bookkeeping", () => {
  resetAppSettings();
  for (const entry of [
    PRESERVED.RUNTIME_LIVENESS,
    PRESERVED.RUNTIME_OUTCOME,
    PRESERVED.RUNTIME_WRITER,
    PRESERVED.RUNTIME_WRITER_BLOCK,
    PRESERVED.RUNTIME_PRODUCTION,
    PRESERVED.RUNTIME_EVALUATION,
    PRESERVED.RUNTIME_MAINTENANCE,
    PRESERVED.RUNTIME_RELIABILITY,
    PRESERVED.RUNTIME_EXTERNAL,
    PRESERVED.INTERNAL_METADATA,
  ]) {
    assert.equal(read(entry.key), entry.value, `${entry.key} must survive a settings reset`);
  }
});

test("ADMINSEC-RESET-04: reset changes only allowlisted user-editable settings", () => {
  updateAppSettings({ scheduler: { enabled: true, intervalMinutes: 120 } });
  updateAppSettings({ scanner: { concurrency: 11 } });
  assert.equal(getAppSettings().scheduler.intervalMinutes, 120, "precondition: a non-default value is stored");

  resetAppSettings();

  const after = getAppSettings();
  assert.equal(after.scheduler.intervalMinutes, 60, "user-editable settings return to defaults");
  assert.equal(after.scheduler.enabled, false);
  assert.equal(after.scanner.concurrency, 6);

  /* And nothing outside the allowlist was touched. */
  const survivors = getDb().prepare("SELECT key FROM settings").all() as { key: string }[];
  const unexpectedlyDeleted = Object.values(PRESERVED).filter((e) => !survivors.some((s) => s.key === e.key));
  assert.deepEqual(unexpectedlyDeleted.map((e) => e.key), [], "no non-user-editable key may be deleted");
});

test("ADMINSEC-RESET-05: an unknown future internal key is preserved by default", () => {
  /* The point of an allowlist over a blacklist. A subsystem added next year keeps its state without
   * anyone remembering to exclude it here; the worst case of forgetting is a setting that does not
   * reset, which is visible and harmless, rather than state that silently vanishes. */
  resetAppSettings();
  assert.equal(read(PRESERVED.UNKNOWN_FUTURE.key), PRESERVED.UNKNOWN_FUTURE.value);
});

test("ADMINSEC-RESET-04b: the allowlist contains no namespace owned by another subsystem", () => {
  /* A guard against someone later adding a runtime/lease/secret key to STORAGE_KEYS by mistake. */
  const forbidden = /^(profile_unlock_secret|.*_lock\.|scheduler_runtime\.|resume_writer\.|production_cycle\.|maintenance_runtime\.|reliability_runtime\.|job_evaluation_tick\.|external_run\.|candidate_ui\.)/;
  const offenders = RESETTABLE_SETTINGS_KEYS.filter((k) => forbidden.test(k));
  assert.deepEqual(offenders, [], `these keys are owned by another subsystem and must not be resettable: ${offenders.join(", ")}`);
});

test("ADMINSEC-RESET-06: reset still returns defaults and still purges legacy keys", () => {
  put("suppression.not_interested_retention_days", "45");
  const result = resetAppSettings();
  assert.equal(result.scheduler.enabled, false, "returns DEFAULT_SETTINGS");
  assert.equal(read("suppression.not_interested_retention_days"), null, "stale legacy key is removed");
});

test("ADMINSEC-SECRET-01: the reset path never returns or exposes a secret value", () => {
  const result = resetAppSettings();
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /fake-secret-for-test-only/, "no secret value may appear in the response");
  assert.doesNotMatch(serialized, /unlock_secret/i);
});
