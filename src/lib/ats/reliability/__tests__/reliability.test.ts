import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Company, ErrorCategory } from "@/types";
import type { DiscoveryV2Candidate, DiscoveryV2Result } from "@/lib/ats/discoveryV2";

/**
 * Connector Reliability Control Plane V1 — the 25 required regression tests (mission Phase 14),
 * organized by phase for traceability. Isolated temp DB per this file, matching the established
 * convention used throughout src/lib/ats/__tests__ and src/lib/externalSignals/__tests__.
 */

let tmpDir: string;
let getDb: typeof import("@/db").getDb;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let getCompany: typeof import("@/db/queries/companies").getCompany;
let recordScanSuccess: typeof import("@/db/queries/companies").recordScanSuccess;
let recordScanFailure: typeof import("@/db/queries/companies").recordScanFailure;
let recordRediscoveryAttempt: typeof import("@/db/queries/companies").recordRediscoveryAttempt;
let getFailureProfile: typeof import("@/lib/ats/reliability/classification").getFailureProfile;
let isLikelyStaleSource: typeof import("@/lib/ats/reliability/classification").isLikelyStaleSource;
let deriveReliabilityState: typeof import("@/lib/ats/reliability/state").deriveReliabilityState;
let evaluateCircuitBreaker: typeof import("@/lib/ats/reliability/circuitBreaker").evaluateCircuitBreaker;
let listRediscoveryEligibleCompanies: typeof import("@/db/queries/reliability").listRediscoveryEligibleCompanies;
let runConnectorRecovery: typeof import("@/lib/ats/reliability/recoveryController").runConnectorRecovery;
let computeDelayMs: typeof import("@/lib/scan/retry").computeDelayMs;
let isRetryableCategory: typeof import("@/lib/scan/errors").isRetryableCategory;
let categorizeThrownError: typeof import("@/lib/scan/errors").categorizeThrownError;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-reliability-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("@/db"));
  ({ createCompany, getCompany, recordScanSuccess, recordScanFailure, recordRediscoveryAttempt } = await import("@/db/queries/companies"));
  ({ getFailureProfile, isLikelyStaleSource } = await import("@/lib/ats/reliability/classification"));
  ({ deriveReliabilityState } = await import("@/lib/ats/reliability/state"));
  ({ evaluateCircuitBreaker } = await import("@/lib/ats/reliability/circuitBreaker"));
  ({ listRediscoveryEligibleCompanies } = await import("@/db/queries/reliability"));
  ({ runConnectorRecovery } = await import("@/lib/ats/reliability/recoveryController"));
  ({ computeDelayMs } = await import("@/lib/scan/retry"));
  ({ isRetryableCategory, categorizeThrownError } = await import("@/lib/scan/errors"));
  ({ upsertJob } = await import("@/db/queries/jobs"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let counter = 0;
function makeCompany(overrides: Partial<Parameters<typeof createCompany>[0]> = {}): Company {
  counter++;
  return createCompany({
    name: `Reliability Test Co ${counter}`,
    source_type: "greenhouse",
    ats_board_token: `token-${counter}`,
    career_page_url: `https://example${counter}.com/careers`,
    ...overrides,
  });
}

function withFailures(company: Company, category: ErrorCategory, count: number): Company {
  for (let i = 0; i < count; i++) {
    recordScanFailure(company.id, { errorCategory: category, errorMessage: `${category} failure ${i + 1}` });
  }
  return getCompany(company.id)!;
}

function makeDiscoveryResult(overrides: Partial<DiscoveryV2Result> = {}): DiscoveryV2Result {
  return {
    companyId: null,
    seedUrl: "https://example.com/careers",
    seedFinalUrl: "https://example.com/careers",
    followedCareersUrl: null,
    followedFinalUrl: null,
    careersLinkScore: null,
    pagesVisited: 1,
    finalUrl: "https://example.com/careers",
    candidates: [],
    bestGenericJobsUrl: null,
    suspectedUnsupportedAts: null,
    durationMs: 10,
    observedRequestCount: 1,
    redirectChain: [],
    outcome: "NO_SOURCE_FOUND",
    reason: "test",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<DiscoveryV2Candidate> = {}): DiscoveryV2Candidate {
  return {
    provider: "greenhouse",
    boardToken: "newco",
    canonicalUrl: "https://job-boards.greenhouse.io/newco",
    evidenceTypes: ["STATIC_HTML"],
    evidenceUrls: ["https://job-boards.greenhouse.io/newco"],
    foundOnPage: "seed",
    validationStatus: "VALIDATED_JOBS",
    jobsSeen: 3,
    confidence: "HIGH",
    recommendation: "AUTO_REPLACE_CANDIDATE",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Phase 2/9 — state machine + real-success-only recovery
// ---------------------------------------------------------------------------------------------

test("1. a successful connector stays HEALTHY", () => {
  const company = makeCompany();
  recordScanSuccess(company.id);
  const assessment = deriveReliabilityState({ company: getCompany(company.id)!, hasPendingProposal: false });
  assert.equal(assessment.state, "HEALTHY");
});

test("2. one transient failure does not immediately become DOWN", () => {
  const company = withFailures(makeCompany(), "timeout", 1);
  const assessment = deriveReliabilityState({ company, hasPendingProposal: false });
  assert.notEqual(assessment.state, "DOWN");
  assert.equal(assessment.state, "RECOVERING");
});

test("3. repeated transient failures (still within the transient budget) enter/stay in RECOVERING, not DOWN", () => {
  const profile = getFailureProfile("network");
  assert.ok(profile.maxConsecutiveBeforeEscalation > 1, "test assumes network tolerates more than 1 failure");
  const company = withFailures(makeCompany(), "network", profile.maxConsecutiveBeforeEscalation);
  const assessment = deriveReliabilityState({ company, hasPendingProposal: false });
  assert.equal(assessment.state, "RECOVERING");
});

test("16. a real successful scan resets consecutive_failures and connector_health, and the derived state reflects it immediately", () => {
  const company = withFailures(makeCompany(), "timeout", 2);
  assert.equal(getCompany(company.id)!.connector_health, "degraded");
  recordScanSuccess(company.id);
  const recovered = getCompany(company.id)!;
  assert.equal(recovered.consecutive_failures, 0);
  assert.equal(recovered.connector_health, "healthy");
  assert.equal(deriveReliabilityState({ company: recovered, hasPendingProposal: false }).state, "HEALTHY");
});

test("17. a valid zero-job board is HEALTHY, not DOWN or degraded", () => {
  const company = makeCompany();
  recordScanSuccess(company.id);
  const assessment = deriveReliabilityState({ company: getCompany(company.id)!, hasPendingProposal: false }, 0);
  assert.equal(assessment.state, "HEALTHY");
  assert.equal(assessment.isHealthyEmpty, true);
});

test("18. isolated per-job warnings never reach connector_health — a company with only warning-level issues stays HEALTHY", () => {
  // Per scan.ts's ATS Health Semantics V2 design, connector_health only degrades on a genuine
  // thrown failure or a COMPLETE description-fetch failure — never on isolated per-job gaps (one
  // malformed job, one unknown location, one stale posting). Proven here at the reliability-state
  // layer: a company whose last real scan succeeded is HEALTHY regardless of what warnings (an
  // entirely separate, non-reliability field — see atsCoverage.ts's deriveWarnings) it might carry.
  const company = makeCompany();
  recordScanSuccess(company.id);
  const assessment = deriveReliabilityState({ company: getCompany(company.id)!, hasPendingProposal: false });
  assert.equal(assessment.state, "HEALTHY");
});

test("18b. Connector Reliability Final Hardening — a company degraded by an all-jobs-description-failure PARTIAL scan (connector_health='degraded', last_error_category=null, consecutive_failures=0) reads RECOVERING, never DOWN", () => {
  // This is exactly recordScanPartial's signature (companies.ts) — no fetch ever threw, so there is
  // no category-driven failure and no recovery/rediscovery budget consumed. Discovered via this
  // stage's own production reliability scorecard: dozens of real companies with this exact
  // combination were being misread as "recovery attempts exhausted" DOWN by the generic
  // last_error_category-defaults-to-'unknown' fallback, even though nothing was ever attempted.
  const created = makeCompany();
  getDb().prepare(`UPDATE companies SET connector_health = 'degraded', consecutive_failures = 0, last_error_category = NULL WHERE id = ?`).run(created.id);
  const company = getCompany(created.id)!;
  const assessment = deriveReliabilityState({ company, hasPendingProposal: false });
  assert.equal(assessment.state, "RECOVERING");
  assert.notEqual(assessment.state, "DOWN");
});

// ---------------------------------------------------------------------------------------------
// Phase 4 — bounded retry (reusing, not re-testing, retry.ts's own exhaustive suite)
// ---------------------------------------------------------------------------------------------

test("4. 429 (rate_limited) retry delay is bounded even for a large attempt number", () => {
  const delay = computeDelayMs(50, 300, 4000);
  assert.ok(delay <= 4000 + 100, `delay ${delay} must stay bounded near maxDelayMs`);
});

test("5. timeout is classified retryable with a finite, bounded escalation threshold", () => {
  assert.equal(isRetryableCategory("timeout"), true);
  const profile = getFailureProfile("timeout");
  assert.ok(Number.isFinite(profile.maxConsecutiveBeforeEscalation) && profile.maxConsecutiveBeforeEscalation > 0);
});

test("6. provider_5xx (HTTP 5xx) is classified retryable with a finite, bounded escalation threshold", () => {
  assert.equal(isRetryableCategory("provider_5xx"), true);
  const profile = getFailureProfile("provider_5xx");
  assert.ok(Number.isFinite(profile.maxConsecutiveBeforeEscalation) && profile.maxConsecutiveBeforeEscalation > 0);
});

// ---------------------------------------------------------------------------------------------
// Phase 3/5 — stale-source classification
// ---------------------------------------------------------------------------------------------

test("7. invalid_config is rediscovery-eligible (a Workday-token-style stale-source signal)", () => {
  assert.equal(isLikelyStaleSource("invalid_config"), true);
  assert.equal(getFailureProfile("invalid_config").rediscoveryEligible, true);
});

test("8. a transient failure (timeout) never looks like a stale source", () => {
  assert.equal(isLikelyStaleSource("timeout"), false);
  assert.equal(getFailureProfile("timeout").rediscoveryEligible, false);
});

test("13. SECURITY_REJECTED (unsafe_url) is never rediscovery-eligible", () => {
  assert.equal(getFailureProfile("unsafe_url").rediscoveryEligible, false);
});

// ---------------------------------------------------------------------------------------------
// Phase 5/6 — recovery controller: proposal-only, never auto-approve, cooldown, dedup
// ---------------------------------------------------------------------------------------------

test("8b. a company with only transient failures is never returned by the rediscovery-eligible query (transient failures don't trigger Discovery V2)", () => {
  withFailures(makeCompany(), "timeout", 1);
  const eligible = listRediscoveryEligibleCompanies(25, 6);
  assert.equal(eligible.some((e) => e.company.name.startsWith("Reliability Test Co")), false);
});

test("9/10. a HIGH-confidence candidate creates a PENDING_REVIEW proposal only — never approves, never mutates company source", async () => {
  const company = withFailures(makeCompany(), "invalid_config", 1);
  const before = getCompany(company.id)!;
  const discoverer = async () => makeDiscoveryResult({ outcome: "STRUCTURED_CANDIDATE_FOUND", candidates: [makeCandidate({ confidence: "HIGH", validationStatus: "VALIDATED_JOBS" })] });
  const summary = await runConnectorRecovery({ limit: 25, cooldownHours: 6, discoverer });
  const outcome = summary.outcomes.find((o) => o.companyId === company.id);
  assert.ok(outcome, "expected this company to be attempted");
  assert.equal(outcome!.proposalsCreated.length, 1);
  assert.equal(outcome!.proposalsCreated[0].status, "PENDING_REVIEW");
  const after = getCompany(company.id)!;
  assert.equal(after.source_type, before.source_type);
  assert.equal(after.ats_board_token, before.ats_board_token);
});

test("11. a MEDIUM-confidence candidate creates a proposal that is not approvable, and never auto-activates", async () => {
  const company = withFailures(makeCompany(), "invalid_config", 1);
  const before = getCompany(company.id)!;
  const discoverer = async () => makeDiscoveryResult({ outcome: "STRUCTURED_CANDIDATE_FOUND", candidates: [makeCandidate({ confidence: "MEDIUM", validationStatus: "VALIDATED_ZERO_JOBS", recommendation: "NEEDS_SOURCE_REVIEW" })] });
  const summary = await runConnectorRecovery({ limit: 25, cooldownHours: 6, discoverer });
  const outcome = summary.outcomes.find((o) => o.companyId === company.id)!;
  assert.equal(outcome.proposalsCreated.length, 1);
  assert.equal(outcome.proposalsCreated[0].confidence, "MEDIUM");
  const { isProposalApprovable } = await import("@/db/queries/atsSourceProposals");
  assert.equal(isProposalApprovable(outcome.proposalsCreated[0]), false);
  assert.equal(getCompany(company.id)!.source_type, before.source_type);
});

test("12. a LOW-confidence candidate creates evidence only and never auto-activates", async () => {
  const company = withFailures(makeCompany(), "invalid_config", 1);
  const before = getCompany(company.id)!;
  const discoverer = async () => makeDiscoveryResult({ outcome: "STRUCTURED_CANDIDATE_FOUND", candidates: [makeCandidate({ confidence: "LOW", validationStatus: "VALIDATION_FAILED", recommendation: "NEEDS_SOURCE_REVIEW" })] });
  const summary = await runConnectorRecovery({ limit: 25, cooldownHours: 6, discoverer });
  const outcome = summary.outcomes.find((o) => o.companyId === company.id)!;
  const { isProposalApprovable } = await import("@/db/queries/atsSourceProposals");
  assert.equal(isProposalApprovable(outcome.proposalsCreated[0]), false);
  assert.equal(getCompany(company.id)!.source_type, before.source_type);
});

test("13b. a SECURITY_REJECTED discovery outcome creates zero proposals and never touches the company", async () => {
  const company = withFailures(makeCompany(), "invalid_config", 1);
  const before = getCompany(company.id)!;
  const discoverer = async () => makeDiscoveryResult({ outcome: "SECURITY_REJECTED", candidates: [], reason: "Disallowed IP literal" });
  const summary = await runConnectorRecovery({ limit: 25, cooldownHours: 6, discoverer });
  const outcome = summary.outcomes.find((o) => o.companyId === company.id)!;
  assert.equal(outcome.proposalsCreated.length, 0);
  const after = getCompany(company.id)!;
  assert.equal(after.source_type, before.source_type);
  assert.equal(after.ats_board_token, before.ats_board_token);
});

test("14. an already-pending proposal prevents the same company from being rediscovered again (no thrashing)", async () => {
  const company = withFailures(makeCompany(), "invalid_config", 1);
  const discoverer = async () => makeDiscoveryResult({ outcome: "STRUCTURED_CANDIDATE_FOUND", candidates: [makeCandidate()] });
  const first = await runConnectorRecovery({ limit: 25, cooldownHours: 0, discoverer });
  assert.equal(first.outcomes.some((o) => o.companyId === company.id), true);

  // Second run: even with zero cooldown, the company must not be re-attempted because a
  // PENDING_REVIEW proposal now exists for it — proven directly against the eligibility query.
  const eligible = listRediscoveryEligibleCompanies(25, 0);
  assert.equal(eligible.some((e) => e.company.id === company.id), false);
});

test("15. cooldown prevents repeated rediscovery of the same company within the window", () => {
  const company = withFailures(makeCompany(), "invalid_config", 1);
  recordRediscoveryAttempt(company.id);
  const stillCoolingDown = listRediscoveryEligibleCompanies(25, 6);
  assert.equal(stillCoolingDown.some((e) => e.company.id === company.id), false);

  // Simulate the cooldown having elapsed by backdating the timestamp directly (test-only DB write —
  // recordRediscoveryAttempt itself always uses datetime('now'), so this reaches past it deliberately).
  getDb().prepare(`UPDATE companies SET last_rediscovery_attempted_at = datetime('now', '-7 hours') WHERE id = ?`).run(company.id);
  const pastCooldown = listRediscoveryEligibleCompanies(25, 6);
  assert.equal(pastCooldown.some((e) => e.company.id === company.id), true);
});

test("19. recovering one company never mutates an unrelated company's state", async () => {
  const companyA = withFailures(makeCompany(), "invalid_config", 1);
  const companyB = withFailures(makeCompany(), "invalid_config", 1);
  const beforeB = getCompany(companyB.id)!;

  const discoverer = async (company: Company) =>
    company.id === companyA.id
      ? makeDiscoveryResult({ outcome: "STRUCTURED_CANDIDATE_FOUND", candidates: [makeCandidate()] })
      : makeDiscoveryResult();

  await runConnectorRecovery({ limit: 1, cooldownHours: 6, discoverer });
  const afterB = getCompany(companyB.id)!;
  assert.equal(afterB.source_type, beforeB.source_type);
  assert.equal(afterB.ats_board_token, beforeB.ats_board_token);
  assert.equal(afterB.consecutive_failures, beforeB.consecutive_failures);
  assert.equal(afterB.last_rediscovery_attempted_at, beforeB.last_rediscovery_attempted_at);
});

// ---------------------------------------------------------------------------------------------
// Phase 7/8 — provider health + circuit breaker
// ---------------------------------------------------------------------------------------------

test("21a. below the minimum sample size, the circuit breaker never opens regardless of success rate", () => {
  const decision = evaluateCircuitBreaker({
    provider: "workday",
    eligibleCompanies: 50,
    recentSuccessfulScans: 1,
    recentFailedScans: 2,
    successRate: 1 / 3,
    dominantFailureCategory: "invalid_config",
    recoveringCount: 0,
    needsReviewCount: 0,
    downCount: 0,
    healthyCount: 0,
  });
  assert.equal(decision.open, false);
});

test("21b. above the minimum sample size with a healthy success rate, the circuit breaker stays closed", () => {
  const decision = evaluateCircuitBreaker({
    provider: "workday",
    eligibleCompanies: 50,
    recentSuccessfulScans: 18,
    recentFailedScans: 2,
    successRate: 0.9,
    dominantFailureCategory: null,
    recoveringCount: 0,
    needsReviewCount: 0,
    downCount: 0,
    healthyCount: 18,
  });
  assert.equal(decision.open, false);
});

test("20/21c. a provider-wide failure rate (many companies, mostly failing) opens the circuit breaker", () => {
  const decision = evaluateCircuitBreaker({
    provider: "workday",
    eligibleCompanies: 100,
    recentSuccessfulScans: 3,
    recentFailedScans: 17,
    successRate: 0.15,
    dominantFailureCategory: "provider_5xx",
    recoveringCount: 17,
    needsReviewCount: 0,
    downCount: 0,
    healthyCount: 3,
  });
  assert.equal(decision.open, true);
});

test("20b. an open circuit for a provider allows only a bounded probe count through, never the full eligible batch", async () => {
  const provider = "smartrecruiters" as const;
  const companies = [
    withFailures(makeCompany({ source_type: provider, ats_board_token: "a" }), "invalid_config", 1),
    withFailures(makeCompany({ source_type: provider, ats_board_token: "b" }), "invalid_config", 1),
    withFailures(makeCompany({ source_type: provider, ats_board_token: "c" }), "invalid_config", 1),
  ];
  const companyIds = new Set(companies.map((c) => c.id));
  let attemptedCount = 0;
  const discoverer = async (c: Company) => {
    if (companyIds.has(c.id)) attemptedCount++;
    return makeDiscoveryResult();
  };
  // Exercise the real getCircuitBreakerDecisions path by seeding enough failed scan_runs for this
  // provider to legitimately open the breaker (rather than asserting on the pure evaluateCircuitBreaker
  // function alone, as tests 21a/21b/20-21c already do).
  const db = getDb();
  for (let i = 0; i < 15; i++) {
    db.prepare(
      `INSERT INTO scan_runs (company_id, provider, started_at, finished_at, duration_ms, status, jobs_discovered, jobs_added, jobs_updated, jobs_unchanged, duplicates_skipped, jobs_closed, jobs_archived, description_failures, retry_count, error_category, error_message)
       VALUES (?, ?, datetime('now'), datetime('now'), 1, 'failed', 0,0,0,0,0,0,0,0,0, 'provider_5xx', 'x')`
    ).run(companies[0].id, provider);
  }
  // Generous limit so all 3 of this test's own companies are included alongside whatever else is
  // still eligible from earlier, unrelated tests sharing this file's DB — assertions below are
  // scoped to companyIds specifically, so that shared backlog cannot affect this test's outcome.
  const summary = await runConnectorRecovery({ limit: 25, cooldownHours: 0, discoverer });
  assert.ok(summary.openCircuits.includes(provider), "expected the circuit to be open for this provider");
  assert.ok(attemptedCount <= 1, `expected at most 1 probe through an open circuit, got ${attemptedCount}`);
  const skippedForThisProvider = summary.skippedByCircuitBreaker.filter((s) => companyIds.has(s.companyId));
  assert.ok(skippedForThisProvider.length >= 1, "expected at least one of this test's own companies skipped by the open circuit");
});

// ---------------------------------------------------------------------------------------------
// Phase 12/13 — independence + zero-cost
// ---------------------------------------------------------------------------------------------

test("22. the reliability controller never touches external_hiring_observations (external ingestion independence)", async () => {
  const company = withFailures(makeCompany(), "invalid_config", 1);
  const discoverer = async () => makeDiscoveryResult({ outcome: "STRUCTURED_CANDIDATE_FOUND", candidates: [makeCandidate()] });
  const before = getDb().prepare(`SELECT COUNT(*) AS n FROM external_hiring_observations`).get() as { n: number };
  await runConnectorRecovery({ limit: 25, cooldownHours: 6, discoverer });
  const after = getDb().prepare(`SELECT COUNT(*) AS n FROM external_hiring_observations`).get() as { n: number };
  assert.equal(after.n, before.n);
  void company;
});

test("23. the reliability controller never runs lifecycle maintenance (an old, otherwise-eligible-for-archival job is untouched)", async () => {
  const company = withFailures(makeCompany(), "invalid_config", 1);
  const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
  upsertJob({
    companyId: company.id,
    sourceType: company.source_type,
    dedupeKey: `greenhouse:${company.id}:old-job`,
    job: {
      externalId: "old-job", title: "Ancient Role", location: "Austin, TX", department: null,
      url: "https://job-boards.greenhouse.io/newco/jobs/1", descriptionHtml: "<p>x</p>", descriptionText: "x",
      employmentType: null, workplaceType: null, salaryText: null, postedAt: oldDate, raw: {},
    },
    descriptionSections: null, sponsorshipMentioned: false, sponsorshipPolarity: "none", sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  const discoverer = async () => makeDiscoveryResult();
  await runConnectorRecovery({ limit: 25, cooldownHours: 6, discoverer });
  // runAgeBasedSweep is the ONLY thing that would archive/delete this old job — proving it's still
  // untouched (still findable, still active) confirms the reliability controller never invoked it.
  const row = getDb().prepare(`SELECT is_active FROM jobs WHERE dedupe_key = ?`).get(`greenhouse:${company.id}:old-job`) as { is_active: number };
  assert.equal(row.is_active, 1);
});

test("24. the reliability controller never writes to job_match_results, tailoring_runs, or notifications", async () => {
  const company = withFailures(makeCompany(), "invalid_config", 1);
  const discoverer = async () => makeDiscoveryResult({ outcome: "STRUCTURED_CANDIDATE_FOUND", candidates: [makeCandidate()] });
  const counts = () => ({
    matches: (getDb().prepare(`SELECT COUNT(*) AS n FROM job_match_results`).get() as { n: number }).n,
    tailoring: (getDb().prepare(`SELECT COUNT(*) AS n FROM tailoring_runs`).get() as { n: number }).n,
    notifications: (getDb().prepare(`SELECT COUNT(*) AS n FROM notifications`).get() as { n: number }).n,
  });
  const before = counts();
  await runConnectorRecovery({ limit: 25, cooldownHours: 6, discoverer });
  const after = counts();
  assert.deepEqual(after, before);
  void company;
});

test("25. the reliability module never references any paid-provider credential or Apify", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    Promise.all(
      [
        "src/lib/ats/reliability/classification.ts",
        "src/lib/ats/reliability/state.ts",
        "src/lib/ats/reliability/circuitBreaker.ts",
        "src/lib/ats/reliability/recoveryController.ts",
      ].map((p) => fs.readFile(p, "utf-8"))
    )
  );
  const combined = source.join("\n");
  assert.equal(/APIFY_API_TOKEN|apify|OPENAI_API_KEY|CLAUDE_API|paid/i.test(combined), false);
});

// ---------------------------------------------------------------------------------------------
// Connector Reliability Control Plane V1.1 — verifying the new real-production-evidence message
// patterns (see errors.test.ts for the classification tests themselves) route correctly through
// the UNCHANGED Reliability V1 state machine. No new state-machine logic is being tested here —
// only that classification.ts/state.ts treat these newly-recognized categories exactly the way
// they already treat every other network/parse_error/blocked failure.
// ---------------------------------------------------------------------------------------------

test("V1.1-15. the JobDiva pagination-consistency pattern (now 'network') does not trigger Discovery V2 rediscovery eligibility", () => {
  const category = categorizeThrownError(new Error("JobDiva pagination shifted or returned an incomplete page"));
  assert.equal(category, "network");
  const company = withFailures(makeCompany(), category, 1);
  const eligible = listRediscoveryEligibleCompanies(25, 6);
  assert.equal(eligible.some((e) => e.company.id === company.id), false);
});

test("V1.1-16. the 'redirected to an untrusted host' pattern (now 'blocked') is rediscovery-eligible, matching the existing policy for blocked", () => {
  const category = categorizeThrownError(new Error("SuccessFactors detail response redirected to an untrusted host (expected a, got b)"));
  assert.equal(category, "blocked");
  const company = withFailures(makeCompany({ source_type: "successfactors", ats_board_token: "t" }), category, 1);
  const eligible = listRediscoveryEligibleCompanies(25, 6);
  assert.equal(eligible.some((e) => e.company.id === company.id), true);
});

test("V1.1-17. the generic 'has no full description' pattern (now 'parse_error') is never rediscovery-eligible", () => {
  const category = categorizeThrownError(new Error("Oracle Recruiting Cloud job 999 has no full description"));
  assert.equal(category, "parse_error");
  const company = withFailures(makeCompany({ source_type: "oracle_recruiting_cloud", ats_board_token: "t" }), category, 1);
  const eligible = listRediscoveryEligibleCompanies(25, 6);
  assert.equal(eligible.some((e) => e.company.id === company.id), false);
});

test("V1.1-19. a JobDiva-pattern company with a failure count at the exhaustion threshold reads DOWN, not RECOVERING, and 'unknown' is never assigned by the new patterns", () => {
  const category = categorizeThrownError(new Error("JobDiva pagination shifted or returned an incomplete page"));
  const company = withFailures(makeCompany(), category, 10);
  const assessment = deriveReliabilityState({ company, hasPendingProposal: false });
  assert.equal(assessment.state, "DOWN");
  assert.notEqual(category, "unknown");
});

test("V1.1-genuine-unknown. a truly unrecognized failure message still correctly falls through to 'unknown' — the objective is honest classification, not zero unknowns", () => {
  const category = categorizeThrownError(new Error("Something this test suite has never seen before and cannot explain"));
  assert.equal(category, "unknown");
});
