import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVE_MAX_DAYS,
  ARCHIVE_MAX_DAYS,
  canArchive,
  canDelete,
  FRESH_MAX_DAYS,
  getJobAgeBand,
  getJobAgeDays,
  getJobAgeSource,
  isLifecycleProtected,
  PROTECTED_PIPELINE_STATUSES,
} from "../jobLifecycle";

test("isLifecycleProtected blocks Applied, Interviewing, Offer, Employer Rejected", () => {
  for (const status of ["Applied", "Interviewing", "Offer", "Employer Rejected"] as const) {
    assert.equal(isLifecycleProtected({ pipelineStatus: status, pinned: 0 }), true, status);
    assert.equal(canArchive({ pipelineStatus: status, pinned: 0 }), false, status);
    assert.equal(canDelete({ pipelineStatus: status, pinned: 0 }), false, status);
  }
});

test("isLifecycleProtected allows New/Interested when unpinned", () => {
  for (const status of ["New", "Interested"] as const) {
    assert.equal(isLifecycleProtected({ pipelineStatus: status, pinned: 0 }), false, status);
    assert.equal(canArchive({ pipelineStatus: status, pinned: 0 }), true, status);
    assert.equal(canDelete({ pipelineStatus: status, pinned: 0 }), true, status);
  }
});

test("pinned overrides any pipeline status, including otherwise-unprotected ones", () => {
  assert.equal(isLifecycleProtected({ pipelineStatus: "New", pinned: 1 }), true);
  assert.equal(isLifecycleProtected({ pipelineStatus: "New", pinned: true }), true);
  assert.equal(canArchive({ pipelineStatus: "Interested", pinned: 1 }), false);
  assert.equal(canDelete({ pipelineStatus: "Interested", pinned: 1 }), false);
});

test("PROTECTED_PIPELINE_STATUSES is exactly the four spec'd statuses", () => {
  assert.deepEqual(
    [...PROTECTED_PIPELINE_STATUSES].sort(),
    ["Applied", "Employer Rejected", "Interviewing", "Offer"].sort()
  );
});

test("getJobAgeDays uses posted_at when reliable", () => {
  const now = new Date("2026-08-15T00:00:00Z");
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const job = { posted_at: twoDaysAgo, first_seen_at: "2020-01-01T00:00:00Z" };
  assert.equal(getJobAgeSource(job, now).source, "posted_at");
  assert.equal(getJobAgeDays(job, now), 2);
});

test("getJobAgeDays falls back to first_seen_at when posted_at is missing, unparseable, or future-dated", () => {
  const now = new Date("2026-08-15T00:00:00Z");
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();

  assert.equal(getJobAgeSource({ posted_at: null, first_seen_at: fiveDaysAgo }, now).source, "first_seen_at");
  assert.equal(
    getJobAgeSource({ posted_at: "not-a-date", first_seen_at: fiveDaysAgo }, now).source,
    "first_seen_at"
  );
  const future = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(getJobAgeSource({ posted_at: future, first_seen_at: fiveDaysAgo }, now).source, "first_seen_at");
  assert.equal(getJobAgeDays({ posted_at: null, first_seen_at: fiveDaysAgo }, now), 5);
});

test("getJobAgeDays never uses last_seen_at (not part of the age source at all)", () => {
  // JobAgeInput intentionally has no last_seen_at field — this is a type-level guarantee, not just
  // a behavioral one. Passing an object with an extra last_seen_at field must not affect the result.
  const now = new Date("2026-08-15T00:00:00Z");
  const job = { posted_at: null, first_seen_at: "2026-08-10T00:00:00Z", last_seen_at: "2026-08-14T23:59:00Z" };
  assert.equal(getJobAgeDays(job, now), 5);
});

test("age bands: 2-day Fresh, 5-day Active, 8/10-day aging (archive window), 11-day stale (delete)", () => {
  assert.equal(getJobAgeBand(2), "fresh");
  assert.equal(getJobAgeBand(FRESH_MAX_DAYS), "fresh");
  assert.equal(getJobAgeBand(5), "active");
  assert.equal(getJobAgeBand(ACTIVE_MAX_DAYS), "active");
  assert.equal(getJobAgeBand(8), "aging");
  assert.equal(getJobAgeBand(ARCHIVE_MAX_DAYS), "aging");
  assert.equal(getJobAgeBand(11), "stale");
  assert.equal(getJobAgeBand(365), "stale");
});
