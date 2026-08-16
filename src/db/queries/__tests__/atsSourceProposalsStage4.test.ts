import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateForProposal } from "../atsSourceProposals";

/**
 * Discovery V2 Stage 4 — controlled source activation. These tests prove the specific Stage 4
 * invariants on top of Stage 3's own suite (src/db/queries/__tests__/atsSourceProposals.test.ts):
 * HIGH-only production approval, exactly-one-authoritative-source, old-source history stays
 * queryable through the APPROVED proposal's own snapshot fields, scheduler eligibility without a
 * direct scan trigger, candidate/application state isolation, and idempotent/duplicate-approval
 * safety.
 */

let tmpDir: string;
let getDb: typeof import("../../index").getDb;
let createCompany: typeof import("../companies").createCompany;
let getCompany: typeof import("../companies").getCompany;
let createCandidate: typeof import("../candidates").createCandidate;
let upsertJob: typeof import("../jobs").upsertJob;
let getJobByDedupeKey: typeof import("../jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let setPipelineStatus: typeof import("../candidateJobState").setPipelineStatus;
let getCandidateJobState: typeof import("../candidateJobState").getCandidateJobState;
let listScanReadyCompanies: typeof import("../organizationRegistry").listScanReadyCompanies;
let createProposalFromDiscoveryV2: typeof import("../atsSourceProposals").createProposalFromDiscoveryV2;
let getProposal: typeof import("../atsSourceProposals").getProposal;
let isProposalApprovable: typeof import("../atsSourceProposals").isProposalApprovable;
let approveProposal: typeof import("../atsSourceProposals").approveProposal;
let ProposalApprovalError: typeof import("../atsSourceProposals").ProposalApprovalError;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ats-source-proposals-stage4-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
  ({ createCompany, getCompany } = await import("../companies"));
  ({ createCandidate } = await import("../candidates"));
  ({ upsertJob, getJobByDedupeKey } = await import("../jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ setPipelineStatus, getCandidateJobState } = await import("../candidateJobState"));
  ({ listScanReadyCompanies } = await import("../organizationRegistry"));
  ({
    createProposalFromDiscoveryV2,
    getProposal,
    isProposalApprovable,
    approveProposal,
    ProposalApprovalError,
  } = await import("../atsSourceProposals"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let seedCounter = 0;
function seedCompany() {
  seedCounter += 1;
  return createCompany({
    name: `Stage4 Test Co ${seedCounter}`,
    source_type: "career_link",
    career_page_url: `https://stage4-test-${seedCounter}.example/careers`,
  });
}

function highCandidate(overrides: Partial<CandidateForProposal> = {}): CandidateForProposal {
  const boardToken = overrides.boardToken ?? "stage4-co";
  return {
    provider: "jobvite",
    boardToken,
    canonicalUrl: `https://jobs.jobvite.com/${boardToken}`,
    confidence: "HIGH",
    validationStatus: "VALIDATED_JOBS",
    recommendation: "AUTO_REPLACE_CANDIDATE",
    evidenceTypes: ["static_html"],
    evidenceUrls: [`https://jobs.jobvite.com/${boardToken}`],
    ...overrides,
  };
}

function mediumCandidate(overrides: Partial<CandidateForProposal> = {}): CandidateForProposal {
  const boardToken = overrides.boardToken ?? "stage4-medium-co";
  return {
    provider: "icims",
    boardToken,
    canonicalUrl: `https://careers-${boardToken}.icims.com`,
    confidence: "MEDIUM",
    validationStatus: "VALIDATED_ZERO_JOBS",
    recommendation: "NEEDS_SOURCE_REVIEW",
    evidenceTypes: ["static_html"],
    evidenceUrls: [`https://careers-${boardToken}.icims.com`],
    ...overrides,
  };
}

test("1. HIGH + VALIDATED_JOBS is approvable", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate(),
  })!;
  assert.equal(isProposalApprovable(proposal), true);
  const approved = approveProposal(company.id, proposal.id);
  assert.equal(approved.status, "APPROVED");
});

test("2. MEDIUM + VALIDATED_ZERO_JOBS is not approvable in Stage 4", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: mediumCandidate(),
  })!;
  assert.equal(isProposalApprovable(proposal), false);
  assert.throws(() => approveProposal(company.id, proposal.id), (err: unknown) => err instanceof ProposalApprovalError && err.code === "NOT_APPROVABLE");
});

test("5. exactly one authoritative job_sources row exists per company after approval", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "authoritative-check" }),
  })!;
  approveProposal(company.id, proposal.id);

  const rows = getDb().prepare("SELECT id, is_authoritative, provider, source_key FROM job_sources WHERE legacy_company_id = ?").all(company.id) as {
    id: number;
    is_authoritative: number;
    provider: string;
    source_key: string;
  }[];
  assert.equal(rows.length, 1, "exactly one job_sources row must exist for this company");
  assert.equal(rows[0].is_authoritative, 1);
  assert.equal(rows[0].provider, "jobvite");
  assert.equal(rows[0].source_key, "authoritative-check");
});

test("6. old source history remains queryable through the APPROVED proposal's own snapshot", () => {
  const company = seedCompany();
  // Give the company a real prior source to replace, so current_* on the proposal is meaningful.
  getDb().prepare("UPDATE companies SET source_type = 'greenhouse', ats_board_token = 'old-board-token' WHERE id = ?").run(company.id);
  const staleAwareCompany = getCompany(company.id)!;

  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: staleAwareCompany.source_type,
    currentBoardToken: staleAwareCompany.ats_board_token,
    candidate: highCandidate({ boardToken: "history-check" }),
  })!;
  const approved = approveProposal(company.id, proposal.id);

  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.current_source_type, "greenhouse", "the OLD source type must remain on the approved proposal's own record");
  assert.equal(approved.current_board_token, "old-board-token", "the OLD board token must remain on the approved proposal's own record");
  assert.equal(approved.proposed_source_type, "jobvite");
  assert.equal(approved.proposed_board_token, "history-check");

  // Still queryable independently after the fact — this IS the durable history, not a live company field.
  const reread = getProposal(proposal.id)!;
  assert.equal(reread.current_source_type, "greenhouse");
  assert.equal(reread.current_board_token, "old-board-token");
});

test("4/17. no lifecycle actions run against pre-existing jobs during approval", () => {
  const company = seedCompany();
  getDb().prepare("UPDATE companies SET source_type = 'greenhouse', ats_board_token = 'pre-existing-token' WHERE id = ?").run(company.id);
  const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "ext-lifecycle-1");
  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "ext-lifecycle-1",
      title: "Pre-Existing Job",
      location: null,
      department: null,
      url: "https://boards.greenhouse.io/pre-existing-token/ext-lifecycle-1",
      descriptionHtml: null,
      descriptionText: "desc",
      employmentType: null,
      workplaceType: null,
      salaryText: null,
      postedAt: new Date().toISOString(),
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  const before = getJobByDedupeKey(dedupeKey)!;

  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: "greenhouse",
    currentBoardToken: "pre-existing-token",
    candidate: highCandidate({ boardToken: "lifecycle-replacement" }),
  })!;
  approveProposal(company.id, proposal.id);

  const after = getJobByDedupeKey(dedupeKey)!;
  assert.equal(after.is_active, before.is_active, "approval must not close/deactivate a pre-existing job");
  assert.equal(after.is_archived, before.is_archived, "approval must not archive a pre-existing job");
  assert.equal(after.title, before.title);
});

test("10. candidate/application state is untouched by approval", () => {
  const company = seedCompany();
  getDb().prepare("UPDATE companies SET source_type = 'greenhouse', ats_board_token = 'candidate-state-token' WHERE id = ?").run(company.id);
  const candidate = createCandidate({ firstName: "Stage4", lastName: "Candidate" });
  const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "ext-candidate-state-1");
  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "ext-candidate-state-1",
      title: "Candidate State Job",
      location: null,
      department: null,
      url: "https://boards.greenhouse.io/candidate-state-token/ext-candidate-state-1",
      descriptionHtml: null,
      descriptionText: "desc",
      employmentType: null,
      workplaceType: null,
      salaryText: null,
      postedAt: new Date().toISOString(),
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  setPipelineStatus(candidate.id, dedupeKey, "Applied");
  const before = getCandidateJobState(candidate.id, dedupeKey)!;

  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: "greenhouse",
    currentBoardToken: "candidate-state-token",
    candidate: highCandidate({ boardToken: "candidate-state-replacement" }),
  })!;
  approveProposal(company.id, proposal.id);

  const after = getCandidateJobState(candidate.id, dedupeKey)!;
  assert.equal(after.pipeline_status, before.pipeline_status);
  assert.equal(after.pipeline_status, "Applied");
});

test("12. duplicate approval (approving the same proposal twice) is rejected safely, second attempt writes nothing further", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "duplicate-approval" }),
  })!;
  const firstApproval = approveProposal(company.id, proposal.id);
  assert.equal(firstApproval.status, "APPROVED");

  assert.throws(() => approveProposal(company.id, proposal.id), (err: unknown) => err instanceof ProposalApprovalError && err.code === "NOT_PENDING");

  // Still APPROVED, reviewed_at from the first (successful) approval untouched by the failed retry.
  const reread = getProposal(proposal.id)!;
  assert.equal(reread.status, "APPROVED");
  assert.equal(reread.reviewed_at, firstApproval.reviewed_at);
});

test("14. connector_health is 'unknown' after approval, never 'healthy'", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "connector-health-check" }),
  })!;
  approveProposal(company.id, proposal.id);
  const reloaded = getCompany(company.id)!;
  assert.equal(reloaded.connector_health, "unknown");
  assert.notEqual(reloaded.connector_health, "healthy");
  assert.equal(reloaded.consecutive_failures, 0);
});

test("4/15. approval makes the company scan-ready via the EXISTING scheduler eligibility rule, without triggering a scan", () => {
  const company = seedCompany();
  const scanRunCountBefore = (getDb().prepare("SELECT COUNT(*) AS c FROM scan_runs WHERE company_id = ?").get(company.id) as { c: number }).c;

  // Not yet scan-ready: still career_link with no board token.
  assert.ok(!listScanReadyCompanies().some((c) => c.id === company.id));

  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "scheduler-eligibility-check" }),
  })!;
  approveProposal(company.id, proposal.id);

  // Scan-ready now, purely through job_sources.review_status='APPROVED' + resolution_status='VERIFIED'
  // + is_active=1 + a supported provider — the same existing rule every other source promotion uses.
  assert.ok(listScanReadyCompanies().some((c) => c.id === company.id), "company must become eligible for the normal scheduler after approval");

  const scanRunCountAfter = (getDb().prepare("SELECT COUNT(*) AS c FROM scan_runs WHERE company_id = ?").get(company.id) as { c: number }).c;
  assert.equal(scanRunCountAfter, scanRunCountBefore, "approval itself must never create a scan_runs row");
});

test("9. a stale proposal cannot become approved via a second attempt after the company's source changed again", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "idempotent-stale-check" }),
  })!;
  getDb().prepare("UPDATE companies SET source_type = 'lever', ats_board_token = 'changed-out-from-under-it' WHERE id = ?").run(company.id);

  assert.throws(() => approveProposal(company.id, proposal.id), (err: unknown) => err instanceof ProposalApprovalError && err.code === "STALE_PROPOSAL");
  assert.throws(() => approveProposal(company.id, proposal.id), (err: unknown) => err instanceof ProposalApprovalError && err.code === "NOT_PENDING", "once SUPERSEDED, a retry must fail on status, not re-attempt staleness logic");
});
