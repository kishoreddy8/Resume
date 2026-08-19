import { z } from "zod";

/**
 * Settings / Configuration (see src/db/queries/settings.ts for the persistence layer).
 *
 * Groups, each mirroring a previously hardcoded value elsewhere in the app:
 *   - lifecycle:   src/lib/jobLifecycle.ts's FRESH_MAX_DAYS/ACTIVE_MAX_DAYS/ARCHIVE_MAX_DAYS.
 *   - suppression: new — how long a SYSTEM-GENERATED (age-based sweep) suppression fingerprint
 *                  keeps a job from reappearing on a later scan. Explicit "Not Interested"
 *                  suppression is deliberately NOT covered by this group — it stays permanent, the
 *                  same as it always was; see isSuppressionActive below for why the two are kept
 *                  strictly separate.
 *   - scanner:     src/lib/scan/retry.ts's DEFAULT_MAX_ATTEMPTS/DEFAULT_BASE_DELAY_MS/
 *                  DEFAULT_MAX_DELAY_MS/DEFAULT_TIMEOUT_MS and src/lib/scan.ts's ATS_CONCURRENCY.
 *   - scheduler:   Phase 4 Stage 1 — user-configurable automatic-scan settings only (enabled,
 *                  interval, allowed time-of-day window, timezone). Deliberately does NOT include
 *                  runtime/lock state (lock_acquired_at, last_started_at, last_error, etc.) — those
 *                  are program-only and live in src/lib/scheduler/state.ts under their own raw
 *                  settings keys, readable via GET /api/scheduler but never PATCH-writable through
 *                  this schema. Mixing user-editable config with program-owned runtime state in one
 *                  PATCH-validated surface would let a client overwrite the lock/last-run bookkeeping
 *                  by accident — kept strictly separate on purpose.
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

// Per explicit instruction: given prior production scan cost, sub-minute scheduling is not
// permitted — 30 minutes is the enforced floor. 1440 (24h) is a generous ceiling; nothing about the
// lock/window design requires a smaller one.
//
// windowHour's max is 24, not 23: window.ts's isWithinWindow treats windowEndHour as EXCLUSIVE
// (hour < windowEndHour), so a true full-day window is {start: 0, end: 24} — capping end at 23
// would make hour 23 (11pm-midnight) permanently unreachable, silently breaking the "full day by
// default" intent. windowStartHour never needs to be 24 itself (a start of 24 is always rejected by
// the windowStartHour < windowEndHour superRefine check below), so sharing one bound is harmless.
export const SCHEDULER_BOUNDS = {
  intervalMinutes: { min: 30, max: 1440 },
  windowHour: { min: 0, max: 24 },
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

/**
 * Candidate Eligibility (Phase 2 — see src/lib/match/eligibility.ts). Small, fixed-shape facts about
 * the candidate's OWN visa/authorization/clearance status — genuinely distinct from anything a
 * resume should state (tailor-resume's guardrails explicitly forbid inferring visa/sponsorship status
 * from resume content) and distinct from any job-side fact Phase 1 already extracts. This is the only
 * place these facts live; Phase 2's eligibility engine reads them, nothing else does.
 */
const candidateSchema = z.object({
  requiresSponsorship: z.boolean(),
  usCitizen: z.boolean(),
  workAuthorizedUS: z.boolean(),
  clearanceLevel: z.enum(["None", "Public Trust", "Secret", "Top Secret", "TS/SCI"]),
});

const scannerSchema = z.object({
  timeoutMs: z.number().int().min(SCANNER_BOUNDS.timeoutMs.min).max(SCANNER_BOUNDS.timeoutMs.max),
  maxAttempts: z.number().int().min(SCANNER_BOUNDS.maxAttempts.min).max(SCANNER_BOUNDS.maxAttempts.max),
  baseDelayMs: z.number().int().min(SCANNER_BOUNDS.baseDelayMs.min).max(SCANNER_BOUNDS.baseDelayMs.max),
  maxDelayMs: z.number().int().min(SCANNER_BOUNDS.maxDelayMs.min).max(SCANNER_BOUNDS.maxDelayMs.max),
  concurrency: z.number().int().min(SCANNER_BOUNDS.concurrency.min).max(SCANNER_BOUNDS.concurrency.max),
});

/** Constructing Intl.DateTimeFormat with an invalid IANA identifier throws — the standard,
 *  dependency-free way to validate a timezone string without a hardcoded allowlist. */
function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Scheduler (Phase 4 Stage 1). User-configurable automatic-scan controls only — see the module doc
 * comment above for why runtime/lock state is deliberately excluded from this schema.
 *   - windowStartHour/windowEndHour: local hour-of-day (in `timezone`) during which a scheduled tick
 *     is allowed to start a scan. Overnight windows (start >= end) are not supported in v1 — see the
 *     superRefine check below; a window that wraps midnight is a real feature but adds enough
 *     ambiguity (which calendar day does "23 to 2" belong to?) that it's deliberately deferred.
 */
const schedulerSchema = z.object({
  enabled: z.boolean(),
  /**
   * Stage 27 — per-tick automation switches, additive to (never a replacement for) `enabled`.
   *
   * `enabled` remains the single top-level kill switch: when it is false NOTHING runs, exactly as
   * before. These four only narrow what runs when it is true, so an operator can turn on job
   * discovery and evaluation while deliberately leaving the resume writer off — the writer is the one
   * tick that spends the user's Claude subscription, so it deserves its own deliberate opt-in.
   *
   * All four default to TRUE precisely so an existing installation is unchanged by this migration:
   * a database with none of these keys set behaves exactly as it did when `enabled` alone gated all
   * four ticks. Nothing is silently enabled — with `enabled` still false, all four remain inert.
   */
  scanEnabled: z.boolean(),
  productionEnabled: z.boolean(),
  evaluationEnabled: z.boolean(),
  writerEnabled: z.boolean(),
  intervalMinutes: z
    .number()
    .int()
    .min(SCHEDULER_BOUNDS.intervalMinutes.min)
    .max(SCHEDULER_BOUNDS.intervalMinutes.max),
  windowStartHour: z.number().int().min(SCHEDULER_BOUNDS.windowHour.min).max(SCHEDULER_BOUNDS.windowHour.max),
  windowEndHour: z.number().int().min(SCHEDULER_BOUNDS.windowHour.min).max(SCHEDULER_BOUNDS.windowHour.max),
  timezone: z.string().min(1).refine(isValidIanaTimezone, {
    message: "timezone must be a valid IANA timezone identifier",
  }),
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
    candidate: candidateSchema,
    scheduler: schedulerSchema,
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
    if (!(s.scheduler.windowStartHour < s.scheduler.windowEndHour)) {
      ctx.addIssue({
        code: "custom",
        path: ["scheduler", "windowEndHour"],
        message: "window_end_hour must be greater than window_start_hour (overnight windows are not supported)",
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
    candidate: candidateSchema.partial().strict().optional(),
    scheduler: schedulerSchema.partial().strict().optional(),
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
  // Conservative defaults, deliberately in the "more restrictive" direction: a wrong default here
  // must fail toward under-stating eligibility (flagging a job that's actually fine), never toward
  // silently passing a job that's actually BLOCKED for the real candidate. The user is expected to
  // set these accurately via Settings before relying on Phase 2 match results.
  candidate: {
    requiresSponsorship: true,
    usCitizen: false,
    workAuthorizedUS: false,
    clearanceLevel: "None",
  },
  // Disabled by default: starting the application must never begin automatic production scans on
  // its own — the user must explicitly opt in via PATCH /api/settings. windowStartHour/windowEndHour
  // default to a full-day window (0-23) and timezone defaults to UTC (no assumption about the user's
  // location) so that once enabled, only intervalMinutes actually constrains scheduling out of the box.
  scheduler: {
    enabled: false,
    // See schedulerSchema: true by default so absent keys reproduce pre-Stage-27 behaviour exactly.
    // They can only ever narrow what the master switch already allows.
    scanEnabled: true,
    productionEnabled: true,
    evaluationEnabled: true,
    writerEnabled: true,
    intervalMinutes: 60,
    windowStartHour: 0,
    windowEndHour: 24,
    timezone: "UTC",
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
