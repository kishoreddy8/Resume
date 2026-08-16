import { getDb } from "@/db";
import { getCompany, recordDiscoveryResult, resetConnectorFailureState } from "@/db/queries/companies";
import { reviewJobSource } from "@/db/queries/organizationRegistry";
import type { AtsSourceProposal, SourceType } from "@/types";

/**
 * Discovery V2 Stage 3 — durable source-replacement proposals. See schema.sql's own doc comment on
 * ats_source_proposals for why this is a dedicated table rather than reusing
 * job_source_validation_runs.
 *
 * Nothing in this file mutates companies/job_sources EXCEPT approveProposal, which is the ONLY path
 * in this entire Stage that ever does — and even then only via the existing
 * recordDiscoveryResult/reviewJobSource/resetConnectorFailureState functions, never a bespoke
 * UPDATE. createProposalFromDiscoveryV2, rejectProposal, and every list/get helper are pure reads or
 * proposal-table-only writes.
 */

export interface CandidateForProposal {
  provider: Exclude<SourceType, "career_link">;
  boardToken: string;
  canonicalUrl: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  validationStatus: string;
  recommendation: string;
  evidenceTypes: string[];
  evidenceUrls: string[];
}

function rowToProposal(row: unknown): AtsSourceProposal {
  return row as AtsSourceProposal;
}

export function getProposal(id: number): AtsSourceProposal | undefined {
  const row = getDb().prepare("SELECT * FROM ats_source_proposals WHERE id = ?").get(id);
  return row ? rowToProposal(row) : undefined;
}

export function listPendingProposals(limit = 50): AtsSourceProposal[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
  return getDb()
    .prepare("SELECT * FROM ats_source_proposals WHERE status = 'PENDING_REVIEW' ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(boundedLimit) as AtsSourceProposal[];
}

export function listProposalsForCompany(companyId: number): AtsSourceProposal[] {
  return getDb()
    .prepare("SELECT * FROM ats_source_proposals WHERE company_id = ? ORDER BY created_at DESC, id DESC")
    .all(companyId) as AtsSourceProposal[];
}

/** Whether a candidate's own confidence/validation is eligible for approval at all — the same gate
 *  approveProposal enforces server-side; exported so the API/UI can render "not approvable" honestly
 *  without duplicating the rule. Mirrors Phase 3/5's exact rule: only VALIDATED_JOBS (HIGH) or
 *  VALIDATED_ZERO_JOBS (MEDIUM) are ever approvable — LOW confidence, failed validation, security
 *  rejection, and unsupported providers are never approvable, though they may still be recorded and
 *  reviewed (rejected) as evidence. */
export function isProposalApprovable(proposal: Pick<AtsSourceProposal, "confidence" | "validation_status">): boolean {
  if (proposal.confidence === "LOW") return false;
  return proposal.validation_status === "VALIDATED_JOBS" || proposal.validation_status === "VALIDATED_ZERO_JOBS";
}

/**
 * Persists a proposal for a genuinely structured Discovery V2 candidate. Only ever called for a
 * real candidate object (GENERIC_ONLY/NO_SOURCE_FOUND/INVALID_SEED_RESOURCE/NAVIGATION_FAILED/
 * SECURITY_REJECTED outcomes have no candidate and must never reach this function at all — see the
 * shadow runner's own call site).
 *
 * Dedup/staleness-of-proposal (not staleness-of-company, which is approveProposal's job):
 * - An existing PENDING_REVIEW row for the exact same (company, provider, token) refreshes its
 *   evidence/timestamp instead of creating a duplicate.
 * - An existing REJECTED row for that exact identity is respected — no immediate recreation.
 * - An existing APPROVED row means there's nothing new to propose.
 * - An existing SUPERSEDED row does not block a fresh proposal (staleness was about the OLD
 *   approval attempt, not a rejection of the candidate itself).
 * Returns null when nothing was written (rejected/approved dedup case).
 */
export function createProposalFromDiscoveryV2(input: {
  companyId: number;
  currentSourceType: SourceType | null;
  currentBoardToken: string | null;
  candidate: CandidateForProposal;
}): AtsSourceProposal | null {
  const db = getDb();
  const { companyId, candidate } = input;

  const jobSourceRow = db
    .prepare("SELECT id FROM job_sources WHERE legacy_company_id = ?")
    .get(companyId) as { id: number } | undefined;

  const evidenceJson = JSON.stringify({
    evidenceTypes: candidate.evidenceTypes,
    evidenceUrls: candidate.evidenceUrls,
    capturedAt: new Date().toISOString(),
  });

  const existing = db
    .prepare(
      `SELECT * FROM ats_source_proposals
       WHERE company_id = ? AND proposed_source_type = ? AND proposed_board_token = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(companyId, candidate.provider, candidate.boardToken) as AtsSourceProposal | undefined;

  if (existing) {
    if (existing.status === "PENDING_REVIEW") {
      db.prepare(
        `UPDATE ats_source_proposals
         SET evidence_json = ?, validation_status = ?, confidence = ?, recommendation = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(evidenceJson, candidate.validationStatus, candidate.confidence, candidate.recommendation, existing.id);
      return getProposal(existing.id) ?? null;
    }
    if (existing.status === "REJECTED" || existing.status === "APPROVED") {
      return null;
    }
    // SUPERSEDED falls through to create a fresh proposal below.
  }

  const inserted = db
    .prepare(
      `INSERT INTO ats_source_proposals (
         company_id, job_source_id, current_source_type, current_board_token,
         proposed_source_type, proposed_board_token, proposed_canonical_url,
         confidence, validation_status, recommendation, evidence_json, discovery_source, status
       ) VALUES (
         @companyId, @jobSourceId, @currentSourceType, @currentBoardToken,
         @proposedSourceType, @proposedBoardToken, @proposedCanonicalUrl,
         @confidence, @validationStatus, @recommendation, @evidenceJson, 'discovery_v2', 'PENDING_REVIEW'
       ) RETURNING *`
    )
    .get({
      companyId,
      jobSourceId: jobSourceRow?.id ?? null,
      currentSourceType: input.currentSourceType,
      currentBoardToken: input.currentBoardToken,
      proposedSourceType: candidate.provider,
      proposedBoardToken: candidate.boardToken,
      proposedCanonicalUrl: candidate.canonicalUrl,
      confidence: candidate.confidence,
      validationStatus: candidate.validationStatus,
      recommendation: candidate.recommendation,
      evidenceJson,
    });
  return rowToProposal(inserted);
}

export class ProposalApprovalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProposalApprovalError";
    this.code = code;
  }
}

/**
 * The ONLY function in this Stage that ever mutates companies/job_sources. Atomic (single
 * transaction): every precondition is checked before any write happens, and if any fails the whole
 * call throws with nothing written.
 *
 * Preconditions (Phase 5, in order): proposal exists; belongs to companyId (isolation); status is
 * PENDING_REVIEW; company's CURRENT source_type/ats_board_token still match what this proposal was
 * created against (staleness — a mismatch marks the proposal SUPERSEDED instead of applying it);
 * validation was genuinely successful; confidence is not LOW; provider is supported (implied by a
 * successful validation, which only ever happens for a supported provider); not a security
 * rejection (implied by validation status).
 *
 * On success: recordDiscoveryResult (the same function every other discovery result flows through)
 * updates companies.source_type/ats_board_token/resolution_status and syncs job_sources' identity —
 * which, via organizationRegistryCore.ts's own existing "identity changed -> review_status resets to
 * PENDING" rule, first clears any stale prior approval — then reviewJobSource immediately marks it
 * APPROVED, since a human just explicitly reviewed and approved THIS exact candidate through this
 * call (the same two-step pattern already established for recordDiscoveryResult + reviewJobSource
 * elsewhere in this codebase). resetConnectorFailureState clears stale failure bookkeeping.
 * Historical jobs are never touched, and no scan is ever triggered here.
 */
export function approveProposal(companyId: number, proposalId: number, reviewNote?: string): AtsSourceProposal {
  const db = getDb();

  // Existence/ownership/status/staleness checks run OUTSIDE the atomic-approval transaction below.
  // The staleness branch below must WRITE (mark SUPERSEDED) and then throw — better-sqlite3 rolls
  // back every write made inside a transaction() callback that throws, so doing that write inside
  // the same transaction as the real approval would silently discard the supersession itself,
  // leaving the proposal stuck at PENDING_REVIEW forever. Running it here, before the transaction
  // opens, is what actually makes it durable.
  const proposal = getProposal(proposalId);
  if (!proposal) throw new ProposalApprovalError("NOT_FOUND", `Proposal ${proposalId} does not exist`);
  if (proposal.company_id !== companyId) {
    throw new ProposalApprovalError("COMPANY_MISMATCH", `Proposal ${proposalId} does not belong to company ${companyId}`);
  }
  if (proposal.status !== "PENDING_REVIEW") {
    throw new ProposalApprovalError("NOT_PENDING", `Proposal ${proposalId} is ${proposal.status}, not PENDING_REVIEW`);
  }

  const company = getCompany(companyId);
  if (!company) throw new ProposalApprovalError("COMPANY_NOT_FOUND", `Company ${companyId} does not exist`);

  const isStale = company.source_type !== proposal.current_source_type || company.ats_board_token !== proposal.current_board_token;
  if (isStale) {
    db.prepare(
      `UPDATE ats_source_proposals SET status = 'SUPERSEDED', reviewed_at = datetime('now'),
         review_note = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(`Auto-superseded at approval attempt: company source changed from what this proposal was created against`, proposalId);
    throw new ProposalApprovalError(
      "STALE_PROPOSAL",
      `Proposal ${proposalId} is stale — company ${companyId}'s current source (${company.source_type}/${company.ats_board_token}) no longer matches what this proposal was created against (${proposal.current_source_type}/${proposal.current_board_token})`
    );
  }

  if (!isProposalApprovable(proposal)) {
    throw new ProposalApprovalError(
      "NOT_APPROVABLE",
      `Proposal ${proposalId} is not approvable (confidence=${proposal.confidence}, validation_status=${proposal.validation_status})`
    );
  }

  return db.transaction(() => {
    recordDiscoveryResult(companyId, {
      status: "VERIFIED",
      sourceType: proposal.proposed_source_type,
      atsBoardToken: proposal.proposed_board_token,
      discoveredJobsUrl: proposal.proposed_canonical_url,
      reason: `Approved Discovery V2 source proposal #${proposalId}`,
      suspectedAts: null,
    });

    const jobSourceRow = db
      .prepare("SELECT id FROM job_sources WHERE legacy_company_id = ?")
      .get(companyId) as { id: number } | undefined;
    if (jobSourceRow) {
      reviewJobSource(jobSourceRow.id, "APPROVED", `Approved via Discovery V2 source proposal #${proposalId}`);
    }

    resetConnectorFailureState(companyId, `Source approved via Discovery V2 proposal #${proposalId} (was: ${proposal.current_source_type ?? "none"}/${proposal.current_board_token ?? "none"})`);

    db.prepare(
      `UPDATE ats_source_proposals SET status = 'APPROVED', reviewed_at = datetime('now'),
         review_note = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(reviewNote ?? null, proposalId);

    return getProposal(proposalId)!;
  })();
}

/**
 * Marks a proposal REJECTED. Never touches companies/job_sources. The rejection itself is what
 * prevents createProposalFromDiscoveryV2 from immediately recreating an identical pending proposal
 * on the next shadow run (see that function's own dedup rule) — no separate blacklist needed, and
 * nothing here forbids the same ATS provider/token from being proposed again for a genuinely
 * DIFFERENT reason later (a SUPERSEDED or freshly-changed identity still creates a new proposal).
 */
export function rejectProposal(companyId: number, proposalId: number, reviewNote?: string): AtsSourceProposal {
  const proposal = getProposal(proposalId);
  if (!proposal) throw new ProposalApprovalError("NOT_FOUND", `Proposal ${proposalId} does not exist`);
  if (proposal.company_id !== companyId) {
    throw new ProposalApprovalError("COMPANY_MISMATCH", `Proposal ${proposalId} does not belong to company ${companyId}`);
  }
  if (proposal.status !== "PENDING_REVIEW") {
    throw new ProposalApprovalError("NOT_PENDING", `Proposal ${proposalId} is ${proposal.status}, not PENDING_REVIEW`);
  }
  getDb()
    .prepare(
      `UPDATE ats_source_proposals SET status = 'REJECTED', reviewed_at = datetime('now'),
         review_note = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(reviewNote ?? null, proposalId);
  return getProposal(proposalId)!;
}
