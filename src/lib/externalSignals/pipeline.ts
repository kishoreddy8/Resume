import { getDb } from "@/db";
import { getCompany } from "@/db/queries/companies";
import { upsertExternalHiringObservation, type UpsertObservationInput } from "@/db/queries/externalHiringObservations";
import { classifyEmployerRelationship, classifySignal, classifyUrlEvidence, evaluateQualityGate, type CoverageState } from "./classify";
import { matchCompanyForObservation } from "./companyMatch";
import { fingerprintFor, normalizeRawResult } from "./normalize";
import { stageSecondaryJob, type StageSecondaryJobResult } from "./secondaryIngestion";
import { bridgeCoverageMismatchToDiscoveryV2, type DiscoveryV2BridgeResult } from "./discoveryV2Bridge";
import type { ExternalHiringObservationRow, ExternalSignalSource, NormalizedExternalJob, ObservationDecision } from "./types";

/**
 * The one orchestration function tying every Stage 7 piece together (Phase 5's staging boundary):
 *   raw result -> normalize -> company match -> agency/URL classification -> quality gate ->
 *   signal classification -> [persist observation] -> [stage secondary job] -> [Discovery V2 bridge]
 *
 * Every side-effecting step is its own explicit boolean option, defaulting to false/off (Phase 12) —
 * calling this with no options is a pure, in-memory classification with ZERO database writes.
 */
export interface PipelineOptions {
  persistObservations?: boolean;
  persistSecondaryJobs?: boolean;
  triggerDiscoveryV2?: boolean;
}

export interface PipelineItemResult {
  normalized: NormalizedExternalJob;
  fingerprint: string;
  match: ReturnType<typeof matchCompanyForObservation>;
  employerRelationship: ReturnType<typeof classifyEmployerRelationship>;
  urlClassification: ReturnType<typeof classifyUrlEvidence>;
  signalClassification: ReturnType<typeof classifySignal>;
  decision: ObservationDecision;
  observation: ExternalHiringObservationRow | null;
  stagedJob: StageSecondaryJobResult | null;
  discoveryBridge: DiscoveryV2BridgeResult | null;
}

function getCoverageState(companyId: number | null): CoverageState | null {
  if (companyId === null) return null;
  const company = getCompany(companyId);
  if (!company) return null;
  const row = getDb().prepare("SELECT COUNT(*) AS c FROM jobs WHERE company_id = ? AND is_active = 1").get(companyId) as { c: number };
  return { activeJobCount: row.c, resolutionStatus: company.resolution_status };
}

export async function processExternalListing(
  source: ExternalSignalSource,
  raw: unknown,
  options: PipelineOptions = {}
): Promise<PipelineItemResult> {
  const normalized = normalizeRawResult(source, raw);
  const fingerprint = fingerprintFor(normalized);

  const match = matchCompanyForObservation(normalized);
  const employerRelationship = classifyEmployerRelationship(normalized, match);
  const urlClassification = classifyUrlEvidence(normalized, match);
  const coverage = getCoverageState(match.companyId);
  const signalClassification = classifySignal(match, employerRelationship, coverage);

  const gateResult = evaluateQualityGate(normalized, match, employerRelationship, urlClassification.classification);
  const decision: ObservationDecision = gateResult ?? (match.companyId ? "SECONDARY_JOB_CANDIDATE" : "DISCOVERY_BEACON_ONLY");

  let observation: ExternalHiringObservationRow | null = null;
  let stagedJob: StageSecondaryJobResult | null = null;
  let discoveryBridge: DiscoveryV2BridgeResult | null = null;

  if (options.persistObservations) {
    const input: UpsertObservationInput = {
      source,
      providerJobId: normalized.providerJobId,
      fingerprint,
      observedEmployerName: normalized.employerName,
      observedTitle: normalized.title,
      observedLocation: normalized.location,
      observedUrl: normalized.listingUrl,
      directEmployerUrl: normalized.directEmployerUrl,
      directApplyUrl: normalized.applyUrl,
      employerDomain: null,
      postedAt: normalized.postedAt,
      matchedCompanyId: match.companyId,
      matchConfidence: match.confidence,
      employerRelationship,
      urlClassification: urlClassification.classification,
      detectedAtsProvider: urlClassification.provider,
      detectedAtsBoardToken: urlClassification.boardToken,
      signalClassification,
      decision,
      evidenceJson: JSON.stringify({ raw: normalized.raw, matchReason: match.reason }),
    };
    observation = upsertExternalHiringObservation(input);

    if (options.persistSecondaryJobs && decision === "SECONDARY_JOB_CANDIDATE" && match.companyId) {
      stagedJob = stageSecondaryJob(observation, normalized, match.companyId);
    }

    if (options.triggerDiscoveryV2 && signalClassification === "COVERAGE_MISMATCH") {
      discoveryBridge = await bridgeCoverageMismatchToDiscoveryV2(observation);
    }
  }

  return { normalized, fingerprint, match, employerRelationship, urlClassification, signalClassification, decision, observation, stagedJob, discoveryBridge };
}
