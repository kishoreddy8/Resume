import { z } from "zod";
import { getDb } from "@/db";
import { checkConnectorHealth, type ConnectorHealthCandidate } from "@/lib/ats/connectorHealthCheck";
import { HEALTH_PROBE_PROVIDERS, providerSqlList } from "@/lib/ats/scannableProviders";
import type { fetchJobsForCompany } from "@/lib/normalize";
import type { Consequence } from "@/lib/auth/mutationPolicy";
import type { RepairabilityClass } from "./subsystemHealth";
import type { Company, ErrorCategory, SourceType } from "@/types";
import { getDiscoveryConnectorHealth, type DiscoveryConnectorHealth } from "./discoveryConnectorHealth";
import type { HealthStatus } from "./healthRules";

/**
 * ADMIN-OPS-4 — the closed registry of repairs Admin is allowed to execute.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE. Executing a repair never makes anything healthy. A
 * handler may change the world; only NEW RUNTIME EVIDENCE, observed after the repair started, may
 * change a health verdict. Every type below is shaped to keep those two facts separate — which is
 * why the result carries `actionStatus` and `verificationStatus` as independent fields and why there
 * is no `fixed` flag anywhere in this module.
 *
 * WHY A REGISTRY AND NOT A COMMAND ENDPOINT. A repair endpoint that accepted a function name, a
 * shell string, a module path or a pass-through payload would be a remote code execution surface
 * wearing an operations hat. Callers may name a repair and supply values that a per-repair zod schema
 * validates; nothing else crosses the boundary. Adding a repair requires a code change, a descriptor,
 * an eligibility predicate, a verification contract and a test — deliberately more work than editing
 * a config file.
 *
 * WHY ONLY ONE REPAIR. The audit looked for real recovery actions rather than inventing them, and
 * most candidates disqualified themselves on evidence:
 *
 *   circuit breaker reset  — impossible. circuitBreaker.ts persists NO state; every decision is
 *                            re-derived from windowed scan history, so there is nothing to reset and
 *                            a "reset" could only mean falsifying that history. It already recovers
 *                            on its own as real scans succeed (AUTO_RECOVERABLE).
 *   clear stale scan lock  — unnecessary AND unprovable. acquireScanLock already takes over a lock
 *                            older than STALE_LOCK_TIMEOUT_MINUTES atomically, and the lock value is
 *                            a bare timestamp with no owner or PID, so Admin cannot demonstrate the
 *                            holder is dead. Clearing a live lock would let two scans run at once.
 *   retry one source scan  — already exists as POST /api/scan {companyId}, operator-guarded, using
 *                            the shared lock and normal normalisation. mutationPolicy's own
 *                            FUTURE_REPAIR_ROUTE_GUARD note forbids a repair route becoming a second
 *                            way to do something that already has a path.
 *   retry resume writer    — already exists, and is CANDIDATE-scoped
 *                            (…/quality-workflow/retry-writer, requireCandidateAccess). Operator
 *                            authority is not a substitute for candidate authority.
 *   restart the worker     — no in-process mechanism exists. The worker is launchd/external, and
 *                            inventing process control here was explicitly out of scope.
 *   fix configuration      — CONFIGURATION_REQUIRED. A missing credential is repaired in the server
 *                            environment by a person; no endpoint can honestly claim to do it.
 *
 * What remains is one genuinely safe, genuinely verifiable action: re-run the bounded read-only
 * connector probe for a single source.
 */

/** Closed set. A string outside this union can never reach a handler. */
export type RepairId = "recheck_discovery_connector";

export type ActionStatus = "EXECUTED" | "REJECTED_INELIGIBLE" | "FAILED";

/**
 * What fresh evidence said, which is a different question from whether the action ran.
 *
 * NO_FRESH_EVIDENCE is not a synonym for failure — it means the repair produced nothing observable
 * yet, and the honest answer is that recovery is unproven.
 */
export type VerificationStatus =
  | "VERIFIED_RECOVERED"
  | "VERIFIED_STILL_FAILING"
  | "NO_FRESH_EVIDENCE"
  | "NOT_ATTEMPTED";

/**
 * Whether an action repairs a root cause or merely re-observes one.
 *
 * ADMIN-OPS-4.1 made this explicit rather than leaving it to wording. The only registered action
 * re-runs a probe: it cannot mend a provider outage or supply a missing credential, and a UI that
 * filed it under "Fix" would promise something the product cannot do. A machine-readable kind lets
 * the UI label it correctly without having to interpret prose.
 */
export type ActionKind =
  /** Re-observes current reality. Changes nothing; may confirm an external fix already made. */
  | "DIAGNOSTIC"
  /** Acts on state Career-Ops owns, with the intent of restoring service. None exist yet. */
  | "REPAIR";

export interface RepairDescriptor {
  repairId: RepairId;
  subsystem: "DISCOVERY_CONNECTOR";
  kind: ActionKind;
  /** Operator-facing. Says what the action does, never what it fixes. */
  title: string;
  description: string;
  /** Same vocabulary the mutation policy uses — not a second severity scale. */
  consequence: Consequence;
  /** Safe to invoke repeatedly. Every registered repair must be, or it does not belong here. */
  idempotent: boolean;
  requiresOperator: true;
  /** What would prove recovery. Stated up front so a caller cannot invent its own criterion. */
  verificationDescription: string;
}

export const REPAIR_DESCRIPTORS: Readonly<Record<RepairId, RepairDescriptor>> = {
  recheck_discovery_connector: {
    repairId: "recheck_discovery_connector",
    subsystem: "DISCOVERY_CONNECTOR",
    /* DIAGNOSTIC, not REPAIR: re-probing a broken connector records another failure. Its value is
     * confirming an external fix, or replacing stale evidence with current evidence. */
    kind: "DIAGNOSTIC",
    title: "Re-check discovery connector",
    /* Named for what it does. "Fix connector" would be a lie: this re-observes, and re-observing a
     * broken connector records another failure. Its value is confirming an external fix, or turning
     * stale evidence into current evidence. */
    description:
      "Re-runs the read-only connector probe for one approved source: fetches at most one job, records the outcome, and changes nothing about the source, its approval, or any job.",
    consequence: "LOW",
    idempotent: true,
    requiresOperator: true,
    verificationDescription:
      "A connector_health_check_runs row for this source, finished after the repair started, whose outcome is healthy.",
  },
} as const;

/** Per-repair input schema. Narrow and closed — no pass-through payload reaches a handler. */
export const REPAIR_INPUT_SCHEMAS = {
  recheck_discovery_connector: z.object({ jobSourceId: z.number().int().positive() }).strict(),
} as const satisfies Record<RepairId, z.ZodTypeAny>;

export type RepairInput<K extends RepairId> = z.infer<(typeof REPAIR_INPUT_SCHEMAS)[K]>;

export function isRepairId(value: unknown): value is RepairId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REPAIR_DESCRIPTORS, value);
}

export interface EligibilityVerdict {
  eligible: boolean;
  /** Machine-readable, so a consumer never string-matches prose. */
  reasonCode: string;
  reason: string;
}

interface SourceRow {
  job_source_id: number;
  organization_id: number;
  legacy_company_id: number;
  canonical_name: string;
  provider: SourceType;
}

/**
 * Resolves one source under exactly the conditions the batch probe already requires of a candidate
 * (active, authoritative, verified, approved, probeable provider, active company). This is a lookup
 * of an existing population, not a second selection policy — the conditions are copied from
 * listConnectorHealthCandidates so a repair can never reach a source the scheduled checker would
 * refuse to touch.
 */
function findProbeableSource(jobSourceId: number): SourceRow | null {
  const row = getDb()
    .prepare(
      `SELECT js.id AS job_source_id, js.organization_id, js.legacy_company_id,
              o.canonical_name, js.provider
         FROM job_sources js
         JOIN organizations o ON o.id = js.organization_id
         JOIN companies c ON c.id = js.legacy_company_id
        WHERE js.id = ?
          AND js.is_active = 1 AND js.is_authoritative = 1
          AND js.resolution_status = 'VERIFIED' AND js.review_status = 'APPROVED'
          AND js.provider IN (${providerSqlList(HEALTH_PROBE_PROVIDERS)})
          AND c.is_active = 1`
    )
    .get(jobSourceId) as SourceRow | undefined;
  return row ?? null;
}

/**
 * Whether this repair may run against this input, given the world as it is right now.
 *
 * A NOTE ON invalid_config, because the two requirements here look contradictory. A configuration
 * failure is NOT offered as an available repair (see repairabilityFor below: a missing credential is
 * fixed in the environment, and claiming otherwise would be exactly the fake automatic fix this
 * phase forbids). Execution, however, stays permitted, because re-observing is always safe and is
 * precisely how an operator confirms a fix they just made outside the app. Blocking execution on the
 * last failure category would deadlock: the evidence can only change by re-observing.
 */
export function checkEligibility<K extends RepairId>(repairId: K, input: RepairInput<K>): EligibilityVerdict {
  if (repairId === "recheck_discovery_connector") {
    const { jobSourceId } = input as RepairInput<"recheck_discovery_connector">;
    const source = findProbeableSource(jobSourceId);
    if (!source) {
      return {
        eligible: false,
        reasonCode: "SOURCE_NOT_PROBEABLE",
        reason:
          "No active, verified, approved source with a discovery connector matches that id. A repair may not reach a source the scheduled checker would refuse.",
      };
    }
    return { eligible: true, reasonCode: "SOURCE_PROBEABLE", reason: `Source ${jobSourceId} is approved and probeable.` };
  }
  /* Unreachable while RepairId has one member; kept so adding an id without an predicate fails to
   * compile rather than silently defaulting to eligible. */
  return { eligible: false, reasonCode: "NO_PREDICATE", reason: "No eligibility predicate is defined for this repair." };
}

export interface RepairResult {
  repairId: RepairId;
  actionStatus: ActionStatus;
  /** Machine-readable outcome discriminator for the action itself. */
  actionReasonCode: string;
  actionDetail: string;
  /** The instant verification measures freshness against. Evidence at or before this proves nothing. */
  repairStartedAt: string;
  /** Health as observed BEFORE the action, so a caller can see it did not move by fiat. */
  healthBefore: HealthStatus;
  /** Health re-derived from evidence AFTER the action. Derived, never assigned. */
  healthAfter: HealthStatus;
  verificationStatus: VerificationStatus;
  verificationDetail: string;
}

/** Options are SERVER-side only. Nothing here is reachable from an HTTP payload. */
export interface ExecuteRepairOptions {
  /** Test seam. The route never supplies this, so production always uses the real connector. */
  fetcher?: typeof fetchJobsForCompany;
}

/**
 * Timestamp sanity for a piece of evidence, using the OPS-1 rules: unparseable is not usable, and a
 * timestamp in the future is not usable either — clock skew or a bad write must never satisfy a
 * verification it did not earn.
 *
 * Exported because it is the fail-closed half of the freshness rule and deserves direct tests; the
 * identity half (below) is what actually selects the row.
 */
export function isUsableEvidenceTimestamp(
  observedAt: string | null,
  notBefore: string,
  now: Date = new Date()
): boolean {
  if (!observedAt) return false;
  const observed = new Date(observedAt).getTime();
  const floor = new Date(notBefore).getTime();
  if (!Number.isFinite(observed) || !Number.isFinite(floor)) return false;
  if (observed > now.getTime()) return false;
  return observed >= floor;
}

function providerHealth(provider: SourceType): HealthStatus {
  const row = getDiscoveryConnectorHealth().find((c) => c.provider === provider);
  if (!row) return "NO_DATA";
  /* The probe is what this repair produces evidence for, so the probe reading is what may move. */
  return row.probe.status;
}

interface FreshProbeRow {
  outcome: string;
  finished_at: string;
  error_category: string | null;
}

/**
 * Re-reads the ONE evidence row this repair's own probe persisted, by id.
 *
 * ADMIN-OPS-4.1 replaced a watermark scan ("any row for this source with an id above the pre-repair
 * maximum") with exact identity, because the scan could misreport. Two probes of the same source
 * overlapping — two operators, or an operator racing the scheduled connector-health batch — both
 * capture the same watermark; whichever reads last sees the OTHER probe's row and reports its
 * outcome as its own. A failing probe could therefore announce VERIFIED_RECOVERED on the strength of
 * a stranger's success, which is exactly the unearned claim this phase exists to prevent.
 *
 * The row is still re-read from storage rather than taken from the checker's return value: the
 * verdict must come from what was persisted, not from what a handler says it did. Scoping by
 * job_source_id as well as id is belt-and-braces — the id alone is unique — so a mismatched pair can
 * never resolve to another source's evidence.
 */
function evidenceById(jobSourceId: number, evidenceId: number): FreshProbeRow | null {
  const row = getDb()
    .prepare(
      `SELECT outcome, finished_at, error_category
         FROM connector_health_check_runs
        WHERE id = ? AND job_source_id = ?`
    )
    .get(evidenceId, jobSourceId) as FreshProbeRow | undefined;
  return row ?? null;
}

const HEALTHY_PROBE_OUTCOMES = new Set(["HEALTHY_JOBS", "HEALTHY_EMPTY"]);

/**
 * Executes one registered repair and reports what happened — separately from what it proved.
 *
 * The order is deliberate: read health BEFORE, stamp the start, act, then RE-DERIVE health from
 * storage. `healthAfter` is never computed from the action's return value, because a handler's own
 * opinion of its success is exactly the thing that must not be trusted.
 */
export async function executeRepair<K extends RepairId>(
  repairId: K,
  input: RepairInput<K>,
  options: ExecuteRepairOptions = {}
): Promise<RepairResult> {
  const eligibility = checkEligibility(repairId, input);
  const repairStartedAt = new Date().toISOString();

  if (repairId !== "recheck_discovery_connector") {
    return {
      repairId,
      actionStatus: "REJECTED_INELIGIBLE",
      actionReasonCode: "UNKNOWN_REPAIR",
      actionDetail: "No handler is registered for this repair.",
      repairStartedAt,
      healthBefore: "NO_DATA",
      healthAfter: "NO_DATA",
      verificationStatus: "NOT_ATTEMPTED",
      verificationDetail: "The action did not run, so nothing could be verified.",
    };
  }

  const { jobSourceId } = input as RepairInput<"recheck_discovery_connector">;
  const source = findProbeableSource(jobSourceId);

  if (!eligibility.eligible || !source) {
    return {
      repairId,
      actionStatus: "REJECTED_INELIGIBLE",
      actionReasonCode: eligibility.reasonCode,
      actionDetail: eligibility.reason,
      repairStartedAt,
      healthBefore: "NO_DATA",
      healthAfter: "NO_DATA",
      verificationStatus: "NOT_ATTEMPTED",
      verificationDetail: "The action did not run, so nothing could be verified.",
    };
  }

  const healthBefore = providerHealth(source.provider);
  const company = getDb().prepare("SELECT * FROM companies WHERE id = ?").get(source.legacy_company_id) as
    | Company
    | undefined;

  if (!company) {
    return {
      repairId,
      actionStatus: "REJECTED_INELIGIBLE",
      actionReasonCode: "COMPANY_MISSING",
      actionDetail: "The source's company row could not be loaded.",
      repairStartedAt,
      healthBefore,
      healthAfter: healthBefore,
      verificationStatus: "NOT_ATTEMPTED",
      verificationDetail: "The action did not run, so nothing could be verified.",
    };
  }

  const candidate: ConnectorHealthCandidate = {
    jobSourceId: source.job_source_id,
    organizationId: source.organization_id,
    companyId: source.legacy_company_id,
    canonicalName: source.canonical_name,
    provider: source.provider as ConnectorHealthCandidate["provider"],
    company,
  };

  let actionStatus: ActionStatus = "EXECUTED";
  let actionReasonCode = "PROBE_RECORDED";
  let actionDetail = "The connector probe ran and its outcome was recorded as evidence.";

  let evidenceId: number | null = null;
  try {
    /* persist:true on purpose — the recorded row IS the fresh evidence verification depends on.
     * A probe that changed nothing observable could never prove anything. The returned id is what
     * makes "this repair's evidence" exact rather than merely "recent". */
    const probe = await checkConnectorHealth(candidate, { persist: true, fetcher: options.fetcher });
    evidenceId = probe.evidenceId;
  } catch (error) {
    /* checkConnectorHealth catches connector failures internally and records them, so reaching here
     * means the recorder itself failed. The action failed; that is not a health verdict. */
    actionStatus = "FAILED";
    actionReasonCode = "PROBE_NOT_RECORDED";
    actionDetail = error instanceof Error ? `The probe could not be recorded: ${error.name}` : "The probe could not be recorded.";
  }

  /* Re-observed from storage, not from the call above. */
  const healthAfter = providerHealth(source.provider);
  const fresh = evidenceId === null ? null : evidenceById(jobSourceId, evidenceId);
  const isFresh = fresh !== null && isUsableEvidenceTimestamp(fresh.finished_at, repairStartedAt);

  let verificationStatus: VerificationStatus;
  let verificationDetail: string;
  if (actionStatus !== "EXECUTED") {
    verificationStatus = "NOT_ATTEMPTED";
    verificationDetail = "The action did not complete, so no new evidence was expected.";
  } else if (!isFresh) {
    verificationStatus = "NO_FRESH_EVIDENCE";
    verificationDetail = fresh
      ? "This repair's probe recorded an unusable timestamp, so it cannot verify anything. Recovery is unproven."
      : "This repair persisted no evidence of its own. Recovery is unproven — no other row, however recent, may stand in for it.";
  } else if (HEALTHY_PROBE_OUTCOMES.has(fresh!.outcome)) {
    verificationStatus = "VERIFIED_RECOVERED";
    verificationDetail = `A probe finished at ${fresh!.finished_at} reached the connector successfully.`;
  } else {
    verificationStatus = "VERIFIED_STILL_FAILING";
    verificationDetail = `A probe finished at ${fresh!.finished_at} failed${
      fresh!.error_category ? ` (${fresh!.error_category})` : ""
    }. The action ran; the connector is still not working.`;
  }

  return {
    repairId,
    actionStatus,
    actionReasonCode,
    actionDetail,
    repairStartedAt,
    healthBefore,
    healthAfter,
    verificationStatus,
    verificationDetail,
  };
}

/* ================================================================================================
 * Repairability projection — what an operator can do about a provider, grounded in its evidence.
 * ============================================================================================== */

export interface RepairOffer {
  repairId: RepairId;
  kind: ActionKind;
  title: string;
  consequence: Consequence;
  verificationDescription: string;
}

export interface ProviderRepairability {
  repairability: RepairabilityClass;
  reason: string;
  /**
   * Actions an operator may take here, each labelled with its kind. Named "actions" rather than
   * "repairs" deliberately: every entry today is DIAGNOSTIC, and a field called availableRepairs
   * invites a UI to render a re-check as a fix. Empty is a truthful answer, not a gap.
   */
  availableActions: RepairOffer[];
}

function offer(repairId: RepairId): RepairOffer {
  const d = REPAIR_DESCRIPTORS[repairId];
  return {
    repairId: d.repairId, kind: d.kind, title: d.title,
    consequence: d.consequence, verificationDescription: d.verificationDescription,
  };
}

/**
 * Classifies a provider using the vocabulary ADMIN-OPS-1 already defined (RepairabilityClass) rather
 * than inventing a second one, and offers an action only where one genuinely exists.
 *
 * The ordering matters: a configuration problem is diagnosed before a generic failure, because
 * `invalid_config` and a provider outage both surface as a failed connector and only the second one
 * is worth re-checking.
 */
export function repairabilityFor(row: DiscoveryConnectorHealth): ProviderRepairability {
  const lastCategory: ErrorCategory | null =
    row.production.lastFailureCategory ?? row.probe.lastFailureCategory ?? null;

  if (lastCategory === "invalid_config") {
    return {
      repairability: "CONFIGURATION_REQUIRED",
      reason:
        "The most recent failure was a configuration problem. It is fixed by setting the required value in the server environment — no in-app action can do it, and re-checking before then would only record the same failure.",
      availableActions: [],
    };
  }

  if (row.probe.status === "NO_DATA" && row.production.status === "NO_DATA") {
    if (row.configuredSourceCount === 0) {
      return {
        repairability: "CONFIGURATION_REQUIRED",
        reason: "The connector exists but no source is registered for it, so there is nothing to check.",
        availableActions: [],
      };
    }
    return {
      repairability: "UNKNOWN",
      reason: "Sources are configured but nothing has ever been observed, so no cause has been established.",
      availableActions: [offer("recheck_discovery_connector")],
    };
  }

  if (row.probe.status === "ERROR" || row.production.status === "ERROR" || row.production.status === "WARNING") {
    return {
      repairability: "EXTERNAL_FAILURE",
      reason:
        "Requests to the provider are failing. The cause is outside this machine, so the available action re-observes rather than repairs — useful to confirm a provider has recovered or an external fix worked.",
      availableActions: [offer("recheck_discovery_connector")],
    };
  }

  return {
    repairability: "AUTO_RECOVERABLE",
    reason: "The most recent evidence is healthy; nothing needs repairing.",
    availableActions: [],
  };
}
