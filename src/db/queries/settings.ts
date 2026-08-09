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
    for (const key of LEGACY_KEYS) dropLegacy.run(key);
  })();

  return { ok: true, settings };
}

/** Deletes every stored setting row — getAppSettings() then falls back to DEFAULT_SETTINGS for
 *  every key, which is indistinguishable from "never configured". Also covers any LEGACY_KEYS
 *  row, same as updateAppSettings — a reset must not leave a stale, no-longer-read key behind. */
export function resetAppSettings(): AppSettings {
  getDb().prepare("DELETE FROM settings").run();
  return DEFAULT_SETTINGS;
}
