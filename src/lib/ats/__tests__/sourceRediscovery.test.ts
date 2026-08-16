import assert from "node:assert/strict";
import { test } from "node:test";
import { attemptSourceRediscovery } from "../sourceRediscovery";
import type { DiscoveryResult } from "../discovery";
import type { Company, NormalizedJob } from "../../../types";

/**
 * ATS Source Self-Healing, Stage 2 — attemptSourceRediscovery is a pure function of its injected
 * discoverer/fetcher (see AttemptSourceRediscoveryOptions), so these tests need no temp DB, no
 * filesystem, and no live network — every scenario is a deterministic mock, matching the task's
 * "isolated DB/filesystem/network fixtures" requirement trivially.
 */

let nextId = 1;
function makeCompany(overrides: Partial<Company> = {}): Company {
  const id = nextId++;
  return {
    id,
    name: `Test Co ${id}`,
    source_type: "greenhouse",
    ats_board_token: "old-token",
    career_page_url: null,
    is_active: 1,
    notes: null,
    h1b_match_employer_name: null,
    h1b_match_normalized: null,
    h1b_match_tier: null,
    h1b_match_score: null,
    h1b_confidence: "Unknown",
    h1b_lca_count: 0,
    h1b_latest_fiscal_year: null,
    h1b_confidence_evidence: null,
    h1b_updated_at: null,
    last_scanned_at: null,
    last_scan_status: null,
    last_scan_error: null,
    last_successful_scan_at: null,
    last_failed_scan_at: null,
    consecutive_failures: 2,
    last_error_category: "invalid_config",
    last_error_message: "404",
    connector_health: "degraded",
    resolution_status: "VERIFIED",
    discovered_jobs_url: null,
    discovery_attempted_at: null,
    discovery_reason: null,
    suspected_ats: null,
    verified_domain: null,
    domain_identity_status: "UNRESOLVED",
    last_successful_discovery_at: null,
    last_rediscovery_attempted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "job-1",
    title: "Software Engineer",
    location: "Austin, TX",
    department: null,
    url: "https://job-boards.greenhouse.io/newco/jobs/1",
    descriptionHtml: "<p>desc</p>",
    descriptionText: "desc",
    employmentType: null,
    workplaceType: null,
    salaryText: null,
    postedAt: null,
    raw: {},
    ...overrides,
  };
}

/** Builds the exact URL detectAtsFromUrlString would itself produce for (sourceType, token), so a
 *  mocked DiscoveryResult is self-consistent the same way a REAL discoverCompanySource result always
 *  is (see attemptSourceRediscovery's companyIdentityConfirmed check, which relies on exactly this
 *  round-trip). Only covers greenhouse/workday — the two providers these fixtures use. */
function selfConsistentUrl(sourceType: string, token: string): string {
  if (sourceType === "workday") {
    const [tenant, host, site] = token.split("|");
    return `https://${tenant}.${host}.myworkdayjobs.com/${site}`;
  }
  return `https://job-boards.greenhouse.io/${token}`;
}

function verifiedResult(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
  const sourceType = overrides.sourceType ?? "greenhouse";
  const atsBoardToken = overrides.atsBoardToken ?? "new-token";
  return {
    status: "VERIFIED",
    sourceType,
    atsBoardToken,
    discoveredJobsUrl: selfConsistentUrl(sourceType, atsBoardToken),
    reason: "Direct ATS URL match",
    suspectedAts: null,
    ...overrides,
  };
}

test("2+ invalid_config failures with a same-provider replacement that validates -> HIGH / AUTO_REPLACE_CANDIDATE", async () => {
  const company = makeCompany();
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult(),
    fetcher: async () => [makeJob()],
  });
  assert.equal(result.confidence, "HIGH");
  assert.equal(result.recommendedAction, "AUTO_REPLACE_CANDIDATE");
  assert.equal(result.confidenceInputs.sameProvider, true);
  assert.equal(result.confidenceInputs.crossProviderMigration, false);
});

test("valid cross-provider migration -> MEDIUM / NEEDS_SOURCE_REVIEW, not silently HIGH", async () => {
  const company = makeCompany({ source_type: "greenhouse", ats_board_token: "old-token" });
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult({ sourceType: "workday", atsBoardToken: "tenant|wd1|External" }),
    fetcher: async () => [makeJob()],
  });
  assert.equal(result.providerChanged, true);
  assert.equal(result.confidenceInputs.crossProviderMigration, true);
  assert.equal(result.confidence, "MEDIUM", "a cross-provider migration is real positive evidence but must never rank as strong as an exact same-provider correction");
  assert.equal(result.recommendedAction, "NEEDS_SOURCE_REVIEW", "MEDIUM confidence must require human review, never auto-replace");
});

test("ambiguous candidate that fails validation -> LOW / NEEDS_SOURCE_REVIEW", async () => {
  const company = makeCompany();
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult(),
    fetcher: async () => [makeJob({ location: "Berlin, Germany" })], // fails validateJobSample's US-only check
  });
  assert.equal(result.validationOutcome, "FAILED");
  assert.equal(result.confidence, "LOW");
  assert.equal(result.recommendedAction, "NEEDS_SOURCE_REVIEW");
});

test("rediscovery independently returns the exact current source -> CURRENT_SOURCE_STILL_VALID", async () => {
  const company = makeCompany({ source_type: "greenhouse", ats_board_token: "old-token" });
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult({ sourceType: "greenhouse", atsBoardToken: "old-token" }),
    fetcher: async () => { throw new Error("must not be called when the candidate is the same as current"); },
  });
  assert.equal(result.sameAsCurrent, true);
  assert.equal(result.recommendedAction, "CURRENT_SOURCE_STILL_VALID");
  assert.equal(result.validationOutcome, "NOT_ATTEMPTED", "no point validating a source that's already active and already failing");
});

test("discovery surfaces an SSRF-blocked redirect -> SECURITY_REJECTION, never treated as a normal miss", async () => {
  const company = makeCompany({ career_page_url: "https://example.com/careers" });
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => ({
      status: "UNRESOLVED",
      sourceType: null,
      atsBoardToken: null,
      discoveredJobsUrl: null,
      reason: "Could not reach https://example.com/careers/redirect: Disallowed host: 169.254.169.254",
      suspectedAts: null,
    }),
  });
  assert.equal(result.confidenceInputs.unsafeRedirect, true);
  assert.equal(result.recommendedAction, "SECURITY_REJECTION");
});

test("no source found anywhere -> NO_REPLACEMENT_FOUND, never fabricated", async () => {
  const company = makeCompany({ career_page_url: "https://example.com/careers" });
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => ({
      status: "UNRESOLVED",
      sourceType: null,
      atsBoardToken: null,
      discoveredJobsUrl: null,
      reason: "Fetched https://example.com/careers but found no ATS link or careers/jobs page within the discovery bounds",
      suspectedAts: null,
    }),
  });
  assert.equal(result.candidateSource, null);
  assert.equal(result.recommendedAction, "NO_REPLACEMENT_FOUND");
});

test("no active-source fields on the input Company object are mutated", async () => {
  const company = makeCompany({ source_type: "greenhouse", ats_board_token: "old-token" });
  const snapshot = { ...company };
  await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult({ sourceType: "workday", atsBoardToken: "tenant|wd1|External" }),
    fetcher: async () => [makeJob()],
  });
  assert.deepEqual(company, snapshot, "attemptSourceRediscovery must never mutate the Company object it was given");
});

test("candidate/company isolation: the fetcher is called with an ephemeral object carrying the CANDIDATE's identity, never the real company's broken current source", async () => {
  const company = makeCompany({ source_type: "greenhouse", ats_board_token: "broken-old-token" });
  let fetcherSawSourceType: string | null = null;
  let fetcherSawToken: string | null = null;
  await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult({ sourceType: "workday", atsBoardToken: "tenant|wd1|NewSite" }),
    fetcher: async (candidateCompany) => {
      fetcherSawSourceType = candidateCompany.source_type;
      fetcherSawToken = candidateCompany.ats_board_token;
      return [makeJob()];
    },
  });
  assert.equal(fetcherSawSourceType, "workday");
  assert.equal(fetcherSawToken, "tenant|wd1|NewSite");
  assert.notEqual(fetcherSawToken, company.ats_board_token, "must never validate against the company's own still-broken current token");
});

test("repeated shadow runs are idempotent with respect to production state: two consecutive calls against the same unchanged company produce the same recommendation and neither mutates the input", async () => {
  const company = makeCompany({ source_type: "greenhouse", ats_board_token: "old-token" });
  const snapshot = { ...company };
  const discoverer = async () => verifiedResult();
  const fetcher = async () => [makeJob()];
  const first = await attemptSourceRediscovery(company, { discoverer, fetcher });
  const second = await attemptSourceRediscovery(company, { discoverer, fetcher });
  assert.equal(first.recommendedAction, second.recommendedAction);
  assert.equal(first.confidence, second.confidence);
  assert.deepEqual(company, snapshot, "neither run may have mutated the company between calls");
});

test("a company with no career_page_url and an unreconstructable source is NO_REPLACEMENT_FOUND without ever calling discovery", async () => {
  const company = makeCompany({ source_type: "career_link", ats_board_token: null, career_page_url: null });
  let discovererCalled = false;
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => { discovererCalled = true; return verifiedResult(); },
  });
  assert.equal(discovererCalled, false);
  assert.equal(result.discoveryOutcome, "NO_INPUT_URL");
  assert.equal(result.recommendedAction, "NO_REPLACEMENT_FOUND");
});

test("a clean zero-job board (structurally valid, currently empty) validates and ranks MEDIUM, not disqualified merely for having zero jobs", async () => {
  const company = makeCompany({ source_type: "greenhouse", ats_board_token: "old-token" });
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult({ sourceType: "workday", atsBoardToken: "tenant|wd1|External" }),
    fetcher: async () => [],
  });
  assert.equal(result.confidenceInputs.zeroJobValidBoard, true);
  assert.equal(result.validationOutcome, "PASSED");
  assert.equal(result.confidence, "MEDIUM");
});

// --- Step 11: historical regression fixtures (deterministic acceptance cases) -------------------
// Real production cases this exact mechanism is meant to catch — each reproduced as a scripted
// discoverer/fetcher pair rather than a live network call, per the isolated-fixtures requirement.

test("historical fixture — Inovalon: greenhouse embed URL resolves to the real board token, same provider -> HIGH", async () => {
  const company = makeCompany({ source_type: "greenhouse", ats_board_token: "inovalon-embed-stale", career_page_url: "https://inovalon.com/careers" });
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult({ sourceType: "greenhouse", atsBoardToken: "inovalon", reason: "Found an embedded greenhouse link" }),
    fetcher: async () => [makeJob()],
  });
  assert.equal(result.confidence, "HIGH");
  assert.equal(result.recommendedAction, "AUTO_REPLACE_CANDIDATE");
});

test("historical fixture — Fetch: greenhouse token 'fetchrewards' corrected to 'fetch', same provider -> HIGH", async () => {
  const company = makeCompany({ source_type: "greenhouse", ats_board_token: "fetchrewards", career_page_url: "https://fetch.com/careers" });
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult({ sourceType: "greenhouse", atsBoardToken: "fetch" }),
    fetcher: async () => [makeJob()],
  });
  assert.equal(result.confidence, "HIGH");
  assert.equal(result.recommendedAction, "AUTO_REPLACE_CANDIDATE");
});

test("historical fixture — Gilead: malformed Workday token corrected to a valid one, same provider -> HIGH", async () => {
  const company = makeCompany({ source_type: "workday", ats_board_token: "gilead|wd1|gileadcareers", career_page_url: "https://gilead.com/careers" });
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult({ sourceType: "workday", atsBoardToken: "gilead|wd1|gileadcareers-corrected" }),
    fetcher: async () => [makeJob()],
  });
  assert.equal(result.confidence, "HIGH");
  assert.equal(result.recommendedAction, "AUTO_REPLACE_CANDIDATE");
});

test("historical fixture — Chegg: 'osv-chegg' Workday tenant corrected to 'chegg', same provider -> HIGH", async () => {
  const company = makeCompany({ source_type: "workday", ats_board_token: "osv-chegg|wd5|Chegg", career_page_url: "https://chegg.com/careers" });
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult({ sourceType: "workday", atsBoardToken: "chegg|wd5|Chegg" }),
    fetcher: async () => [makeJob()],
  });
  assert.equal(result.confidence, "HIGH");
  assert.equal(result.recommendedAction, "AUTO_REPLACE_CANDIDATE");
});

test("historical fixture — Dynata: old Workday site redirects to Dynata_Careers, same provider -> HIGH", async () => {
  const company = makeCompany({ source_type: "workday", ats_board_token: "dynata|wd1|careers", career_page_url: "https://dynata.com/careers" });
  const result = await attemptSourceRediscovery(company, {
    discoverer: async () => verifiedResult({ sourceType: "workday", atsBoardToken: "dynata|wd1|Dynata_Careers", reason: "Final URL after redirects is a known ATS (workday)" }),
    fetcher: async () => [makeJob()],
  });
  assert.equal(result.confidence, "HIGH");
  assert.equal(result.recommendedAction, "AUTO_REPLACE_CANDIDATE");
});

test("historical fixture — Edgile: old Greenhouse migrated to a parent-company source (cross-provider) -> MEDIUM, never silently HIGH", async () => {
  const company = makeCompany({ source_type: "greenhouse", ats_board_token: "edgile", career_page_url: "https://edgile.com/careers" });
  const result = await attemptSourceRediscovery(company, {
    // Edgile was acquired; its careers page now routes to the parent's Workday board — a genuine
    // provider change, not a same-provider token correction.
    discoverer: async () => verifiedResult({ sourceType: "workday", atsBoardToken: "wipro|wd3|EdgileCareers" }),
    fetcher: async () => [makeJob()],
  });
  assert.equal(result.providerChanged, true);
  assert.equal(result.confidence, "MEDIUM", "a parent-company/cross-provider migration must not be silently ranked HIGH without an explicit rule supporting it");
  assert.equal(result.recommendedAction, "NEEDS_SOURCE_REVIEW");
});
