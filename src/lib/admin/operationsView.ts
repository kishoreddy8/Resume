import { getDbHealth } from "@/db/health";
import { getApplicationsWindowSummary } from "@/db/queries/applicationRuns";
import {
  getNotificationsCreatedInWindow,
  getScanningWindowSummary,
  WINDOW_DAYS,
  type WindowKey,
} from "@/db/queries/operations";
import { getAppSettings } from "@/db/queries/settings";
import { automatedSourceTypes } from "@/lib/apply/agent/selectAdapter";
import {
  SCHEDULER_TICK_LIVENESS_TIMEOUT_MINUTES,
  classifyNotificationsHealth,
  classifyScanningHealth,
  classifySystemHealth,
  type HealthStatus,
} from "@/lib/operations/healthRules";
import { getDiscoveryConnectorHealth } from "@/lib/operations/discoveryConnectorHealth";
import { REPAIR_DESCRIPTORS, repairabilityFor, type ActionKind } from "@/lib/operations/repairRegistry";
import { buildHealth, isStale, type HealthEvidence, type RepairabilityClass, type SubsystemHealth } from "@/lib/operations/subsystemHealth";
import { getConfiguredSchedulerHost } from "@/lib/scheduler/host";
import { getSchedulerRuntimeState } from "@/lib/scheduler/state";
import { readBackgroundWorkerStatus } from "@/lib/scheduler/workerStatus";
import { getResumeWriterHealth, type ResumeWriterHealthState } from "@/lib/resumeQuality/writers/writerHealth";
import { applicationsHealth, compareRuntimeVersions } from "./overview";
import { getLoadedResumeWriterRuntimeContract } from "@/lib/resumeQuality/runtimeContract";

/**
 * ADMIN-OPS-5 — the final operator view-model. One shape, assembled server-side, that Admin can
 * render without doing any diagnosis of its own.
 *
 * WHAT THIS IS FOR. Every prior phase put a decision somewhere defensible — health in healthRules,
 * capability in atsCapability, evidence in discoveryConnectorHealth, actions in repairRegistry — but
 * none of them produced a thing a screen could draw. The old getAdminOverview returns bare status
 * enums with no summary, reason, evidence, timestamp, repairability or actions, so a UI consuming it
 * would have to re-derive all six. Re-derived judgement is how a screen ends up disagreeing with the
 * server about whether something is broken. So the rule here is that Admin never infers: if a fact
 * is not in this model, the UI must not display it.
 *
 * THIS AGGREGATES, IT DOES NOT CLASSIFY. Every status below comes from the existing authority for
 * that concern. Nothing in this file decides whether a subsystem is healthy; it decides how to
 * PRESENT what those authorities already concluded, and attaches the evidence they were derived from.
 *
 * ONE VOCABULARY. Every tile reports HealthStatus. The resume writer is the one subsystem with a
 * richer native state (twelve values, consumed by candidate-facing UI), and it is mapped here
 * explicitly rather than passed through — see WRITER_HEALTH below. The legacy getAdminOverview keeps
 * emitting the raw writer state for its existing consumers; this model does not.
 *
 * NO SCORE. There is no composite number, percentage or grade. A single figure would have to invent
 * weights between "the scanner is off because you turned it off" and "the database is corrupt", and
 * the honest presentation of several independent subsystems is several independent verdicts.
 */

/** An action a UI may offer. Mirrors the repair registry — the UI never decides an action's kind. */
export interface AdminAction {
  id: string;
  kind: ActionKind;
  title: string;
  description: string;
  consequence: string;
  available: boolean;
  /** Present only when available is false. Says what would have to change first. */
  unavailableReason?: string;
}

export interface AdminSubsystem extends SubsystemHealth {
  id: string;
  label: string;
  /**
   * Whether observedAt has aged past this subsystem's own freshness budget.
   *
   * Computed here so a UI never has to do date arithmetic to decide whether a green tile is
   * actually current — the exact inference this model exists to prevent. False when the fact does
   * not decay or nothing has been observed.
   */
  stale: boolean;
  availableActions: AdminAction[];
}

export interface AdminOperationsView {
  generatedAt: string;
  window: WindowKey;
  subsystems: AdminSubsystem[];
  /** Direct counts of subsystem verdicts. Not a score. */
  summary: Record<Lowercase<HealthStatus> | "requiresAction", number>;
  discovery: DiscoverySummary;
  applicationAutomation: ApplicationAutomationView;
}

export interface DiscoverySummary {
  connectors: number;
  scannable: number;
  configuredSources: number;
  byProductionStatus: Record<string, number>;
  byProbeStatus: Record<string, number>;
  byRepairability: Record<string, number>;
  /** Providers whose most recent evidence is a failure. Bounded, name-only — details live in the
   *  per-provider endpoint. */
  failingProviders: string[];
}

export interface ApplicationAutomationView {
  /** Derived from the runtime adapter registry, never from a written-down list. */
  adapters: { provider: string; runtimeAdapter: true; health: HealthStatus; reasonCode: string; summary: string }[];
  /** Platforms Career-Ops can FETCH from but cannot apply to. A count, not a judgement. */
  discoveryOnlyPlatforms: number;
  note: string;
}

/**
 * The writer's twelve native states, reduced to the shared vocabulary.
 *
 * Stated as a table rather than an if-chain so every value is visibly accounted for; a new writer
 * state fails to compile instead of silently defaulting to healthy. The two judgement calls worth
 * naming: WAITING_OUTSIDE_WINDOW is DISABLED because a configured schedule producing "not now" is a
 * choice rather than a fault, and the states needing a person (auth, subscription, stale approval,
 * contact) are WARNING rather than ERROR because nothing is broken — something is required.
 */
export const WRITER_HEALTH: Record<ResumeWriterHealthState, { status: HealthStatus; reasonCode: string }> = {
  PROCESSING: { status: "HEALTHY", reasonCode: "WRITER_PROCESSING" },
  WAITING_FOR_NEXT_ATTEMPT: { status: "HEALTHY", reasonCode: "WRITER_WAITING" },
  IDLE: { status: "HEALTHY", reasonCode: "WRITER_IDLE" },
  UNAVAILABLE_SCHEDULER_DISABLED: { status: "DISABLED", reasonCode: "SCHEDULER_DISABLED" },
  WAITING_OUTSIDE_WINDOW: { status: "DISABLED", reasonCode: "OUTSIDE_RUN_WINDOW" },
  /* Default only — refined by writerVerdict below, which is the mapping that actually runs. */
  UNAVAILABLE_NOT_RUNNING: { status: "ERROR", reasonCode: "WRITER_TICK_STALE" },
  TECHNICAL_FAILURE: { status: "ERROR", reasonCode: "WRITER_TECHNICAL_FAILURE" },
  BLOCKED_MAX_ATTEMPTS: { status: "ERROR", reasonCode: "WRITER_BLOCKED_MAX_ATTEMPTS" },
  CANDIDATE_CONTACT_REQUIRED: { status: "WARNING", reasonCode: "CANDIDATE_ACTION_REQUIRED" },
  SUBSCRIPTION_LIMIT_REACHED: { status: "WARNING", reasonCode: "SUBSCRIPTION_LIMIT_REACHED" },
  AUTH_REQUIRED: { status: "WARNING", reasonCode: "CONFIGURATION_REQUIRED" },
  UNAUTHORIZED_APPROVAL_STALE: { status: "WARNING", reasonCode: "APPROVAL_STALE" },
};

/**
 * The writer's verdict, with the one state whose meaning depends on evidence rather than on the
 * state alone.
 *
 * ADMIN-OPS-5.1 corrected this. UNAVAILABLE_NOT_RUNNING is produced by writerHealth's `!tickIsLive`
 * branch — a LIVENESS check, evaluated before the scheduler-disabled branch — and ADMIN-OPS-5 mapped
 * it to DISABLED. That would have told an operator the writer was switched off at the exact moment
 * its scheduler had died: the same false reassurance ADMIN-OPS-1 was created to remove, pointed the
 * other way. The state's own detail text already separates the two cases, so this does too:
 *
 *   never ticked  → NO_DATA. Nothing has ever been observed; "broken" would be an invention.
 *   ticked, stale → ERROR.   It ran and then stopped, which is a failure, not a choice.
 */
export function writerVerdict(writer: { state: ResumeWriterHealthState; lastTickAt: string | null }): {
  status: HealthStatus;
  reasonCode: string;
} {
  if (writer.state === "UNAVAILABLE_NOT_RUNNING") {
    return writer.lastTickAt === null
      ? { status: "NO_DATA", reasonCode: "WRITER_NEVER_RAN" }
      : { status: "ERROR", reasonCode: "WRITER_TICK_STALE" };
  }
  return WRITER_HEALTH[writer.state];
}

/** Verdicts that should draw an operator's eye. DISABLED is deliberately absent — an operator who
 *  turned something off does not need to be told about it every time they open the page. */
const NEEDS_ATTENTION: ReadonlySet<HealthStatus> = new Set<HealthStatus>(["ERROR", "WARNING"]);

const ts = (value: string | null): string | null => value;

/**
 * Builds one tile, enforcing the invariant that a verdict cites its evidence.
 *
 * buildHealth throws when a non-NO_DATA status carries no evidence. That is the whole reason this
 * model routes through it: a tile that says ERROR without saying what was observed is exactly the
 * kind of unexplained red a person cannot act on.
 */
function tile(input: {
  id: string;
  label: string;
  status: HealthStatus;
  summary: string;
  reasonCode: string;
  observedAt: string | null;
  staleAfterMs?: number | null;
  evidence: HealthEvidence[];
  repairability: RepairabilityClass;
  availableActions?: AdminAction[];
}): AdminSubsystem {
  const health = buildHealth({
    status: input.status,
    summary: input.summary,
    evidence: input.evidence,
    observedAt: input.observedAt,
    staleAfterMs: input.staleAfterMs ?? null,
    reasonCode: input.reasonCode,
    repairability: input.repairability,
  });
  return {
    id: input.id,
    label: input.label,
    ...health,
    stale: isStale(health),
    availableActions: input.availableActions ?? [],
  };
}

export function buildAdminOperationsView(window: WindowKey = "7d"): AdminOperationsView {
  const windowDays = WINDOW_DAYS[window];
  const settings = getAppSettings();
  const schedulerRuntime = getSchedulerRuntimeState();
  const worker = readBackgroundWorkerStatus();
  const host = getConfiguredSchedulerHost();
  const runtimeCompatibility = compareRuntimeVersions(getLoadedResumeWriterRuntimeContract(), worker);

  const subsystems: AdminSubsystem[] = [];

  /* --- Scheduler ------------------------------------------------------------------------------
   * classifySystemHealth is the authority on whether the CONFIGURED host is alive — the distinction
   * ADMIN-OPS-1 introduced after the default install reported DEGRADED forever for having no
   * standalone worker it was never supposed to have. */
  const schedulerStatus = classifySystemHealth({
    schedulerHost: host,
    workerRunning: worker.running,
    workerEverReported: worker.pid !== null,
    lastEvaluatedAt: schedulerRuntime.lastEvaluatedAt,
    runtimeCompatibility: runtimeCompatibility.state,
  });
  subsystems.push(
    tile({
      id: "scheduler",
      label: "Scheduler",
      status: schedulerStatus,
      reasonCode:
        schedulerStatus === "DISABLED"
          ? "SCHEDULER_HOST_NONE"
          : runtimeCompatibility.state === "MISMATCH"
            ? "RUNTIME_MISMATCH"
            : schedulerStatus === "NO_DATA"
              ? "NO_RECENT_EVIDENCE"
              : schedulerStatus === "ERROR"
                ? "SCHEDULER_STALE"
                : "SCHEDULER_ALIVE",
      summary: schedulerSummary(schedulerStatus, host, runtimeCompatibility.state),
      observedAt: ts(schedulerRuntime.lastEvaluatedAt),
      /* The same budget classifySystemHealth uses to call a tick stale — one authority, not two. */
      staleAfterMs: SCHEDULER_TICK_LIVENESS_TIMEOUT_MINUTES * 60_000,
      evidence: compact([
        ["Configured host", host],
        ["Last evaluated", schedulerRuntime.lastEvaluatedAt],
        ["Last scan succeeded", schedulerRuntime.lastScanSucceededAt],
        ["Runtime compatibility", runtimeCompatibility.state],
      ]),
      repairability:
        schedulerStatus === "DISABLED"
          ? "CONFIGURATION_REQUIRED"
          : schedulerStatus === "ERROR"
            ? "NOT_REPAIRABLE_FROM_ADMIN"
            : schedulerStatus === "NO_DATA"
              ? "UNKNOWN"
              : "AUTO_RECOVERABLE",
    })
  );

  /* --- Scanner (job discovery) ---------------------------------------------------------------- */
  const scanning = getScanningWindowSummary(windowDays);
  const scannerEnabled = settings.scheduler.enabled && settings.scheduler.scanEnabled;
  const scannerStatus: HealthStatus = scannerEnabled
    ? classifyScanningHealth({ window: scanning, schedulerEnabled: true })
    : "DISABLED";
  subsystems.push(
    tile({
      id: "scanner",
      label: "Job discovery",
      status: scannerStatus,
      reasonCode: !scannerEnabled
        ? "SCANNER_DISABLED"
        : scanning.runs === 0
          ? "NO_RECENT_EVIDENCE"
          : scanning.failedCount > 0
            ? "SCAN_FAILURES"
            : "SCANS_SUCCEEDING",
      summary: !scannerEnabled
        ? "Scanning is switched off, so no jobs are being discovered. Nothing is broken."
        : scanning.runs === 0
          ? `No scan has run in the last ${windowDays} day(s), so there is nothing to judge scanning by.`
          : `${scanning.successCount} of ${scanning.runs} scan(s) in the last ${windowDays} day(s) succeeded.`,
      observedAt: ts(schedulerRuntime.lastScanSucceededAt),
      evidence: compact([
        ["Runs in window", scanning.runs > 0 ? String(scanning.runs) : null],
        ["Succeeded", scanning.runs > 0 ? String(scanning.successCount) : null],
        ["Failed", scanning.runs > 0 ? String(scanning.failedCount) : null],
        ["Last successful scan", schedulerRuntime.lastScanSucceededAt],
        ["Enabled", scannerEnabled ? "yes" : "no"],
      ]),
      repairability: !scannerEnabled
        ? "CONFIGURATION_REQUIRED"
        : scanning.runs === 0
          ? "UNKNOWN"
          : scanning.failedCount > 0
            ? "EXTERNAL_FAILURE"
            : "AUTO_RECOVERABLE",
    })
  );

  /* --- Resume writer -------------------------------------------------------------------------- */
  const writer = getResumeWriterHealth();
  const mapped = writerVerdict(writer);
  subsystems.push(
    tile({
      id: "writer",
      label: "Resume writer",
      status: mapped.status,
      reasonCode: mapped.reasonCode,
      /* writer.detail is already an operator-facing sentence produced by the writer's own health
       * module — no raw error is passed through here. */
      summary: writer.detail,
      observedAt: ts(writer.lastPassCompletedAt ?? writer.lastTickAt),
      evidence: compact([
        ["Native state", writer.state],
        ["Last tick", writer.lastTickAt],
        ["Last pass completed", writer.lastPassCompletedAt],
        ["Last content produced", writer.lastSuccessAt],
        ["Pending workflows", String(writer.pendingWorkflowCount)],
      ]),
      repairability:
        mapped.status === "NO_DATA"
          ? "UNKNOWN"
          : mapped.status === "DISABLED" || mapped.reasonCode === "CONFIGURATION_REQUIRED"
            ? "CONFIGURATION_REQUIRED"
            : mapped.status === "ERROR" || mapped.status === "WARNING"
              ? "NOT_REPAIRABLE_FROM_ADMIN"
              : "AUTO_RECOVERABLE",
    })
  );

  /* --- Applications ---------------------------------------------------------------------------- */
  const applicationsWindow = getApplicationsWindowSummary(windowDays);
  const applicationsStatus = applicationsHealth(applicationsWindow);
  subsystems.push(
    tile({
      id: "applications",
      label: "Applications",
      status: applicationsStatus,
      reasonCode: applicationsWindow.total === 0 ? "NO_RECENT_EVIDENCE" : applicationsStatus === "HEALTHY" ? "RUNS_SUCCEEDING" : "RUN_FAILURES",
      summary:
        applicationsWindow.total === 0
          ? `No application run has been recorded in the last ${windowDays} day(s).`
          : `${applicationsWindow.total} application run(s) recorded in the last ${windowDays} day(s).`,
      observedAt: null,
      evidence:
        applicationsWindow.total === 0
          ? []
          : compact([["Runs in window", String(applicationsWindow.total)]]),
      repairability: applicationsWindow.total === 0 ? "UNKNOWN" : "NOT_REPAIRABLE_FROM_ADMIN",
    })
  );

  /* --- Notifications ---------------------------------------------------------------------------
   * classifyNotificationsHealth can only ever say HEALTHY or NO_DATA: no failure of the notification
   * pipeline is persisted anywhere, so claiming to know it is broken would be an invention. */
  const createdInWindow = getNotificationsCreatedInWindow(windowDays);
  const notificationsStatus = classifyNotificationsHealth({ createdInWindow, everCreated: createdInWindow });
  subsystems.push(
    tile({
      id: "notifications",
      label: "Notifications",
      status: notificationsStatus,
      reasonCode: notificationsStatus === "HEALTHY" ? "OUTPUT_PRODUCED" : "NO_RECENT_EVIDENCE",
      summary:
        notificationsStatus === "HEALTHY"
          ? `${createdInWindow} notification(s) produced in the last ${windowDays} day(s).`
          : `No notification has been produced in the last ${windowDays} day(s). Failures are not recorded anywhere, so this cannot distinguish "quiet" from "broken".`,
      observedAt: null,
      evidence: notificationsStatus === "HEALTHY" ? [{ label: "Created in window", value: String(createdInWindow) }] : [],
      repairability: "UNKNOWN",
    })
  );

  /* --- Database --------------------------------------------------------------------------------- */
  const db = getDbHealth();
  const dbStatus: HealthStatus = db.status === "healthy" ? "HEALTHY" : db.status === "recovering" ? "WARNING" : "ERROR";
  subsystems.push(
    tile({
      id: "database",
      label: "Database",
      status: dbStatus,
      reasonCode: db.status === "healthy" ? "DATABASE_SERVING" : db.status === "recovering" ? "DATABASE_RECOVERING" : "DATABASE_UNHEALTHY",
      summary:
        db.status === "healthy"
          ? "The database is serving reads and writes."
          : db.status === "recovering"
            ? "The database connection failed recently and was reopened."
            : "The database is not serving. Reads and writes are failing.",
      observedAt: ts(db.lastErrorAt ?? db.lastRecoveredAt),
      evidence: compact([
        ["Status", db.status],
        /* A SQLite result code is safe and actionable; the raw message is not carried here. */
        ["Last error code", db.lastErrorCode],
        ["Recovery attempts", db.recoveryAttempts > 0 ? String(db.recoveryAttempts) : null],
      ]),
      repairability: db.status === "healthy" ? "AUTO_RECOVERABLE" : db.status === "recovering" ? "AUTO_RECOVERABLE" : "NOT_REPAIRABLE_FROM_ADMIN",
    })
  );

  /* --- Discovery connectors (collection rollup) --------------------------------------------------
   * A tile, not the detail. Per-provider rows and their per-source actions live in the discovery
   * endpoint — a recheck needs a specific source id, so offering one here would be a promise this
   * level cannot keep. */
  const connectors = getDiscoveryConnectorHealth();
  const perProvider = connectors.map((row) => ({ row, repair: repairabilityFor(row) }));
  const failingProviders = perProvider
    .filter(({ row }) => row.production.status === "ERROR" || row.production.status === "WARNING" || row.probe.status === "ERROR")
    .map(({ row }) => row.provider as string);
  const configuredSources = connectors.reduce((n, c) => n + (c.configuredSourceCount ?? 0), 0);
  const observedProviders = perProvider.filter(({ row }) => row.primaryEvidence !== "NONE");

  const discoveryStatus: HealthStatus =
    observedProviders.length === 0 ? "NO_DATA" : failingProviders.length > 0 ? "WARNING" : "HEALTHY";
  subsystems.push(
    tile({
      id: "discovery_connectors",
      label: "Discovery connectors",
      status: discoveryStatus,
      reasonCode:
        discoveryStatus === "NO_DATA" ? "NO_RECENT_EVIDENCE" : failingProviders.length > 0 ? "PROVIDER_FAILURE" : "CONNECTORS_SUCCEEDING",
      summary:
        discoveryStatus === "NO_DATA"
          ? `${connectors.length} platforms have a discovery connector, but none has been observed working or failing.`
          : failingProviders.length > 0
            ? `${failingProviders.length} of ${observedProviders.length} observed provider(s) are failing.`
            : `All ${observedProviders.length} observed provider(s) are succeeding.`,
      observedAt: null,
      evidence:
        discoveryStatus === "NO_DATA"
          ? []
          : compact([
              ["Providers observed", String(observedProviders.length)],
              ["Providers failing", String(failingProviders.length)],
              ["Configured sources", String(configuredSources)],
            ]),
      repairability: discoveryStatus === "NO_DATA" ? "UNKNOWN" : failingProviders.length > 0 ? "EXTERNAL_FAILURE" : "AUTO_RECOVERABLE",
    })
  );

  const summary = {
    healthy: 0,
    warning: 0,
    error: 0,
    disabled: 0,
    no_data: 0,
    requiresAction: 0,
  } as unknown as AdminOperationsView["summary"];
  for (const s of subsystems) {
    const key = s.status.toLowerCase() as Lowercase<HealthStatus>;
    summary[key] = (summary[key] ?? 0) + 1;
    if (NEEDS_ATTENTION.has(s.status) || s.repairability === "CONFIGURATION_REQUIRED") summary.requiresAction += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    window,
    subsystems,
    summary,
    discovery: {
      connectors: connectors.length,
      scannable: connectors.filter((c) => c.capability === "SCANNABLE").length,
      configuredSources,
      byProductionStatus: tally(connectors.map((c) => c.production.status)),
      byProbeStatus: tally(connectors.map((c) => c.probe.status)),
      byRepairability: tally(perProvider.map(({ repair }) => repair.repairability)),
      failingProviders,
    },
    applicationAutomation: buildApplicationAutomation(connectors.length),
  };
}

/**
 * Application automation, reported as what can be PROVEN.
 *
 * The adapter list is derived from the runtime registry rather than any coverage document: a
 * platform is listed because code exists to apply to it, not because a spreadsheet says so. Health
 * is NO_DATA for all of them, and that is the truthful answer — no application run evidence is
 * attributed per adapter anywhere, so any other status would be invented. Platforms with a discovery
 * connector but no adapter are counted, never listed as broken: not being able to apply to Ashby is
 * a capability boundary, not a fault.
 */
function buildApplicationAutomation(discoveryConnectorCount: number): ApplicationAutomationView {
  const adapters = automatedSourceTypes().map((provider) => ({
    provider: provider as string,
    runtimeAdapter: true as const,
    health: "NO_DATA" as HealthStatus,
    reasonCode: "NO_RECENT_EVIDENCE",
    summary: "A runtime adapter exists. No per-adapter execution evidence is recorded, so its health is not observable.",
  }));
  return {
    adapters,
    discoveryOnlyPlatforms: Math.max(0, discoveryConnectorCount - adapters.length),
    note: "Application automation is separate from job discovery. A platform Career-Ops can fetch jobs from is not necessarily one it can apply to.",
  };
}

function schedulerSummary(status: HealthStatus, host: string, compatibility: string): string {
  if (status === "DISABLED") return "The scheduler host is set to none, so no automation runs. Nothing is broken.";
  if (compatibility === "MISMATCH") return "The web process and the background worker are running different code versions.";
  if (status === "NO_DATA") return `The scheduler is configured to run in the ${host} process but has not reported an evaluation yet.`;
  if (status === "ERROR") return `The ${host} scheduler has not evaluated recently enough to be considered alive.`;
  return `The ${host} scheduler is evaluating on schedule.`;
}

/** Drops evidence rows with no value, so absence is never rendered as an empty fact. */
function compact(rows: [string, string | null | undefined][]): HealthEvidence[] {
  return rows.filter((r): r is [string, string] => Boolean(r[1])).map(([label, value]) => ({ label, value }));
}

function tally(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
}

/** The full catalogue of actions that exist, so a UI never guesses at one. */
export function adminActionCatalog(): AdminAction[] {
  return Object.values(REPAIR_DESCRIPTORS).map((d) => ({
    id: d.repairId,
    kind: d.kind,
    title: d.title,
    description: d.description,
    consequence: d.consequence,
    available: true,
  }));
}
