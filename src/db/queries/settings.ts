import { getDb } from "@/db";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsValidationError,
} from "@/lib/settings";

interface SettingsRow {
  key: string;
  value: string;
}

// Fixed, known set of storage keys — every read/write goes through this map, never a caller-supplied
// key string, so there's no path for arbitrary key/SQL injection via the settings API.
const STORAGE_KEYS = {
  freshDays: "lifecycle.fresh_days",
  archiveAfterDays: "lifecycle.archive_after_days",
  deleteAfterDays: "lifecycle.delete_after_days",
  expiredJobSuppressionDays: "suppression.expired_job_suppression_days",
  timeoutMs: "scanner.timeout_ms",
  maxAttempts: "scanner.max_attempts",
  baseDelayMs: "scanner.base_delay_ms",
  maxDelayMs: "scanner.max_delay_ms",
  concurrency: "scanner.concurrency",
  requiresSponsorship: "candidate.requires_sponsorship",
  usCitizen: "candidate.us_citizen",
  workAuthorizedUS: "candidate.work_authorized_us",
  clearanceLevel: "candidate.clearance_level",
  schedulerEnabled: "scheduler.enabled",
  schedulerScanEnabled: "scheduler.scan_enabled",
  schedulerProductionEnabled: "scheduler.production_enabled",
  schedulerEvaluationEnabled: "scheduler.evaluation_enabled",
  schedulerWriterEnabled: "scheduler.writer_enabled",
  schedulerIntervalMinutes: "scheduler.interval_minutes",
  schedulerWindowStartHour: "scheduler.window_start_hour",
  schedulerWindowEndHour: "scheduler.window_end_hour",
  schedulerTimezone: "scheduler.timezone",
} as const;

// Removed: explicit "Not Interested" suppression is permanent and was never actually meant to be
// governed by a retention window (see src/lib/settings.ts's isSuppressionActive doc comment) — this
// key is purged from storage on the next write (updateAppSettings/resetAppSettings) if a database
// still has it saved from before the correction. Harmless if never present; getAppSettings() never
// reads it either way (it's not in STORAGE_KEYS above).
const LEGACY_KEYS = ["suppression.not_interested_retention_days"] as const;

function rowsToSettings(rows: SettingsRow[]): AppSettings {
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const num = (key: string, fallback: number): number => {
    const raw = stored.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = stored.get(key);
    if (raw === undefined) return fallback;
    return raw === "true";
  };
  const str = (key: string, fallback: string): string => stored.get(key) ?? fallback;

  return {
    lifecycle: {
      freshDays: num(STORAGE_KEYS.freshDays, DEFAULT_SETTINGS.lifecycle.freshDays),
      archiveAfterDays: num(STORAGE_KEYS.archiveAfterDays, DEFAULT_SETTINGS.lifecycle.archiveAfterDays),
      deleteAfterDays: num(STORAGE_KEYS.deleteAfterDays, DEFAULT_SETTINGS.lifecycle.deleteAfterDays),
    },
    suppression: {
      expiredJobSuppressionDays: num(
        STORAGE_KEYS.expiredJobSuppressionDays,
        DEFAULT_SETTINGS.suppression.expiredJobSuppressionDays
      ),
    },
    scanner: {
      timeoutMs: num(STORAGE_KEYS.timeoutMs, DEFAULT_SETTINGS.scanner.timeoutMs),
      maxAttempts: num(STORAGE_KEYS.maxAttempts, DEFAULT_SETTINGS.scanner.maxAttempts),
      baseDelayMs: num(STORAGE_KEYS.baseDelayMs, DEFAULT_SETTINGS.scanner.baseDelayMs),
      maxDelayMs: num(STORAGE_KEYS.maxDelayMs, DEFAULT_SETTINGS.scanner.maxDelayMs),
      concurrency: num(STORAGE_KEYS.concurrency, DEFAULT_SETTINGS.scanner.concurrency),
    },
    candidate: {
      requiresSponsorship: bool(STORAGE_KEYS.requiresSponsorship, DEFAULT_SETTINGS.candidate.requiresSponsorship),
      usCitizen: bool(STORAGE_KEYS.usCitizen, DEFAULT_SETTINGS.candidate.usCitizen),
      workAuthorizedUS: bool(STORAGE_KEYS.workAuthorizedUS, DEFAULT_SETTINGS.candidate.workAuthorizedUS),
      clearanceLevel: str(STORAGE_KEYS.clearanceLevel, DEFAULT_SETTINGS.candidate.clearanceLevel) as AppSettings["candidate"]["clearanceLevel"],
    },
    scheduler: {
      enabled: bool(STORAGE_KEYS.schedulerEnabled, DEFAULT_SETTINGS.scheduler.enabled),
      scanEnabled: bool(STORAGE_KEYS.schedulerScanEnabled, DEFAULT_SETTINGS.scheduler.scanEnabled),
      productionEnabled: bool(STORAGE_KEYS.schedulerProductionEnabled, DEFAULT_SETTINGS.scheduler.productionEnabled),
      evaluationEnabled: bool(STORAGE_KEYS.schedulerEvaluationEnabled, DEFAULT_SETTINGS.scheduler.evaluationEnabled),
      writerEnabled: bool(STORAGE_KEYS.schedulerWriterEnabled, DEFAULT_SETTINGS.scheduler.writerEnabled),
      intervalMinutes: num(STORAGE_KEYS.schedulerIntervalMinutes, DEFAULT_SETTINGS.scheduler.intervalMinutes),
      windowStartHour: num(STORAGE_KEYS.schedulerWindowStartHour, DEFAULT_SETTINGS.scheduler.windowStartHour),
      windowEndHour: num(STORAGE_KEYS.schedulerWindowEndHour, DEFAULT_SETTINGS.scheduler.windowEndHour),
      timezone: str(STORAGE_KEYS.schedulerTimezone, DEFAULT_SETTINGS.scheduler.timezone),
    },
  };
}

/**
 * Typed settings loader. A row missing from the table (fresh install, or a key never saved) falls
 * back to that field's DEFAULT_SETTINGS value — so an empty settings table reproduces today's
 * hardcoded behavior exactly (see src/lib/settings.ts's module doc comment). Defensively re-validates
 * whatever comes back from storage: a hand-edited or corrupted row falls back to DEFAULT_SETTINGS in
 * full rather than handing a partially-invalid config to lifecycle/suppression/scanner call sites.
 */
export function getAppSettings(): AppSettings {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as SettingsRow[];
  const candidate = rowsToSettings(rows);
  const parsed = appSettingsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export type UpdateSettingsResult =
  | { ok: true; settings: AppSettings }
  | { ok: false; errors: SettingsValidationError[] };

/**
 * Validates `patch` in two stages — shape/per-field bounds against the raw patch, then cross-field
 * ordering rules (fresh < archive < delete, max_delay >= base_delay) against the patch MERGED onto
 * current settings — before writing anything. An invalid patch leaves the stored settings completely
 * untouched (validation happens before the transaction even opens). Writes are additive upserts
 * (INSERT ... ON CONFLICT DO UPDATE) against the fixed STORAGE_KEYS set, wrapped in one transaction.
 */
export function updateAppSettings(patch: unknown): UpdateSettingsResult {
  const patchParsed = appSettingsPatchSchema.safeParse(patch);
  if (!patchParsed.success) {
    return {
      ok: false,
      errors: patchParsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }

  const current = getAppSettings();
  const merged: AppSettings = {
    lifecycle: { ...current.lifecycle, ...patchParsed.data.lifecycle },
    suppression: { ...current.suppression, ...patchParsed.data.suppression },
    scanner: { ...current.scanner, ...patchParsed.data.scanner },
    candidate: { ...current.candidate, ...patchParsed.data.candidate },
    scheduler: { ...current.scheduler, ...patchParsed.data.scheduler },
  };

  const fullParsed = appSettingsSchema.safeParse(merged);
  if (!fullParsed.success) {
    return {
      ok: false,
      errors: fullParsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }

  const settings = fullParsed.data;
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  const dropLegacy = db.prepare("DELETE FROM settings WHERE key = ?");
  db.transaction(() => {
    upsert.run({ key: STORAGE_KEYS.freshDays, value: String(settings.lifecycle.freshDays) });
    upsert.run({ key: STORAGE_KEYS.archiveAfterDays, value: String(settings.lifecycle.archiveAfterDays) });
    upsert.run({ key: STORAGE_KEYS.deleteAfterDays, value: String(settings.lifecycle.deleteAfterDays) });
    upsert.run({
      key: STORAGE_KEYS.expiredJobSuppressionDays,
      value: String(settings.suppression.expiredJobSuppressionDays),
    });
    upsert.run({ key: STORAGE_KEYS.timeoutMs, value: String(settings.scanner.timeoutMs) });
    upsert.run({ key: STORAGE_KEYS.maxAttempts, value: String(settings.scanner.maxAttempts) });
    upsert.run({ key: STORAGE_KEYS.baseDelayMs, value: String(settings.scanner.baseDelayMs) });
    upsert.run({ key: STORAGE_KEYS.maxDelayMs, value: String(settings.scanner.maxDelayMs) });
    upsert.run({ key: STORAGE_KEYS.concurrency, value: String(settings.scanner.concurrency) });
    upsert.run({ key: STORAGE_KEYS.requiresSponsorship, value: String(settings.candidate.requiresSponsorship) });
    upsert.run({ key: STORAGE_KEYS.usCitizen, value: String(settings.candidate.usCitizen) });
    upsert.run({ key: STORAGE_KEYS.workAuthorizedUS, value: String(settings.candidate.workAuthorizedUS) });
    upsert.run({ key: STORAGE_KEYS.clearanceLevel, value: settings.candidate.clearanceLevel });
    upsert.run({ key: STORAGE_KEYS.schedulerEnabled, value: String(settings.scheduler.enabled) });
    upsert.run({ key: STORAGE_KEYS.schedulerScanEnabled, value: String(settings.scheduler.scanEnabled) });
    upsert.run({ key: STORAGE_KEYS.schedulerProductionEnabled, value: String(settings.scheduler.productionEnabled) });
    upsert.run({ key: STORAGE_KEYS.schedulerEvaluationEnabled, value: String(settings.scheduler.evaluationEnabled) });
    upsert.run({ key: STORAGE_KEYS.schedulerWriterEnabled, value: String(settings.scheduler.writerEnabled) });
    upsert.run({ key: STORAGE_KEYS.schedulerIntervalMinutes, value: String(settings.scheduler.intervalMinutes) });
    upsert.run({ key: STORAGE_KEYS.schedulerWindowStartHour, value: String(settings.scheduler.windowStartHour) });
    upsert.run({ key: STORAGE_KEYS.schedulerWindowEndHour, value: String(settings.scheduler.windowEndHour) });
    upsert.run({ key: STORAGE_KEYS.schedulerTimezone, value: settings.scheduler.timezone });
    for (const key of LEGACY_KEYS) dropLegacy.run(key);
  })();

  return { ok: true, settings };
}

/**
 * Restores every user-editable setting to its default.
 *
 * ADMIN-SEC-1 — THIS USED TO BE `DELETE FROM settings` WITH NO FILTER, and that was a far larger
 * action than its name. The `settings` table is not just app preferences: it is the process-wide
 * key/value store, and at least seven unrelated subsystems keep state there under their own
 * namespaces. An unfiltered delete therefore also destroyed, silently:
 *
 *   - `profile_unlock_secret`  — the HMAC key every unlock token is signed with. Erasing it
 *                                invalidates every unlocked session at once, including the
 *                                operator's own, and mints a fresh secret on next read.
 *   - `*_lock.*` / lease rows  — the scan lock and the machine-wide writer/production leases.
 *                                Releasing those mid-run defeats the exact concurrency invariant
 *                                they exist to guarantee: a second writer pass could start against
 *                                a job the first is still working.
 *   - `*_runtime.*` and tick   — all operational liveness and provenance, which is what Admin's
 *     bookkeeping                health verdicts are derived from.
 *
 * The modules that own those keys justify their safety by living "outside STORAGE_KEYS, so no
 * client can overwrite them through the settings API" — true of updateAppSettings, which only ever
 * upserts fixed keys, but not of a blanket delete that never consulted STORAGE_KEYS at all.
 *
 * SO THIS IS AN ALLOWLIST, DELIBERATELY, AND NOT A `NOT IN (...)` BLACKLIST. The distinction is the
 * whole point: a blacklist has to be updated every time a subsystem adds a key, and forgetting is
 * silent and destructive. With an allowlist, a newly-added internal, security, or lease key is
 * preserved by default and the worst outcome of forgetting is that a genuinely user-editable
 * setting is not reset — visible, harmless, and easy to correct.
 *
 * LEGACY_KEYS are still removed, matching updateAppSettings: a reset must not leave behind a stale
 * key the product no longer reads.
 */
export function resetAppSettings(): AppSettings {
  const db = getDb();
  const remove = db.prepare("DELETE FROM settings WHERE key = ?");
  const resetAll = db.transaction(() => {
    for (const key of Object.values(STORAGE_KEYS)) remove.run(key);
    for (const key of LEGACY_KEYS) remove.run(key);
  });
  resetAll();
  return DEFAULT_SETTINGS;
}

/**
 * The exact set of keys `resetAppSettings` will remove. Exported for the ADMIN-SEC-1 regression
 * tests so they assert against the real allowlist rather than a copy that could drift from it.
 */
export const RESETTABLE_SETTINGS_KEYS: readonly string[] = [...Object.values(STORAGE_KEYS), ...LEGACY_KEYS];
