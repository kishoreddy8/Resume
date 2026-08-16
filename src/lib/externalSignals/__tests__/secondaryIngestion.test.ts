import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ExternalHiringObservationRow, NormalizedExternalJob } from "../types";

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let getJob: typeof import("@/db/queries/jobs").getJob;
let listJobs: typeof import("@/db/queries/jobs").listJobs;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let markNotInterested: typeof import("@/db/queries/jobs").markNotInterested;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let getCandidateJobState: typeof import("@/db/queries/candidateJobState").getCandidateJobState;
let stageSecondaryJob: typeof import("../secondaryIngestion").stageSecondaryJob;
let retireSupersededSecondaryJobs: typeof import("../secondaryIngestion").retireSupersededSecondaryJobs;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-external-signals-secondary-ingestion-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ getJob, listJobs, upsertJob, markNotInterested } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ setPipelineStatus, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ stageSecondaryJob, retireSupersededSecondaryJobs } = await import("../secondaryIngestion"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let counter = 0;
function makeCompany(sourceType: "career_link" | "greenhouse" = "career_link") {
  counter++;
  return createCompany({
    name: `Secondary Ingestion Test Co ${counter}`,
    source_type: sourceType,
    ats_board_token: sourceType === "greenhouse" ? `official-token-${counter}` : undefined,
    career_page_url: sourceType === "career_link" ? `https://example${counter}.com` : undefined,
  });
}

function makeObservation(overrides: Partial<ExternalHiringObservationRow> = {}): ExternalHiringObservationRow {
  return {
    id: 1,
    source: "indeed",
    provider_job_id: `job-${counter}`,
    fingerprint: `job-${counter}`,
    observed_employer_name: "Test Co",
    observed_title: "Data Engineer",
    observed_location: "Austin, TX",
    observed_url: "https://www.indeed.com/viewjob?jk=1",
    direct_employer_url: null,
    direct_apply_url: null,
    employer_domain: null,
    posted_at: null,
    matched_company_id: null,
    match_confidence: "DOMAIN",
    employer_relationship: "DIRECT_EMPLOYER",
    url_classification: "DIRECT_ATS",
    detected_ats_provider: null,
    detected_ats_board_token: null,
    signal_classification: "COVERAGE_MISMATCH",
    decision: "SECONDARY_JOB_CANDIDATE",
    resulting_job_id: null,
    evidence_json: "{}",
    status: "ACTIVE",
    first_observed_at: "2026-08-16T00:00:00Z",
    last_observed_at: "2026-08-16T00:00:00Z",
    expires_at: "2026-09-06T00:00:00Z",
    created_at: "2026-08-16T00:00:00Z",
    updated_at: "2026-08-16T00:00:00Z",
    ...overrides,
  };
}

function makeNormalized(overrides: Partial<NormalizedExternalJob> = {}): NormalizedExternalJob {
  return {
    source: "indeed",
    providerJobId: `job-${counter}`,
    employerName: "Test Co",
    title: "Data Engineer",
    location: "Austin, TX",
    description: "Real description",
    postedAt: null,
    listingUrl: "https://www.indeed.com/viewjob?jk=1",
    applyUrl: null,
    directEmployerUrl: null,
    employmentType: "Full-time",
    salaryText: null,
    raw: {},
    ...overrides,
  };
}

// 20. Official source wins — a secondary job never collides with an official job's dedupe_key
test("20. a secondary job's dedupe_key is permanently namespaced (source, company, fingerprint) and never collides with an official ATS dedupe_key for the same company", () => {
  const company = makeCompany("greenhouse");
  const officialKey = dedupeKeyForAts("greenhouse", company.id, "official-req-1");
  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey: officialKey,
    job: { externalId: "official-req-1", title: "Data Engineer", location: "Austin, TX", department: null, url: "https://boards.greenhouse.io/x/1", descriptionHtml: null, descriptionText: "desc", employmentType: null, workplaceType: null, salaryText: null, postedAt: null, raw: null },
    descriptionSections: null, sponsorshipMentioned: false, sponsorshipPolarity: "none", sponsorshipSnippet: null, h1bCombinedConfidence: "Unknown",
  });

  const observation = makeObservation({ matched_company_id: company.id, fingerprint: "secondary-req-1" });
  const result = stageSecondaryJob(observation, makeNormalized(), company.id);

  assert.equal(result.outcome, "inserted");
  assert.notEqual(result.dedupeKey, officialKey);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS c FROM jobs WHERE company_id = ?").get(company.id) as { c: number }).c, 2, "both the official and secondary job must coexist as distinct rows");
});

// 25. Provenance retained
test("25. staging a secondary job marks the observation's resulting_job_id", async () => {
  const company = makeCompany();
  const { upsertExternalHiringObservation } = await import("@/db/queries/externalHiringObservations");
  const observation = upsertExternalHiringObservation({
    source: "indeed", providerJobId: "prov-1", fingerprint: "prov-1", observedEmployerName: "Test Co", observedTitle: "Data Engineer",
    observedLocation: "Austin, TX", observedUrl: "https://indeed.com/x", directEmployerUrl: null, directApplyUrl: null, employerDomain: null,
    postedAt: null, matchedCompanyId: company.id, matchConfidence: "DOMAIN", employerRelationship: "DIRECT_EMPLOYER", urlClassification: "DIRECT_ATS",
    detectedAtsProvider: null, detectedAtsBoardToken: null, signalClassification: "COVERAGE_MISMATCH", decision: "SECONDARY_JOB_CANDIDATE", evidenceJson: "{}",
  });
  const result = stageSecondaryJob(observation, makeNormalized({ providerJobId: "prov-1" }), company.id);

  const { getObservation } = await import("@/db/queries/externalHiringObservations");
  const reread = getObservation(observation.id)!;
  assert.equal(reread.resulting_job_id, result.jobId);
});

// 21. Secondary -> official upgrade
test("21. once a company has a matching-title active official job, retireSupersededSecondaryJobs archives the secondary job (never deletes it)", () => {
  const company = makeCompany("greenhouse");
  const secondaryObservation = makeObservation({ matched_company_id: company.id, fingerprint: "upgrade-test-1" });
  const secondaryResult = stageSecondaryJob(secondaryObservation, makeNormalized({ title: "Data Engineer" }), company.id);
  assert.equal(secondaryResult.outcome, "inserted");

  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey: dedupeKeyForAts("greenhouse", company.id, "official-req-2"),
    job: { externalId: "official-req-2", title: "Data Engineer", location: "Austin, TX", department: null, url: "https://boards.greenhouse.io/x/2", descriptionHtml: null, descriptionText: "desc", employmentType: null, workplaceType: null, salaryText: null, postedAt: null, raw: null },
    descriptionSections: null, sponsorshipMentioned: false, sponsorshipPolarity: "none", sponsorshipSnippet: null, h1bCombinedConfidence: "Unknown",
  });

  const retiredIds = retireSupersededSecondaryJobs(company.id);
  assert.deepEqual(retiredIds, [secondaryResult.jobId]);

  const secondaryJob = getJob(secondaryResult.jobId!)!;
  assert.equal(secondaryJob.is_archived, 1, "the secondary job row must still exist, just archived");
  assert.equal(secondaryJob.archived_reason, "Superseded by official source");
});

// 22. Candidate state preserved during upgrade
test("22. a secondary job with a protected candidate state (Applied) is NOT retired by an official upgrade", () => {
  const company = makeCompany("greenhouse");
  const candidate = createCandidate({ firstName: "Stage7", lastName: "Tester" });
  const secondaryObservation = makeObservation({ matched_company_id: company.id, fingerprint: "protected-upgrade-1" });
  const secondaryResult = stageSecondaryJob(secondaryObservation, makeNormalized({ title: "Protected Role" }), company.id);
  const secondaryJob = getJob(secondaryResult.jobId!)!;
  setPipelineStatus(candidate.id, secondaryJob.dedupe_key, "Applied");

  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey: dedupeKeyForAts("greenhouse", company.id, "official-req-3"),
    job: { externalId: "official-req-3", title: "Protected Role", location: "Austin, TX", department: null, url: "https://boards.greenhouse.io/x/3", descriptionHtml: null, descriptionText: "desc", employmentType: null, workplaceType: null, salaryText: null, postedAt: null, raw: null },
    descriptionSections: null, sponsorshipMentioned: false, sponsorshipPolarity: "none", sponsorshipSnippet: null, h1bCombinedConfidence: "Unknown",
  });

  const retiredIds = retireSupersededSecondaryJobs(company.id);
  assert.deepEqual(retiredIds, [], "a protected (Applied) secondary job must never be archived, even when an official equivalent appears");

  const stillActive = getJob(secondaryResult.jobId!)!;
  assert.equal(stillActive.is_archived, 0);
  const state = getCandidateJobState(candidate.id, secondaryJob.dedupe_key);
  assert.equal(state!.pipeline_status, "Applied", "candidate state must survive untouched");
});

// 23. Suppression respected across sources
test("23. a secondary job previously marked Not Interested does not silently reappear on a repeated observation", () => {
  const company = makeCompany();
  const observation = makeObservation({ matched_company_id: company.id, fingerprint: "suppress-test-1" });
  const first = stageSecondaryJob(observation, makeNormalized({ providerJobId: "suppress-test-1" }), company.id);
  assert.equal(first.outcome, "inserted");
  markNotInterested(first.jobId!);
  assert.equal(getJob(first.jobId!), undefined);

  const second = stageSecondaryJob(observation, makeNormalized({ providerJobId: "suppress-test-1" }), company.id);
  assert.equal(second.outcome, "suppressed");
  assert.equal(listJobs({ companyId: company.id }).length, 0, "the suppressed secondary job must not reappear as a new row");
});

// 24. External disappearance doesn't close an official job — retireSupersededSecondaryJobs never
// touches official-sourced rows at all (it only ever selects source_type IN ('google_jobs','indeed')).
test("24. retireSupersededSecondaryJobs never touches official-sourced jobs, even ones with a matching title", () => {
  const company = makeCompany("greenhouse");
  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey: dedupeKeyForAts("greenhouse", company.id, "official-only-1"),
    job: { externalId: "official-only-1", title: "Official Only Role", location: "Austin, TX", department: null, url: "https://boards.greenhouse.io/x/4", descriptionHtml: null, descriptionText: "desc", employmentType: null, workplaceType: null, salaryText: null, postedAt: null, raw: null },
    descriptionSections: null, sponsorshipMentioned: false, sponsorshipPolarity: "none", sponsorshipSnippet: null, h1bCombinedConfidence: "Unknown",
  });
  const officialJobBefore = listJobs({ companyId: company.id })[0];

  retireSupersededSecondaryJobs(company.id);

  const officialJobAfter = getJob(officialJobBefore.id)!;
  assert.equal(officialJobAfter.is_active, 1);
  assert.equal(officialJobAfter.is_archived, 0);
});

test("retireSupersededSecondaryJobs is a no-op for a company still on career_link (no official ATS source at all)", () => {
  const company = makeCompany("career_link");
  const observation = makeObservation({ matched_company_id: company.id, fingerprint: "no-official-yet" });
  stageSecondaryJob(observation, makeNormalized({ title: "Still Secondary" }), company.id);

  const retired = retireSupersededSecondaryJobs(company.id);
  assert.deepEqual(retired, []);
});
