import { getCompany } from "@/db/queries/companies";
import { createProposalFromDiscoveryV2 } from "@/db/queries/atsSourceProposals";
import { discoverCompanySourceV2 } from "@/lib/ats/discoveryV2";
import type { AtsSourceProposal } from "@/types";
import type { ExternalHiringObservationRow } from "./types";

/**
 * Phase 11 — the ONLY bridge from an external observation to Discovery V2. Reuses
 * discoverCompanySourceV2 and createProposalFromDiscoveryV2 verbatim (the exact same functions Stage
 * 2/3/6 already use) — no second discovery engine, no second proposal system. Never approves
 * anything; a HIGH proposal still requires the existing human-approval path
 * (approveProposal/POST .../approve), and MEDIUM/LOW remain governed by the existing rules
 * (isProposalApprovable restricts production approval to HIGH+VALIDATED_JOBS — see Stage 4).
 *
 * Only called for COVERAGE_MISMATCH observations — see pipeline.ts's own bridging decision, which is
 * explicit-opt-in (--trigger-discovery-v2) in the shadow runner, never automatic.
 */
export interface DiscoveryV2BridgeResult {
  companyId: number;
  outcome: string;
  reason: string;
  candidateCount: number;
  proposalsCreated: AtsSourceProposal[];
}

export async function bridgeCoverageMismatchToDiscoveryV2(observation: ExternalHiringObservationRow): Promise<DiscoveryV2BridgeResult | null> {
  if (observation.matched_company_id === null) return null;
  const company = getCompany(observation.matched_company_id);
  if (!company) return null;

  // Prefer the strongest first-party evidence this observation carries as the seed — the employer's
  // own domain evidence outranks whatever career_page_url CareerOps already had on file (which may
  // be exactly what's stale/wrong).
  const seedUrl = observation.direct_employer_url ?? company.career_page_url ?? observation.observed_url;
  const result = await discoverCompanySourceV2(company, seedUrl);

  const proposalsCreated: AtsSourceProposal[] = [];
  for (const candidate of result.candidates) {
    const proposal = createProposalFromDiscoveryV2({
      companyId: company.id,
      currentSourceType: company.source_type,
      currentBoardToken: company.ats_board_token,
      candidate: {
        provider: candidate.provider,
        boardToken: candidate.boardToken,
        canonicalUrl: candidate.canonicalUrl,
        confidence: candidate.confidence,
        validationStatus: candidate.validationStatus,
        recommendation: candidate.recommendation,
        evidenceTypes: candidate.evidenceTypes,
        evidenceUrls: candidate.evidenceUrls,
      },
    });
    if (proposal) proposalsCreated.push(proposal);
  }

  return {
    companyId: company.id,
    outcome: result.outcome,
    reason: result.reason,
    candidateCount: result.candidates.length,
    proposalsCreated,
  };
}
