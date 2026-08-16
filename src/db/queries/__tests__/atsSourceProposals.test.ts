import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateForProposal } from "../atsSourceProposals";

/**
 * Discovery V2 Stage 3 — proposal creation / dedup / approval / rejection. Every scenario runs
 * against its own isolated temp-file DB (career-ops's established convention), so nothing here ever
 * touches data/app.db.
 */

let tmpDir: string;
let getDb: typeof import("../../index").getDb;
let createCompany: typeof import("../companies").createCompany;
let getCompany: typeof import("../companies").getCompany;
let recordScanFailure: typeof import("../companies").recordScanFailure;
let upsertJob: typeof import("../jobs").upsertJob;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let createProposalFromDiscoveryV2: typeof import("../atsSourceProposals").createProposalFromDiscoveryV2;
let getProposal: typeof import("../atsSourceProposals").getProposal;
let listPendingProposals: typeof import("../atsSourceProposals").listPendingProposals;
let listProposalsForCompany: typeof import("../atsSourceProposals").listProposalsForCompany;
let isProposalApprovable: typeof import("../atsSourceProposals").isProposalApprovable;
let approveProposal: typeof import("../atsSourceProposals").approveProposal;
let rejectProposal: typeof import("../atsSourceProposals").rejectProposal;
let ProposalApprovalError: typeof import("../atsSourceProposals").ProposalApprovalError;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ats-source-proposals-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
  ({ createCompany, getCompany, recordScanFailure } = await import("../companies"));
  ({ upsertJob } = await import("../jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({
    createProposalFromDiscoveryV2,
    getProposal,
    listPendingProposals,
    listProposalsForCompany,
    isProposalApprovable,
    approveProposal,
    rejectProposal,
    ProposalApprovalError,
  } = await import("../atsSourceProposals"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let seedCounter = 0;
function seedCompany(overrides: Partial<Parameters<typeof createCompany>[0]> = {}) {
  seedCounter += 1;
  return createCompany({
    name: `Proposal Test Co ${seedCounter}`,
    source_type: "career_link",
    career_page_url: `https://example${seedCounter}.com/careers`,
    ...overrides,
  });
}

function highCandidate(overrides: Partial<CandidateForProposal> = {}): CandidateForProposal {
  const boardToken = overrides.boardToken ?? "acme-co";
  return {
    provider: "greenhouse",
    boardToken,
    canonicalUrl: `https://boards.greenhouse.io/${boardToken}`,
    confidence: "HIGH",
    validationStatus: "VALIDATED_JOBS",
    recommendation: "PROMOTE",
    evidenceTypes: ["structured_api"],
    evidenceUrls: [`https://boards.greenhouse.io/${boardToken}`],
    ...overrides,
  };
}

test("HIGH confidence + VALIDATED_JOBS creates a PENDING_REVIEW proposal", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate(),
  });
  assert.ok(proposal);
  assert.equal(proposal!.status, "PENDING_REVIEW");
  assert.equal(proposal!.confidence, "HIGH");
  assert.equal(proposal!.proposed_source_type, "greenhouse");
});

test("MEDIUM confidence + VALIDATED_ZERO_JOBS creates a PENDING_REVIEW proposal, but is not approvable (Stage 4: review-only)", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ confidence: "MEDIUM", validationStatus: "VALIDATED_ZERO_JOBS", boardToken: "medium-co" }),
  });
  assert.ok(proposal);
  assert.equal(proposal!.status, "PENDING_REVIEW");
  assert.equal(proposal!.confidence, "MEDIUM");
  assert.equal(isProposalApprovable(proposal!), false);
  assert.throws(() => approveProposal(company.id, proposal!.id), (err: unknown) => err instanceof ProposalApprovalError && err.code === "NOT_APPROVABLE");
  assert.equal(getProposal(proposal!.id)!.status, "PENDING_REVIEW", "a failed approval attempt must not change the proposal's status");
});

test("LOW confidence candidate is recorded as evidence but is never approvable", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ confidence: "LOW", validationStatus: "VALIDATED_JOBS", boardToken: "low-co" }),
  });
  assert.ok(proposal);
  assert.equal(isProposalApprovable(proposal!), false);
  assert.throws(() => approveProposal(company.id, proposal!.id), (err: unknown) => err instanceof ProposalApprovalError && err.code === "NOT_APPROVABLE");
});

test("SECURITY_REJECTED validation status is never approvable regardless of confidence", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ confidence: "HIGH", validationStatus: "SECURITY_REJECTED", boardToken: "sec-co" }),
  });
  assert.ok(proposal);
  assert.equal(isProposalApprovable(proposal!), false);
  assert.throws(() => approveProposal(company.id, proposal!.id), (err: unknown) => err instanceof ProposalApprovalError && err.code === "NOT_APPROVABLE");
});

test("repeated identical candidate dedupes to the same pending proposal row", () => {
  const company = seedCompany();
  const first = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "dedupe-co" }),
  });
  const second = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "dedupe-co" }),
  });
  assert.ok(first);
  assert.ok(second);
  assert.equal(first!.id, second!.id);
  const rows = listProposalsForCompany(company.id).filter((p) => p.proposed_board_token === "dedupe-co");
  assert.equal(rows.length, 1);
});

test("a changed proposed board token creates a distinct proposal, leaving the old one untouched", () => {
  const company = seedCompany();
  const original = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "token-a" }),
  })!;
  const changed = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "token-b" }),
  })!;
  assert.notEqual(original.id, changed.id);
  const stillThere = getProposal(original.id);
  assert.ok(stillThere);
  assert.equal(stillThere!.proposed_board_token, "token-a");
  assert.equal(stillThere!.status, "PENDING_REVIEW");
});

test("proposal creation never mutates the company's active source, at any confidence", () => {
  const company = seedCompany({ source_type: "greenhouse", ats_board_token: "already-active" });
  for (const confidence of ["HIGH", "MEDIUM", "LOW"] as const) {
    createProposalFromDiscoveryV2({
      companyId: company.id,
      currentSourceType: company.source_type,
      currentBoardToken: company.ats_board_token,
      candidate: highCandidate({ confidence, boardToken: `${confidence.toLowerCase()}-token` }),
    });
  }
  const reloaded = getCompany(company.id)!;
  assert.equal(reloaded.source_type, "greenhouse");
  assert.equal(reloaded.ats_board_token, "already-active");
});

test("approval changes the company's source atomically and marks the proposal APPROVED", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "approve-target" }),
  })!;

  const approved = approveProposal(company.id, proposal.id);
  assert.equal(approved.status, "APPROVED");

  const reloaded = getCompany(company.id)!;
  assert.equal(reloaded.source_type, "greenhouse");
  assert.equal(reloaded.ats_board_token, "approve-target");
});

test("approval creates no jobs and runs no scan", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "no-scan-target" }),
  })!;

  const jobCountBefore = (getDb().prepare("SELECT COUNT(*) AS c FROM jobs WHERE company_id = ?").get(company.id) as { c: number }).c;
  const scanRunCountBefore = (getDb().prepare("SELECT COUNT(*) AS c FROM scan_runs WHERE company_id = ?").get(company.id) as { c: number }).c;

  approveProposal(company.id, proposal.id);

  const jobCountAfter = (getDb().prepare("SELECT COUNT(*) AS c FROM jobs WHERE company_id = ?").get(company.id) as { c: number }).c;
  const scanRunCountAfter = (getDb().prepare("SELECT COUNT(*) AS c FROM scan_runs WHERE company_id = ?").get(company.id) as { c: number }).c;
  assert.equal(jobCountAfter, jobCountBefore);
  assert.equal(scanRunCountAfter, scanRunCountBefore);

  const reloaded = getCompany(company.id)!;
  assert.notEqual(reloaded.connector_health, "healthy");
});

test("approval preserves pre-existing job/candidate history untouched", () => {
  const company = seedCompany({ source_type: "greenhouse", ats_board_token: "history-co" });
  const dedupeKey = dedupeKeyForAts("greenhouse", company.id, "ext-history-1");
  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "ext-history-1",
      title: "Existing Historical Job",
      location: null,
      department: null,
      url: "https://boards.greenhouse.io/history-co/ext-history-1",
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

  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "history-co-new" }),
  })!;
  approveProposal(company.id, proposal.id);

  const row = getDb().prepare("SELECT title FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as { title: string } | undefined;
  assert.ok(row);
  assert.equal(row!.title, "Existing Historical Job");
});

test("a stale proposal (company source changed since creation) cannot be approved and is superseded", () => {
  const company = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "stale-target" }),
  })!;

  getDb().prepare("UPDATE companies SET source_type = 'lever', ats_board_token = 'someone-else-changed-this' WHERE id = ?").run(company.id);

  assert.throws(() => approveProposal(company.id, proposal.id), (err: unknown) => err instanceof ProposalApprovalError && err.code === "STALE_PROPOSAL");
  const reloaded = getProposal(proposal.id)!;
  assert.equal(reloaded.status, "SUPERSEDED");
});

test("rejection preserves the active source untouched and does not reset failure state", () => {
  const company = seedCompany({ source_type: "greenhouse", ats_board_token: "reject-keep" });
  recordScanFailure(company.id, { errorCategory: "unknown", errorMessage: "boom" });
  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "reject-target" }),
  })!;

  const rejected = rejectProposal(company.id, proposal.id, "not confident enough");
  assert.equal(rejected.status, "REJECTED");

  const reloaded = getCompany(company.id)!;
  assert.equal(reloaded.source_type, "greenhouse");
  assert.equal(reloaded.ats_board_token, "reject-keep");
  assert.equal(reloaded.consecutive_failures, 1);
});

test("a repeated identical candidate does not spam the queue after rejection", () => {
  const company = seedCompany();
  const first = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "reject-repeat" }),
  })!;
  rejectProposal(company.id, first.id);

  const second = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "reject-repeat" }),
  });
  assert.equal(second, null);
  const pending = listProposalsForCompany(company.id).filter((p) => p.proposed_board_token === "reject-repeat" && p.status === "PENDING_REVIEW");
  assert.equal(pending.length, 0);
});

test("failure state resets only after an approved replacement, never on creation or rejection", () => {
  const company = seedCompany({ source_type: "greenhouse", ats_board_token: "failing-co" });
  recordScanFailure(company.id, { errorCategory: "unknown", errorMessage: "boom" });
  recordScanFailure(company.id, { errorCategory: "unknown", errorMessage: "boom again" });
  assert.equal(getCompany(company.id)!.consecutive_failures, 2);

  const proposal = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "failing-co-fix" }),
  })!;
  assert.equal(getCompany(company.id)!.consecutive_failures, 2, "creation alone must not touch failure state");

  approveProposal(company.id, proposal.id);
  assert.equal(getCompany(company.id)!.consecutive_failures, 0);
});

test("an unrelated company cannot approve or reject another company's proposal", () => {
  const owner = seedCompany();
  const stranger = seedCompany();
  const proposal = createProposalFromDiscoveryV2({
    companyId: owner.id,
    currentSourceType: owner.source_type,
    currentBoardToken: owner.ats_board_token,
    candidate: highCandidate({ boardToken: "isolation-target" }),
  })!;

  assert.throws(() => approveProposal(stranger.id, proposal.id), (err: unknown) => err instanceof ProposalApprovalError && err.code === "COMPANY_MISMATCH");
  assert.throws(() => rejectProposal(stranger.id, proposal.id), (err: unknown) => err instanceof ProposalApprovalError && err.code === "COMPANY_MISMATCH");
});

test("proposals are isolated per company in listProposalsForCompany", () => {
  const companyA = seedCompany();
  const companyB = seedCompany();
  createProposalFromDiscoveryV2({
    companyId: companyA.id,
    currentSourceType: companyA.source_type,
    currentBoardToken: companyA.ats_board_token,
    candidate: highCandidate({ boardToken: "company-a-token" }),
  });
  createProposalFromDiscoveryV2({
    companyId: companyB.id,
    currentSourceType: companyB.source_type,
    currentBoardToken: companyB.ats_board_token,
    candidate: highCandidate({ boardToken: "company-b-token" }),
  });

  const forA = listProposalsForCompany(companyA.id);
  const forB = listProposalsForCompany(companyB.id);
  assert.ok(forA.every((p) => p.company_id === companyA.id));
  assert.ok(forB.every((p) => p.company_id === companyB.id));
  assert.ok(forA.every((p) => p.proposed_board_token !== "company-b-token"));
});

test("two companies proposing the identical provider/token do not collide", () => {
  const companyA = seedCompany();
  const companyB = seedCompany();
  const proposalA = createProposalFromDiscoveryV2({
    companyId: companyA.id,
    currentSourceType: companyA.source_type,
    currentBoardToken: companyA.ats_board_token,
    candidate: highCandidate({ boardToken: "shared-token" }),
  })!;
  const proposalB = createProposalFromDiscoveryV2({
    companyId: companyB.id,
    currentSourceType: companyB.source_type,
    currentBoardToken: companyB.ats_board_token,
    candidate: highCandidate({ boardToken: "shared-token" }),
  })!;
  assert.notEqual(proposalA.id, proposalB.id);
  assert.equal(proposalA.company_id, companyA.id);
  assert.equal(proposalB.company_id, companyB.id);
});

test("listPendingProposals only returns PENDING_REVIEW rows, never approved/rejected/superseded", () => {
  const company = seedCompany();
  const toApprove = createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: highCandidate({ boardToken: "queue-approve" }),
  })!;
  approveProposal(company.id, toApprove.id);

  const otherCompany = seedCompany();
  const toReject = createProposalFromDiscoveryV2({
    companyId: otherCompany.id,
    currentSourceType: otherCompany.source_type,
    currentBoardToken: otherCompany.ats_board_token,
    candidate: highCandidate({ boardToken: "queue-reject" }),
  })!;
  rejectProposal(otherCompany.id, toReject.id);

  const stillPendingCompany = seedCompany();
  createProposalFromDiscoveryV2({
    companyId: stillPendingCompany.id,
    currentSourceType: stillPendingCompany.source_type,
    currentBoardToken: stillPendingCompany.ats_board_token,
    candidate: highCandidate({ boardToken: "queue-pending" }),
  });

  const pending = listPendingProposals(200);
  assert.ok(pending.some((p) => p.proposed_board_token === "queue-pending"));
  assert.ok(!pending.some((p) => p.proposed_board_token === "queue-approve"));
  assert.ok(!pending.some((p) => p.proposed_board_token === "queue-reject"));
});
