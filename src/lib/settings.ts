import { z } from "zod";

/**
 * Settings / Configuration (see src/db/queries/settings.ts for the persistence layer).
 *
 * Three groups, each mirroring a previously hardcoded value elsewhere in the app:
 *   - lifecycle:   src/lib/jobLifecycle.ts's FRESH_MAX_DAYS/ACTIVE_MAX_DAYS/ARCHIVE_MAX_DAYS.
 *   - suppression: new — how long a SYSTEM-GENERATED (age-based sweep) suppression fingerprint
 *                  keeps a job from reappearing on a later scan. Explicit "Not Interested"
 *                  suppression is deliberately NOT covered by this group — it stays permanent, the
 *                  same as it always was; see isSuppressionActive below for why the two are kept
 *                  strictly separate.
 *   - scanner:     src/lib/scan/retry.ts's DEFAULT_MAX_ATTEMPTS/DEFAULT_BASE_DELAY_MS/
 *                  DEFAULT_MAX_DELAY_MS/DEFAULT_TIMEOUT_MS and src/lib/scan.ts's ATS_CONCURRENCY.
 *
 * DEFAULT_SETTINGS' lifecycle/scanner values are exactly those prior hardcoded constants, so an
 * empty settings table (nothing saved yet) reproduces today's behavior exactly — see
 * src/db/queries/settings.ts's getAppSettings, which falls back to these defaults per-key.
 */

export const SCANNER_BOUNDS = {
  timeoutMs: { min: 1000, max: 120_000 },
  maxAttempts: { min: 1, max: 10 },
  baseDelayMs: { min: 0, max: 10_000 },
  maxDelayMs: { min: 100, max: 60_000 },
  concurrency: { min: 1, max: 20 },
} as const;

export const SUPPRESSION_BOUNDS = {
  expiredJobSuppressionDays: { min: 1, max: 3650 },
} as const;

const lifecycleSchema = z.object({
  freshDays: z.number().int().min(0),
  archiveAfterDays: z.number().int().min(0),
  deleteAfterDays: z.number().int().min(0),
});

/** Governs ONLY the age-based sweep's system-generated suppression fingerprints ("Aged out: ..." —
 *  see runAgeBasedSweep). Explicit "Not Interested" suppression has no configurable field here on
 *  purpose — it is never time-bounded; see isSuppressionActive below. */
const suppressionSchema = z.object({
  expiredJobSuppressionDays: z
    .number()
    .int()
    .min(SUPPRESSION_BOUNDS.expiredJobSuppressionDays.min)
    .max(SUPPRESSION_BOUNDS.expiredJobSuppressionDays.max),
});

const scannerSchema = z.object({
  timeoutMs: z.number().int().min(SCANNER_BOUNDS.timeoutMs.min).max(SCANNER_BOUNDS.timeoutMs.max),
  maxAttempts: z.number().int().min(SCANNER_BOUNDS.maxAttempts.min).max(SCANNER_BOUNDS.maxAttempts.max),
  baseDelayMs: z.number().int().min(SCANNER_BOUNDS.baseDelayMs.min).max(SCANNER_BOUNDS.baseDelayMs.max),
  maxDelayMs: z.number().int().min(SCANNER_BOUNDS.maxDelayMs.min).max(SCANNER_BOUNDS.maxDelayMs.max),
  concurrency: z.number().int().min(SCANNER_BOUNDS.concurrency.min).max(SCANNER_BOUNDS.concurrency.max),
});

/**
 * Full-object schema — cross-field ordering rules live here (superRefine) rather than on the
 * individual field schemas, since they depend on more than one field at once. Always validated
 * against the fully-merged settings object (see updateAppSettings), never a raw patch alone, so a
 * partial update that would break ordering against the *current* settings is caught too.
 */
export const appSettingsSchema = z
  .object({
    lifecycle: lifecycleSchema,
    suppression: suppressionSchema,
    scanner: scannerSchema,
  })
  .strict()
  .superRefine((s, ctx) => {
    if (!(s.lifecycle.archiveAfterDays > s.lifecycle.freshDays)) {
      ctx.addIssue({
        code: "custom",
        path: ["lifecycle", "archiveAfterDays"],
        message: "archive_after_days must be greater than fresh_days",
      });
    }
    if (!(s.lifecycle.deleteAfterDays > s.lifecycle.archiveAfterDays)) {
      ctx.addIssue({
        code: "custom",
        path: ["lifecycle", "deleteAfterDays"],
        message: "delete_after_days must be greater than archive_after_days",
      });
    }
    if (!(s.scanner.maxDelayMs >= s.scanner.baseDelayMs)) {
      ctx.addIssue({
        code: "custom",
        path: ["scanner", "maxDelayMs"],
        message: "max_delay_ms must be greater than or equal to base_delay_ms",
      });
    }
  });

/** Shape/bounds-only validation for a raw PATCH body, before it's merged onto current settings.
 *  Deliberately `.strict()` at every level — an unknown key is rejected, never silently ignored,
 *  so a typo'd or injected field can't slip past validation unnoticed. */
export const appSettingsPatchSchema = z
  .object({
    lifecycle: lifecycleSchema.partial().strict().optional(),
    suppression: suppressionSchema.partial().strict().optional(),
    scanner: scannerSchema.partial().strict().optional(),
  })
  .strict();

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  lifecycle: {
    freshDays: 3,
    archiveAfterDays: 7,
    deleteAfterDays: 10,
  },
  suppression: {
    expiredJobSuppressionDays: 60,
  },
  scanner: {
    timeoutMs: 20_000,
    maxAttempts: 3,
    baseDelayMs: 300,
    maxDelayMs: 4000,
    concurrency: 6,
  },
};

export interface SettingsValidationError {
  path: string;
  message: string;
}

/** Runs the full cross-field validation and returns flat, API/UI-friendly errors (empty = valid). */
export function validateAppSettings(candidate: AppSettings): SettingsValidationError[] {
  const result = appSettingsSchema.safeParse(candidate);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** SQLite's datetime('now') stores UTC without a trailing 'Z' — parsed as local time otherwise
 *  (same fix as src/app/scanner/page.tsx's formatTimestamp). */
function parseSqliteUtc(value: string): Date {
  return new Date(value.endsWith("Z") ? value : `${value}Z`);
}

/**
 * Suppression enforcement (see src/db/queries/jobs.ts's upsertJob). Two deliberately different
 * policies, keyed on `reason`:
 *
 *   - "Not Interested" (explicit user rejection, via markNotInterested): PERMANENT. Never expires,
 *     regardless of Settings. The user made an explicit decision about this exact requisition; time
 *     elapsing is not consent for it to silently reappear. This is the original, always-permanent
 *     behavior — untouched by Settings.
 *   - anything else (system-generated — the age-based sweep's "Aged out: N days unapplied", see
 *     runAgeBasedSweep): bounded by suppression.expiredJobSuppressionDays. This one genuinely is a
 *     new, configurable behavior — the sweep deleted the job for going stale, not because the user
 *     rejected it, so it's reasonable for the same requisition to become eligible again later (e.g.
 *     it gets reposted after a hiring freeze).
 *
 * The suppressed_jobs row itself is left in place either way once its window (if any) lapses —
 * cheap history; a later suppression of the same dedupe_key simply refreshes suppressed_at via the
 * ON CONFLICT upsert in suppressAndDeleteJob.
 */
export function isSuppressionActive(
  row: { reason: string; suppressed_at: string },
  suppression: AppSettings["suppression"],
  now: Date = new Date()
): boolean {
  if (row.reason === "Not Interested") return true;
  const ageDays = (now.getTime() - parseSqliteUtc(row.suppressed_at).getTime()) / DAY_MS;
  return ageDays < suppression.expiredJobSuppressionDays;
}
