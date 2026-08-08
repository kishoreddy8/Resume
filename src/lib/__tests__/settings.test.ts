import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SETTINGS,
  isSuppressionActive,
  validateAppSettings,
  type AppSettings,
} from "../settings";

/**
 * Pure Settings tests — validation and the suppression-retention helper, no DB involved. See
 * src/db/queries/__tests__/settings.test.ts for the persistence-layer/integration tests.
 *
 * Run with: npm test
 */

test("DEFAULT_SETTINGS reproduces today's previously-hardcoded lifecycle/scanner values", () => {
  // See src/lib/jobLifecycle.ts's FRESH_MAX_DAYS/ACTIVE_MAX_DAYS/ARCHIVE_MAX_DAYS.
  assert.equal(DEFAULT_SETTINGS.lifecycle.freshDays, 3);
  assert.equal(DEFAULT_SETTINGS.lifecycle.archiveAfterDays, 7);
  assert.equal(DEFAULT_SETTINGS.lifecycle.deleteAfterDays, 10);
  // expired_job_suppression_days governs only system-generated (aged-out) suppression — explicit
  // Not Interested suppression is permanent and has no default here (see isSuppressionActive).
  assert.equal(DEFAULT_SETTINGS.suppression.expiredJobSuppressionDays, 60);
  // See src/lib/scan/retry.ts's DEFAULT_* constants and src/lib/scan.ts's (former) ATS_CONCURRENCY.
  assert.equal(DEFAULT_SETTINGS.scanner.timeoutMs, 20_000);
  assert.equal(DEFAULT_SETTINGS.scanner.maxAttempts, 3);
  assert.equal(DEFAULT_SETTINGS.scanner.baseDelayMs, 300);
  assert.equal(DEFAULT_SETTINGS.scanner.maxDelayMs, 4000);
  assert.equal(DEFAULT_SETTINGS.scanner.concurrency, 6);
});

test("validateAppSettings accepts the defaults with no errors", () => {
  assert.deepEqual(validateAppSettings(DEFAULT_SETTINGS), []);
});

test("validateAppSettings rejects archive_after_days <= fresh_days", () => {
  const candidate: AppSettings = {
    ...DEFAULT_SETTINGS,
    lifecycle: { freshDays: 5, archiveAfterDays: 5, deleteAfterDays: 10 },
  };
  const errors = validateAppSettings(candidate);
  assert.ok(errors.some((e) => e.path === "lifecycle.archiveAfterDays"));
});

test("validateAppSettings rejects delete_after_days <= archive_after_days", () => {
  const candidate: AppSettings = {
    ...DEFAULT_SETTINGS,
    lifecycle: { freshDays: 3, archiveAfterDays: 7, deleteAfterDays: 7 },
  };
  const errors = validateAppSettings(candidate);
  assert.ok(errors.some((e) => e.path === "lifecycle.deleteAfterDays"));
});

test("validateAppSettings rejects a negative fresh_days", () => {
  const candidate: AppSettings = {
    ...DEFAULT_SETTINGS,
    lifecycle: { freshDays: -1, archiveAfterDays: 7, deleteAfterDays: 10 },
  };
  const errors = validateAppSettings(candidate);
  assert.ok(errors.some((e) => e.path === "lifecycle.freshDays"));
});

test("validateAppSettings enforces scanner min/max bounds", () => {
  const tooLowTimeout: AppSettings = { ...DEFAULT_SETTINGS, scanner: { ...DEFAULT_SETTINGS.scanner, timeoutMs: 10 } };
  assert.ok(validateAppSettings(tooLowTimeout).some((e) => e.path === "scanner.timeoutMs"));

  const tooHighConcurrency: AppSettings = { ...DEFAULT_SETTINGS, scanner: { ...DEFAULT_SETTINGS.scanner, concurrency: 999 } };
  assert.ok(validateAppSettings(tooHighConcurrency).some((e) => e.path === "scanner.concurrency"));

  const zeroAttempts: AppSettings = { ...DEFAULT_SETTINGS, scanner: { ...DEFAULT_SETTINGS.scanner, maxAttempts: 0 } };
  assert.ok(validateAppSettings(zeroAttempts).some((e) => e.path === "scanner.maxAttempts"));
});

test("validateAppSettings rejects max_delay_ms below base_delay_ms", () => {
  const candidate: AppSettings = {
    ...DEFAULT_SETTINGS,
    scanner: { ...DEFAULT_SETTINGS.scanner, baseDelayMs: 500, maxDelayMs: 200 },
  };
  const errors = validateAppSettings(candidate);
  assert.ok(errors.some((e) => e.path === "scanner.maxDelayMs"));
});

test("isSuppressionActive: explicit Not Interested suppression is permanent, even far in the past", () => {
  const now = new Date("2026-08-08T00:00:00Z");
  const suppressedAt = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
  assert.equal(
    isSuppressionActive({ reason: "Not Interested", suppressed_at: suppressedAt }, DEFAULT_SETTINGS.suppression, now),
    true
  );

  const longAgo = new Date(now.getTime() - 5000 * 24 * 60 * 60 * 1000).toISOString(); // ~13.7 years ago
  assert.equal(
    isSuppressionActive({ reason: "Not Interested", suppressed_at: longAgo }, DEFAULT_SETTINGS.suppression, now),
    true,
    "Not Interested must never expire, regardless of elapsed time or Settings"
  );
});

test("isSuppressionActive: a system-generated (aged-out) suppression expires after expired_job_suppression_days", () => {
  const now = new Date("2026-08-08T00:00:00Z");
  const withinWindow = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
  assert.equal(
    isSuppressionActive({ reason: "Aged out: 11 days unapplied", suppressed_at: withinWindow }, DEFAULT_SETTINGS.suppression, now),
    true,
    "30 days is within the default 60-day aged-out suppression window"
  );

  const pastWindow = new Date(now.getTime() - 70 * 24 * 60 * 60 * 1000).toISOString(); // 70 days ago
  assert.equal(
    isSuppressionActive({ reason: "Aged out: 11 days unapplied", suppressed_at: pastWindow }, DEFAULT_SETTINGS.suppression, now),
    false,
    "70 days exceeds the default 60-day aged-out suppression window"
  );
});
