import assert from "node:assert/strict";
import { test } from "node:test";
import { canRunLifecycleActions, determineScanStatus, hasContentChanged } from "@/lib/scan/status";
import type { Job, NormalizedJob } from "@/types";

/**
 * src/lib/scan/status.ts had no dedicated test file despite encoding a safety-critical rule
 * ("partial or career_link scans must never close/archive/delete jobs" — see canRunLifecycleActions'
 * own doc comment) and the jobs_updated/jobs_unchanged split (hasContentChanged) used by scan_runs.
 */

// --- determineScanStatus --------------------------------------------------------------------------

test("determineScanStatus: zero description failures -> success", () => {
  assert.equal(determineScanStatus(0), "success");
});

test("determineScanStatus: any description failure -> partial", () => {
  assert.equal(determineScanStatus(1), "partial");
  assert.equal(determineScanStatus(5), "partial");
});

// --- canRunLifecycleActions -----------------------------------------------------------------------

test("canRunLifecycleActions: career_link is NEVER authoritative, regardless of scan status", () => {
  assert.equal(canRunLifecycleActions("success", "career_link"), false);
  assert.equal(canRunLifecycleActions("partial", "career_link"), false);
  assert.equal(canRunLifecycleActions("failed", "career_link"), false);
});

test("canRunLifecycleActions: a real ATS board may only act on a fully successful scan", () => {
  assert.equal(canRunLifecycleActions("success", "greenhouse"), true);
  assert.equal(canRunLifecycleActions("success", "workday"), true);
  assert.equal(canRunLifecycleActions("success", "lever"), true);
  assert.equal(canRunLifecycleActions("success", "ashby"), true);
});

test("canRunLifecycleActions: partial or failed ATS scans must never close/archive/delete jobs", () => {
  assert.equal(canRunLifecycleActions("partial", "greenhouse"), false);
  assert.equal(canRunLifecycleActions("failed", "greenhouse"), false);
});

// --- hasContentChanged -----------------------------------------------------------------------------

function baseJob(overrides: Partial<Job> = {}): Job {
  return {
    title: "Data Engineer",
    location: "Remote",
    department: null,
    url: "https://example.com/jobs/1",
    description_html: "<p>desc</p>",
    description_text: "desc",
    employment_type: "Full-time",
    workplace_type: "Remote",
    salary_text: null,
    posted_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as unknown as Job;
}

function normalizedFrom(job: Job, overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: null,
    title: job.title,
    location: job.location,
    department: job.department,
    url: job.url,
    descriptionHtml: job.description_html,
    descriptionText: job.description_text,
    employmentType: job.employment_type,
    workplaceType: job.workplace_type,
    salaryText: job.salary_text,
    postedAt: job.posted_at,
    raw: {},
    ...overrides,
  };
}

test("hasContentChanged: identical incoming job -> false (a plain re-seen, unchanged scan)", () => {
  const before = baseJob();
  assert.equal(hasContentChanged(before, normalizedFrom(before)), false);
});

test("hasContentChanged: a genuinely edited title is detected", () => {
  const before = baseJob();
  assert.equal(hasContentChanged(before, normalizedFrom(before, { title: "Senior Data Engineer" })), true);
});

test("hasContentChanged: a genuinely edited description is detected", () => {
  const before = baseJob();
  assert.equal(hasContentChanged(before, normalizedFrom(before, { descriptionText: "new description" })), true);
});

test("hasContentChanged: a changed posted_at (e.g. a Greenhouse board's updated_at moving) is detected", () => {
  const before = baseJob();
  assert.equal(hasContentChanged(before, normalizedFrom(before, { postedAt: "2026-08-05T00:00:00.000Z" })), true);
});
