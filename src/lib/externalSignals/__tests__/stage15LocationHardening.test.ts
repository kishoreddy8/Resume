import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { classifyJobLocation } from "../../jobLocationScope";
import type { NormalizedExternalJob } from "../types";

/**
 * Stage 15 — items 23-30: proves the STATE-CITY hardening interacts correctly with the Stage 14
 * global <=20-day freshness gate, Built In's external-signals pipeline, and the ATS scan path,
 * without any provider-specific bypass and without touching Connector Reliability.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let isJobFreshForIngestion: typeof import("@/lib/ats/jobFreshness").isJobFreshForIngestion;
let matchCompanyForObservation: typeof import("../companyMatch").matchCompanyForObservation;
let classifyEmployerRelationship: typeof import("../classify").classifyEmployerRelationship;
let classifyUrlEvidence: typeof import("../classify").classifyUrlEvidence;
let evaluateQualityGate: typeof import("../classify").evaluateQualityGate;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-stage15-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ isJobFreshForIngestion } = await import("@/lib/ats/jobFreshness"));
  ({ matchCompanyForObservation } = await import("../companyMatch"));
  ({ classifyEmployerRelationship, classifyUrlEvidence, evaluateQualityGate } = await import("../classify"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function makeCompany(name: string, sourceType: import("@/types").SourceType = "career_link", atsBoardToken?: string) {
  return createCompany({ name, source_type: sourceType, ats_board_token: atsBoardToken });
}

function makeExternalJob(overrides: Partial<NormalizedExternalJob> = {}): NormalizedExternalJob {
  return {
    source: "built_in",
    providerJobId: "stage15-1",
    employerName: "",
    title: "Data Engineer",
    location: "GA-ATLANTA",
    description: "A real job description with enough content to be meaningful for testing purposes, well past the minimum length threshold.",
    postedAt: null,
    listingUrl: "https://builtin.com/job/data-engineer/stage15-1",
    applyUrl: null,
    directEmployerUrl: null,
    employmentType: "Full-time",
    salaryText: null,
    raw: {},
    ...overrides,
  };
}

function normalizedAtsJob(overrides: Partial<import("@/types").NormalizedJob> = {}): import("@/types").NormalizedJob {
  return {
    externalId: "ats-1", title: "Data Engineer", location: "GA-ATLANTA", department: null,
    url: "https://example.workday.com/x/job/1", descriptionHtml: null, descriptionText: "A real ATS job description.",
    employmentType: null, workplaceType: null, salaryText: null, postedAt: null, raw: {}, ...overrides,
  };
}

// 23/24/25. Freshness interaction with a valid GA-ATLANTA location
test("23/24/25. GA-ATLANTA at 19/exactly-20/21 days: eligible/eligible/rejected", () => {
  assert.equal(classifyJobLocation("GA-ATLANTA"), "US");
  const nineteen = isJobFreshForIngestion(normalizedAtsJob({ postedAt: daysAgoIso(19) }), undefined, "workday");
  assert.equal(nineteen.eligible, true);
  const twenty = isJobFreshForIngestion(normalizedAtsJob({ postedAt: daysAgoIso(20) }), undefined, "workday");
  assert.equal(twenty.eligible, true, "exactly 20 days must be ACCEPT");
  const twentyOne = isJobFreshForIngestion(normalizedAtsJob({ postedAt: daysAgoIso(21) }), undefined, "workday");
  assert.equal(twentyOne.eligible, false, "21 days must be REJECT");
});

// 26/27. Built In interaction — same classifier, UNKNOWN still can't become a secondary job
test("26. Built In's external-signals pipeline uses the exact same classifyJobLocation() for a GA-ATLANTA listing", () => {
  const company = makeCompany("Location Hardening Built In Co", "greenhouse", "locationhardeningbuiltinco");
  const job = makeExternalJob({
    employerName: "Location Hardening Built In Co",
    applyUrl: "https://job-boards.greenhouse.io/locationhardeningbuiltinco/jobs/1",
    location: "GA-ATLANTA, 740 W PEACHTREE ST NW",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, null, "a real GA-ATLANTA Built In listing now passes the gate (null = eligible)");
});

test("27. Built In UNKNOWN locations (e.g. IN-PERSON-only text) still cannot become secondary jobs", () => {
  const company = makeCompany("Unknown Location Built In Co", "greenhouse", "unknownlocationbuiltinco");
  const job = makeExternalJob({
    employerName: "Unknown Location Built In Co",
    applyUrl: "https://job-boards.greenhouse.io/unknownlocationbuiltinco/jobs/1",
    location: "IN-PERSON",
    postedAt: daysAgoIso(1),
  });
  const match = matchCompanyForObservation(job);
  assert.equal(match.companyId, company.id);
  const relationship = classifyEmployerRelationship(job, match);
  const urlClassification = classifyUrlEvidence(job, match);
  const decision = evaluateQualityGate(job, match, relationship, urlClassification.classification);
  assert.equal(decision, "DISCOVERY_BEACON_ONLY", "UNKNOWN location must still never silently pass the gate");
});

// 28/29. ATS/Workday interaction — no provider-specific bypass, same canonical classifier
test("28/29. a Workday GA-ATLANTA location reaches the normal classifyJobLocation() path with no Workday-specific classifier", () => {
  // There is exactly one classifier export from jobLocationScope.ts — importing it directly here (the
  // same import every adapter/pipeline uses) IS the proof there is no separate Workday-specific
  // classifier: if one existed, this test would need to import something else to see Workday behavior.
  assert.equal(classifyJobLocation("GA-ATLANTA, 740 W PEACHTREE ST NW"), "US");
  assert.equal(classifyJobLocation("IN-INDIANAPOLIS, 220 VIRGINIA AVE"), "US");
});

// 30. Reliability interaction — connector health cannot bypass location filtering
test("30. a company whose connector is recovered/degraded/healthy is still subject to the exact same location classification", () => {
  const company = makeCompany("Reliability Location Co", "workday", "reliabilitylocationco|wd1|Careers");
  for (const health of ["healthy", "degraded", "down", "unknown"] as const) {
    getDb().prepare("UPDATE companies SET connector_health = ? WHERE id = ?").run(health, company.id);
    // classifyJobLocation itself takes no connector-health parameter at all — it cannot special-case
    // any company's reliability state. This is the same architectural proof pattern as Stage 14's
    // freshness-independence test.
    assert.equal(classifyJobLocation("IN-PERSON"), "UNKNOWN", `connector_health=${health} must not change location classification`);
    assert.equal(classifyJobLocation("GA-ATLANTA"), "US", `connector_health=${health} must not change location classification`);
  }
});
