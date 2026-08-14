import assert from "node:assert/strict";
import { test } from "node:test";
import { getProviderDateType, isJobFreshForIngestion, parseAtsDate } from "@/lib/ats/jobFreshness";
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

test("getProviderDateType maps providers to semantic date types correctly", () => {
  assert.equal(getProviderDateType("greenhouse"), "UPDATED");
  assert.equal(getProviderDateType("comeet"), "UPDATED");
  assert.equal(getProviderDateType("lever"), "CREATED");
  assert.equal(getProviderDateType("rippling"), "CREATED");
  assert.equal(getProviderDateType("eightfold"), "CREATED");
  assert.equal(getProviderDateType("ashby"), "PUBLISHED");
  assert.equal(getProviderDateType("workable"), "PUBLISHED");
  assert.equal(getProviderDateType("teamtailor"), "PUBLISHED");
  assert.equal(getProviderDateType("smartrecruiters"), "PUBLISHED");
  assert.equal(getProviderDateType("paylocity"), "PUBLISHED");
  assert.equal(getProviderDateType("workday"), "POSTED");
  assert.equal(getProviderDateType("icims"), "POSTED");
  assert.equal(getProviderDateType("adp_wfn"), "POSTED");
  assert.equal(getProviderDateType("jobvite"), "POSTED");
  assert.equal(getProviderDateType("clearcompany"), "FIRST_SEEN");
  assert.equal(getProviderDateType("career_link"), "FIRST_SEEN");
});

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

test("isJobFreshForIngestion generates complete provenance across semantic types", () => {
  const now = new Date("2026-08-14T12:00:00Z");

  // 1. POSTED (1 day old) -> HIGH confidence fresh
  const postedJob = createJob({ postedAt: "2026-08-13T12:00:00Z" });
  const evalPosted = isJobFreshForIngestion(postedJob, undefined, "workday", 20, now);
  assert.equal(evalPosted.eligible, true);
  assert.equal(evalPosted.provenance.dateType, "POSTED");
  assert.equal(evalPosted.provenance.confidence, "HIGH");
  assert.equal(evalPosted.provenance.ageDays, 1);

  // 2. PUBLISHED (19 days old) -> HIGH confidence fresh
  const pubJob = createJob({ postedAt: "2026-07-26T12:00:00Z" });
  const evalPub = isJobFreshForIngestion(pubJob, undefined, "ashby", 20, now);
  assert.equal(evalPub.eligible, true);
  assert.equal(evalPub.provenance.dateType, "PUBLISHED");
  assert.equal(evalPub.provenance.confidence, "HIGH");
  assert.equal(evalPub.provenance.ageDays, 19);

  // 3. CREATED (20 days old exact boundary) -> MEDIUM confidence fresh
  const createdJob = createJob({ postedAt: "2026-07-25T12:00:00Z" });
  const evalCreated = isJobFreshForIngestion(createdJob, undefined, "lever", 20, now);
  assert.equal(evalCreated.eligible, true);
  assert.equal(evalCreated.provenance.dateType, "CREATED");
  assert.equal(evalCreated.provenance.confidence, "MEDIUM");
  assert.equal(evalCreated.provenance.ageDays, 20);

  // 4. UPDATED (2 days old on Greenhouse) -> MEDIUM confidence fresh
  const updatedJob = createJob({ postedAt: "2026-08-12T12:00:00Z" });
  const evalUpdated = isJobFreshForIngestion(updatedJob, undefined, "greenhouse", 20, now);
  assert.equal(evalUpdated.eligible, true);
  assert.equal(evalUpdated.provenance.dateType, "UPDATED");
  assert.equal(evalUpdated.provenance.confidence, "MEDIUM");
  assert.equal(evalUpdated.provenance.ageDays, 2);

  // 5. Stale (> 20 days on Greenhouse updated_at) -> correctly rejected
  const staleUpdatedJob = createJob({ postedAt: "2026-06-01T12:00:00Z" });
  const evalStaleUpdated = isJobFreshForIngestion(staleUpdatedJob, undefined, "greenhouse", 20, now);
  assert.equal(evalStaleUpdated.eligible, false);
  assert.equal(evalStaleUpdated.provenance.dateType, "UPDATED");
  assert.equal(evalStaleUpdated.provenance.ageDays! > 20, true);

  // 6. Missing provider date -> FIRST_SEEN fallback, LOW confidence
  const noDateJob = createJob({ postedAt: null });
  const evalNoDate = isJobFreshForIngestion(noDateJob, undefined, "clearcompany", 20, now);
  assert.equal(evalNoDate.eligible, true);
  assert.equal(evalNoDate.provenance.dateType, "FIRST_SEEN");
  assert.equal(evalNoDate.provenance.confidence, "LOW");
  assert.equal(evalNoDate.provenance.rawDate, null);

  // 7. Invalid date -> UNKNOWN fallback, NONE confidence
  const badDateJob = createJob({ postedAt: "malformed-string" });
  const evalBadDate = isJobFreshForIngestion(badDateJob, undefined, "workday", 20, now);
  assert.equal(evalBadDate.eligible, true);
  assert.equal(evalBadDate.provenance.dateType, "UNKNOWN");
  assert.equal(evalBadDate.provenance.confidence, "NONE");

  // 8. Future date (> 24h ahead) -> UNKNOWN fallback, NONE confidence
  const futureJob = createJob({ postedAt: "2026-09-01T00:00:00Z" });
  const evalFuture = isJobFreshForIngestion(futureJob, undefined, "workday", 20, now);
  assert.equal(evalFuture.eligible, true);
  assert.equal(evalFuture.provenance.dateType, "UNKNOWN");
  assert.equal(evalFuture.provenance.confidence, "NONE");

  // 9. Timezone drift (+12h ahead within 24h) -> age 0 days, HIGH confidence
  const timezoneDriftJob = createJob({ postedAt: "2026-08-14T20:00:00Z" });
  const evalDrift = isJobFreshForIngestion(timezoneDriftJob, undefined, "workday", 20, now);
  assert.equal(evalDrift.eligible, true);
  assert.equal(evalDrift.provenance.ageDays, 0);
  assert.equal(evalDrift.provenance.confidence, "HIGH");

  // 10. Existing job in database (90 days old) -> rescan bypass, HIGH confidence
  const existingStaleJob = createJob({ postedAt: "2026-05-01T00:00:00Z" });
  const evalExisting = isJobFreshForIngestion(existingStaleJob, { id: 999 }, "workday", 20, now);
  assert.equal(evalExisting.eligible, true);
  assert.equal(evalExisting.reason.includes("Existing job in database"), true);
});
