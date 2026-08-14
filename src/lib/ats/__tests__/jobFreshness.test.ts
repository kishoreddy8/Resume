import assert from "node:assert/strict";
import { test } from "node:test";
import { isJobFreshForIngestion, parseAtsDate } from "@/lib/ats/jobFreshness";
import type { NormalizedJob } from "@/types";

function createJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "ext-123",
    title: "Senior Software Engineer",
    location: "Austin, TX, United States",
    department: "Engineering",
    url: "https://example.com/jobs/123",
    descriptionHtml: "<p>Great job.</p>",
    descriptionText: "Great job.",
    employmentType: "Full-time",
    workplaceType: "hybrid",
    salaryText: "$150,000",
    postedAt: null,
    raw: null,
    ...overrides,
  };
}

test("parseAtsDate parses diverse timestamp formats accurately", () => {
  // ISO 8601
  const iso = parseAtsDate("2026-08-01T12:00:00.000Z");
  assert.equal(iso?.toISOString(), "2026-08-01T12:00:00.000Z");

  // YYYY-MM-DD
  const ymd = parseAtsDate("2026-08-01");
  assert.equal(ymd !== null, true);

  // US MM/DD/YYYY (JobDiva format)
  const us = parseAtsDate("08/14/2026");
  assert.equal(us !== null, true);

  // Unix seconds (Eightfold format)
  const unixSec = parseAtsDate(1786665600); // sec
  assert.equal(unixSec !== null, true);

  // Unix milliseconds (Lever format)
  const unixMs = parseAtsDate(1786665600000); // ms
  assert.equal(unixMs !== null, true);

  // Invalid / null
  assert.equal(parseAtsDate(null), null);
  assert.equal(parseAtsDate(""), null);
  assert.equal(parseAtsDate("not-a-date"), null);
});

test("isJobFreshForIngestion evaluates new jobs against the 20-day rule", () => {
  const now = new Date("2026-08-14T12:00:00Z");

  // 0 days old (today)
  const todayJob = createJob({ postedAt: "2026-08-14T08:00:00Z" });
  const eval0 = isJobFreshForIngestion(todayJob, undefined, 20, now);
  assert.equal(eval0.eligible, true);
  assert.equal(eval0.ageDays, 0);

  // 10 days old
  const job10 = createJob({ postedAt: "2026-08-04T12:00:00Z" });
  const eval10 = isJobFreshForIngestion(job10, undefined, 20, now);
  assert.equal(eval10.eligible, true);
  assert.equal(eval10.ageDays, 10);

  // Exactly 20 days old (inclusive boundary)
  const job20 = createJob({ postedAt: "2026-07-25T12:00:00Z" });
  const eval20 = isJobFreshForIngestion(job20, undefined, 20, now);
  assert.equal(eval20.eligible, true);
  assert.equal(eval20.ageDays, 20);

  // 21 days old (stale)
  const job21 = createJob({ postedAt: "2026-07-24T12:00:00Z" });
  const eval21 = isJobFreshForIngestion(job21, undefined, 20, now);
  assert.equal(eval21.eligible, false);
  assert.equal(eval21.ageDays, 21);

  // 60 days old (stale)
  const job60 = createJob({ postedAt: "2026-06-15T00:00:00Z" });
  const eval60 = isJobFreshForIngestion(job60, undefined, 20, now);
  assert.equal(eval60.eligible, false);
  assert.equal(eval60.ageDays, 60);

  // Missing date -> allowed via discovery fallback
  const jobNoDate = createJob({ postedAt: null });
  const evalNoDate = isJobFreshForIngestion(jobNoDate, undefined, 20, now);
  assert.equal(evalNoDate.eligible, true);
  assert.equal(evalNoDate.ageDays, null);

  // Invalid date -> allowed via discovery fallback
  const jobBadDate = createJob({ postedAt: "invalid-date-string" });
  const evalBadDate = isJobFreshForIngestion(jobBadDate, undefined, 20, now);
  assert.equal(evalBadDate.eligible, true);
  assert.equal(evalBadDate.ageDays, null);

  // Future date -> allowed via discovery fallback
  const jobFutureDate = createJob({ postedAt: "2026-09-01T00:00:00Z" });
  const evalFutureDate = isJobFreshForIngestion(jobFutureDate, undefined, 20, now);
  assert.equal(evalFutureDate.eligible, true);
});

test("isJobFreshForIngestion always permits rescan updates of existing database jobs", () => {
  const now = new Date("2026-08-14T12:00:00Z");

  // An existing job that is 90 days old should NOT be dropped during a rescan
  const oldExistingJob = createJob({ postedAt: "2026-05-15T00:00:00Z" });
  const evalExisting = isJobFreshForIngestion(oldExistingJob, { id: 456 }, 20, now);
  assert.equal(evalExisting.eligible, true);
  assert.equal(evalExisting.reason.includes("Existing job in database"), true);
});
