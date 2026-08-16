import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprintFor, normalizeGoogleJobsResult, normalizeIndeedResult } from "../normalize";
import { FIXTURE_GOOGLE_JOBS_RESULTS, FIXTURE_INDEED_RESULTS } from "../fixtures";

// 1. Google normalization
test("1. Google Jobs raw result normalizes into NormalizedExternalJob with the real confirmed field shape", () => {
  const normalized = normalizeGoogleJobsResult(FIXTURE_GOOGLE_JOBS_RESULTS[0]);
  assert.equal(normalized.source, "google_jobs");
  assert.equal(normalized.providerJobId, "fixture-google-001");
  assert.equal(normalized.employerName, "Acme Robotics, Inc.");
  assert.equal(normalized.title, "Senior Data Engineer");
  assert.equal(normalized.location, "Austin, TX");
  assert.equal(normalized.directEmployerUrl, "https://boards.greenhouse.io/acmerobotics/jobs/9988776");
  assert.equal(normalized.employmentType, "Full-time");
});

test("Google normalization prefers a non-aggregator apply_options entry over a known aggregator one", () => {
  const raw = {
    ...FIXTURE_GOOGLE_JOBS_RESULTS[0],
    apply_options: [
      { title: "LinkedIn", link: "https://www.linkedin.com/jobs/view/1" },
      { title: "Acme Robotics", link: "https://boards.greenhouse.io/acmerobotics/jobs/9988776" },
    ],
  };
  const normalized = normalizeGoogleJobsResult(raw);
  assert.equal(normalized.directEmployerUrl, "https://boards.greenhouse.io/acmerobotics/jobs/9988776");
});

// 2. Indeed normalization
test("2. Indeed raw result normalizes into NormalizedExternalJob with the real confirmed field shape", () => {
  const normalized = normalizeIndeedResult(FIXTURE_INDEED_RESULTS[0]);
  assert.equal(normalized.source, "indeed");
  assert.equal(normalized.providerJobId, "fixture-indeed-001");
  assert.equal(normalized.employerName, "Acme Robotics, Inc.");
  assert.equal(normalized.location, "Austin, TX");
  assert.equal(normalized.applyUrl, "https://boards.greenhouse.io/acmerobotics/jobs/9988776");
  assert.equal(normalized.salaryText, "$140,000 - $180,000 a year");
  assert.equal(normalized.employmentType, "Full-time");
});

// 3. Provider-specific IDs
test("3. providerJobId is preserved distinctly per source (jobKey for Indeed, job_id for Google)", () => {
  const indeed = normalizeIndeedResult(FIXTURE_INDEED_RESULTS[1]);
  const google = normalizeGoogleJobsResult(FIXTURE_GOOGLE_JOBS_RESULTS[1]);
  assert.equal(indeed.providerJobId, "fixture-indeed-002");
  assert.equal(google.providerJobId, "fixture-google-002");
  assert.notEqual(indeed.providerJobId, google.providerJobId);
});

test("12/13. fingerprint uses providerJobId when available", () => {
  const normalized = normalizeIndeedResult(FIXTURE_INDEED_RESULTS[0]);
  assert.equal(fingerprintFor(normalized), "fixture-indeed-001");
});

test("fingerprint falls back to a deterministic hash when providerJobId is absent, and is stable across repeated calls", () => {
  const job = {
    source: "indeed" as const,
    providerJobId: null,
    employerName: "Acme Robotics, Inc.",
    title: "Data Engineer",
    location: "Austin, TX",
    listingUrl: "https://example.com/job/1",
  };
  const a = fingerprintFor(job);
  const b = fingerprintFor(job);
  assert.equal(a, b);
  assert.ok(a.length > 0);
});
