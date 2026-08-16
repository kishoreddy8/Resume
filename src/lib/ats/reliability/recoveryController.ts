import { recordRediscoveryAttempt } from "@/db/queries/companies";
import { createProposalFromDiscoveryV2 } from "@/db/queries/atsSourceProposals";
import { listRediscoveryEligibleCompanies } from "@/db/queries/reliability";
import { discoverCompanySourceV2 } from "@/lib/ats/discoveryV2";
import { reconstructCanonicalUrl } from "@/lib/ats/sourceRediscovery";
import type { AtsSourceProposal, Company, SourceType } from "@/types";
import { CIRCUIT_PROBE_ALLOWANCE, getCircuitBreakerDecisions } from "./circuitBreaker";

/**
 * Connector Reliability Control Plane V1 — Phase 5's "recovery controller": the ONE place that
 * decides when a rediscovery-eligible company's failure is worth a bounded Discovery V2 attempt, and
 * bridges a resulting candidate into the EXISTING proposal system exactly like
 * src/lib/externalSignals/discoveryV2Bridge.ts already does for external-signal-driven coverage
 * mismatches — same two functions (discoverCompanySourceV2, createProposalFromDiscoveryV2), same
 * "never approves anything" contract, just triggered by connector failure instead of an external
 * observation. No second discovery engine, no second proposal system, no bypass of human approval —
 * see approveProposal's own doc comment (src/db/queries/atsSourceProposals.ts) for why that remains
 * the only source-mutating path in the whole codebase.
 */

export interface RecoveryAttemptOutcome {
  companyId: number;
  companyName: string;
  provider: SourceType;
  outcome: string;
  reason: string;
  candidateCount: number;
  proposalsCreated: AtsSourceProposal[];
}

export interface RecoveryControllerSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  eligibleFound: number;
  attempted: number;
  skippedByCircuitBreaker: { provider: SourceType; companyId: number; companyName: string }[];
  openCircuits: SourceType[];
  outcomes: RecoveryAttemptOutcome[];
  proposalsCreated: number;
}

export interface RunConnectorRecoveryOptions {
  /** Bounded batch size — Discovery V2 is a real browser render (see discoveryConfig.ts's
   *  MAX_V2_TOTAL_BUDGET_MS), so this stays small by default, matching
   *  listDiscoveryV2Candidates' own default of 5 (src/db/queries/organizationRegistry.ts). */
  limit?: number;
  /** Hours since the last rediscovery attempt before a company becomes eligible again — Phase 6's
   *  cooldown. 6 hours: frequent enough to make real same-day progress on a genuinely stale source,
   *  infrequent enough that a company failing every scheduler tick (which can run every few minutes)
   *  never gets more than a handful of expensive browser-rediscovery attempts per day. Not tuned
   *  from production dwell-time data (none exists yet) — a documented, conservative default. */
  cooldownHours?: number;
  /** Windowed lookback for the provider-level circuit breaker check — see circuitBreaker.ts. */
  circuitBreakerWindowHours?: number;
  discoverer?: typeof discoverCompanySourceV2;
}

function seedUrlFor(company: Company): string | null {
  if (company.career_page_url) return company.career_page_url;
  if (company.source_type && company.ats_board_token) {
    return reconstructCanonicalUrl(company.source_type, company.ats_board_token);
  }
  return null;
}

/**
 * Phase 4-8, composed: selects rediscovery-eligible companies (query layer already applies the
 * cooldown/exhaustion/pending-proposal filters), consults the circuit breaker per provider, and
 * bridges any genuine Discovery V2 candidate into a proposal. Records the attempt timestamp BEFORE
 * calling Discovery V2 (not after) so a crash mid-attempt still starts this company's cooldown —
 * the alternative (recording only on completion) would let a process that dies mid-render retry the
 * same expensive attempt again on the very next invocation, exactly the thrashing risk Phase 6 warns
 * about.
 */
export async function runConnectorRecovery(
  options: RunConnectorRecoveryOptions = {}
): Promise<RecoveryControllerSummary> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 5), 25));
  const cooldownHours = options.cooldownHours ?? 6;
  const discoverer = options.discoverer ?? discoverCompanySourceV2;

  const eligible = listRediscoveryEligibleCompanies(limit, cooldownHours);
  const circuitDecisions = getCircuitBreakerDecisions(options.circuitBreakerWindowHours ?? 24);
  const openCircuits = new Set(circuitDecisions.filter((d) => d.open).map((d) => d.provider));

  const probesUsedByProvider = new Map<SourceType, number>();
  const skippedByCircuitBreaker: RecoveryControllerSummary["skippedByCircuitBreaker"] = [];
  const outcomes: RecoveryAttemptOutcome[] = [];

  for (const { company } of eligible) {
    const provider = company.source_type;
    if (openCircuits.has(provider)) {
      const used = probesUsedByProvider.get(provider) ?? 0;
      if (used >= CIRCUIT_PROBE_ALLOWANCE) {
        skippedByCircuitBreaker.push({ provider, companyId: company.id, companyName: company.name });
        continue;
      }
      probesUsedByProvider.set(provider, used + 1);
    }

    // Recorded up front — see this function's own doc comment on why "before," not "after."
    recordRediscoveryAttempt(company.id);

    const seedUrl = seedUrlFor(company);
    if (!seedUrl) {
      outcomes.push({
        companyId: company.id,
        companyName: company.name,
        provider,
        outcome: "NO_INPUT_URL",
        reason: "No career_page_url on file and the current source could not be reconstructed into a URL.",
        candidateCount: 0,
        proposalsCreated: [],
      });
      continue;
    }

    const result = await discoverer(company, seedUrl);
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

    outcomes.push({
      companyId: company.id,
      companyName: company.name,
      provider,
      outcome: result.outcome,
      reason: result.reason,
      candidateCount: result.candidates.length,
      proposalsCreated,
    });
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    eligibleFound: eligible.length,
    attempted: outcomes.length,
    skippedByCircuitBreaker,
    openCircuits: [...openCircuits],
    outcomes,
    proposalsCreated: outcomes.reduce((sum, o) => sum + o.proposalsCreated.length, 0),
  };
}
