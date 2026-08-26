"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApiUrl } from "@/lib/admin/client";
import {
  ACTION_KIND_PRESENTATION,
  CAPABILITY_PRESENTATION,
  HEALTH_PRESENTATION,
  REPAIRABILITY_PRESENTATION,
  awaitingEvidence,
  formatFreshness,
  needsAttention,
  orderForDisplay,
  primaryEvidenceLabel,
} from "@/lib/admin/healthPresentation";
import type { AdminOperationsView, AdminSubsystem } from "@/lib/admin/operationsView";

/**
 * UI-ADMIN-1 — the operations console.
 *
 * This component renders verdicts. It does not make them. Every status, staleness flag,
 * repairability class and action kind on screen arrives decided from
 * /api/admin/overview → operations, and the only computation here is wording and ordering.
 *
 * That constraint is the point rather than a stylistic preference. A screen that re-derives health
 * eventually disagrees with the server about whether something is broken, and the operator has no
 * way to tell which one is lying. So there is no threshold, no Date.now() comparison against
 * staleAfterMs, no "unhealthy therefore show a button", and no arithmetic that turns several
 * independent subsystems into one number.
 */

type WindowKey = "24h" | "7d" | "30d";

interface RepairAction {
  id: string;
  kind: "DIAGNOSTIC" | "REPAIR";
  title: string;
  description: string;
  consequence: string;
}

interface ConnectorEvidenceView {
  status: keyof typeof HEALTH_PRESENTATION;
  observedAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  failureCount: number;
  lastFailureCategory: string | null;
}

interface ConnectorRow {
  provider: string;
  capability: "SCANNABLE" | "CONNECTOR_NOT_SCANNED";
  configuredSourceCount: number | null;
  actionableSourceId: number | null;
  probe: ConnectorEvidenceView;
  production: ConnectorEvidenceView;
  primaryEvidence: string;
  repairability: keyof typeof REPAIRABILITY_PRESENTATION;
  reason: string;
  availableActions: { repairId: string; kind: "DIAGNOSTIC" | "REPAIR"; title: string; consequence: string }[];
}

interface ConnectorPayload {
  connectors: ConnectorRow[];
  totals: { connectors: number; scannable: number; configuredSources: number };
}

interface ActionOutcome {
  provider: string;
  repairId: string;
  kind: "DIAGNOSTIC" | "REPAIR";
  actionStatus: string;
  actionDetail: string;
  verificationStatus: string;
  verificationDetail: string;
  healthBefore: string;
  healthAfter: string;
}

const WINDOWS: WindowKey[] = ["24h", "7d", "30d"];

export function OperationsConsole({ candidateId }: { candidateId: number }) {
  const [window, setWindow] = useState<WindowKey>("24h");
  const [view, setView] = useState<AdminOperationsView | null>(null);
  const [catalog, setCatalog] = useState<RepairAction[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [connectors, setConnectors] = useState<ConnectorPayload | null>(null);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [connectorsLoading, setConnectorsLoading] = useState(false);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);

  const [pendingAction, setPendingAction] = useState<string | null>(null);
  /* Only ever the action performed in THIS interaction. Nothing persists a repair history, so the
   * console must not imply one exists — see the note above the results block below. */
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  /**
   * Fetching is separated from applying.
   *
   * The loader is pure — it returns what the server said and never touches state — so the effect
   * below can await it and apply the result afterwards. Calling a state-setting function straight
   * from an effect body triggers a cascading render, and this shape avoids that while still leaving
   * one loader that both the effect and the post-action refetch can share.
   */
  const fetchOverview = useCallback(async (): Promise<
    { ok: true; view: AdminOperationsView; catalog: RepairAction[] } | { ok: false; error: string }
  > => {
    try {
      const res = await fetch(adminApiUrl(`/api/admin/overview?window=${window}`, candidateId));
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Admin overview unavailable (${res.status})`);
      return { ok: true, view: body.operations as AdminOperationsView, catalog: (body.actionCatalog ?? []) as RepairAction[] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Admin overview could not be loaded." };
    }
  }, [candidateId, window]);

  const applyOverview = useCallback((result: Awaited<ReturnType<typeof fetchOverview>>) => {
    if (result.ok) {
      setLoadError(null);
      setView(result.view);
      setCatalog(result.catalog);
      return;
    }
    /* An unreachable API is not a healthy empty state. Nothing is rendered as green here. */
    setView(null);
    setLoadError(result.error);
  }, []);

  const loadOverview = useCallback(async () => {
    applyOverview(await fetchOverview());
  }, [applyOverview, fetchOverview]);

  useEffect(() => {
    let cancelled = false;
    void fetchOverview().then((result) => {
      if (!cancelled) applyOverview(result);
    });
    return () => {
      cancelled = true;
    };
  }, [applyOverview, fetchOverview]);

  /* One request for the whole provider table, and only once the section is opened. The overview
   * endpoint was built to avoid per-provider work; fetching a row at a time here would reintroduce
   * exactly that cost on the client. */
  const loadConnectors = useCallback(async () => {
    setConnectorsLoading(true);
    setConnectorsError(null);
    try {
      const res = await fetch(adminApiUrl("/api/admin/discovery-connectors", candidateId));
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Connector detail unavailable (${res.status})`);
      setConnectors(body as ConnectorPayload);
    } catch (err) {
      setConnectors(null);
      setConnectorsError(err instanceof Error ? err.message : "Connector detail could not be loaded.");
    } finally {
      setConnectorsLoading(false);
    }
  }, [candidateId]);

  const openConnectors = useCallback(() => {
    setConnectorsOpen((wasOpen) => {
      if (!wasOpen && connectors === null && !connectorsLoading) void loadConnectors();
      return !wasOpen;
    });
  }, [connectors, connectorsLoading, loadConnectors]);

  const runAction = useCallback(
    async (row: ConnectorRow, action: ConnectorRow["availableActions"][number]) => {
      if (pendingAction !== null || row.actionableSourceId === null) return;
      const key = `${row.provider}:${action.repairId}`;
      setPendingAction(key);
      setOutcome(null);
      try {
        const res = await fetch(adminApiUrl(`/api/admin/repairs/${action.repairId}`, candidateId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobSourceId: row.actionableSourceId }),
        });
        const body = await res.json();
        const result = body?.result;
        setOutcome({
          provider: row.provider,
          repairId: action.repairId,
          kind: action.kind,
          actionStatus: result?.actionStatus ?? "FAILED",
          actionDetail: result?.actionDetail ?? body?.error ?? "The action could not be completed.",
          verificationStatus: result?.verificationStatus ?? "NOT_ATTEMPTED",
          verificationDetail: result?.verificationDetail ?? "",
          healthBefore: result?.healthBefore ?? "NO_DATA",
          healthAfter: result?.healthAfter ?? "NO_DATA",
        });
      } catch {
        setOutcome({
          provider: row.provider,
          repairId: action.repairId,
          kind: action.kind,
          actionStatus: "FAILED",
          actionDetail: "The action could not be sent.",
          verificationStatus: "NOT_ATTEMPTED",
          verificationDetail: "",
          healthBefore: "NO_DATA",
          healthAfter: "NO_DATA",
        });
      } finally {
        setPendingAction(null);
        /* Re-observe from the server rather than trusting what the action said about itself. */
        await Promise.all([loadOverview(), loadConnectors()]);
      }
    },
    [candidateId, loadConnectors, loadOverview, pendingAction]
  );

  if (view === null && loadError === null) {
    return (
      <div className="ops-console" aria-busy="true">
        <p className="ops-loading" role="status">
          Loading operational evidence…
        </p>
      </div>
    );
  }

  if (loadError !== null) {
    return (
      <div className="ops-console">
        <div className="ops-panel ops-panel-critical" role="alert">
          <h2 className="ops-panel-title">Admin evidence unavailable</h2>
          <p className="ops-panel-body">{loadError}</p>
          <p className="ops-panel-body">
            No health can be shown while the operations API is unreachable. This is not the same as
            everything being healthy.
          </p>
          <button type="button" className="admin-button admin-button-primary" onClick={() => void loadOverview()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (view === null) return null;

  const attention = needsAttention(view.subsystems);
  const unobserved = awaitingEvidence(view.subsystems);
  const ordered = orderForDisplay(view.subsystems);

  return (
    <div className="ops-console">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">Admin</p>
          <h1 className="ops-title">Career-Ops Operations</h1>
          <p className="ops-subtitle">
            Every verdict below is the server&apos;s, with the evidence it was drawn from.
          </p>
        </div>
        <div className="ops-window" role="group" aria-label="Evidence window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className="ops-window-option"
              aria-pressed={window === w}
              onClick={() => setWindow(w)}
            >
              {w}
            </button>
          ))}
        </div>
      </header>

      {/* Counts exactly as the server reported them. No total, no score, no percentage. */}
      <section className="ops-summary" aria-label="Subsystem status counts">
        {(["healthy", "warning", "error", "disabled", "no_data"] as const).map((key) => {
          const status = key.toUpperCase() as keyof typeof HEALTH_PRESENTATION;
          const presentation = HEALTH_PRESENTATION[status];
          return (
            <div key={key} className={`ops-count ops-tone-${presentation.tone}`}>
              <span className="ops-count-value">{view.summary[key] ?? 0}</span>
              <span className="ops-count-label">
                <span aria-hidden="true">{presentation.symbol} </span>
                {presentation.label}
              </span>
            </div>
          );
        })}
      </section>

      <section className="ops-section" aria-labelledby="ops-attention-heading">
        <h2 id="ops-attention-heading" className="ops-section-title">
          Needs attention
        </h2>
        {attention.length === 0 ? (
          <p className="ops-quiet">
            No subsystem is reporting a warning or an error. Systems reporting no evidence are listed
            separately below.
          </p>
        ) : (
          <ul className="ops-attention-list">
            {attention.map((s) => (
              <li key={s.id}>
                <SubsystemCard subsystem={s} emphasis />
              </li>
            ))}
          </ul>
        )}
      </section>

      {unobserved.length > 0 && (
        <section className="ops-section" aria-labelledby="ops-unobserved-heading">
          <h2 id="ops-unobserved-heading" className="ops-section-title">
            Awaiting evidence
          </h2>
          <p className="ops-quiet">
            Nothing has been observed for these yet. That is not a failure and not a pass — it means
            no claim can be made either way.
          </p>
          <ul className="ops-attention-list">
            {unobserved.map((s) => (
              <li key={s.id}>
                <SubsystemCard subsystem={s} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="ops-section" aria-labelledby="ops-grid-heading">
        <h2 id="ops-grid-heading" className="ops-section-title">
          System health
        </h2>
        <div className="ops-grid">
          {ordered.map((s) => (
            <SubsystemCard key={s.id} subsystem={s} />
          ))}
        </div>
      </section>

      <section className="ops-section" aria-labelledby="ops-discovery-heading">
        <h2 id="ops-discovery-heading" className="ops-section-title">
          Job discovery connectors
        </h2>
        <p className="ops-quiet">
          {view.discovery.connectors} platform{view.discovery.connectors === 1 ? "" : "s"} have a
          fetch connector; {view.discovery.scannable} are selected by the scanner.{" "}
          {view.discovery.configuredSources} source
          {view.discovery.configuredSources === 1 ? " is" : "s are"} registered. Fetching jobs from a
          platform is a different capability from applying to it.
        </p>

        <button
          type="button"
          className="admin-button ops-disclosure"
          onClick={openConnectors}
          aria-expanded={connectorsOpen}
          aria-controls="ops-connector-detail"
        >
          {connectorsOpen ? "Hide provider detail" : "Show provider detail"}
        </button>

        <div id="ops-connector-detail" hidden={!connectorsOpen}>
          {connectorsLoading && (
            <p className="ops-loading" role="status">
              Loading provider evidence…
            </p>
          )}
          {connectorsError !== null && (
            <p className="ops-panel ops-panel-critical" role="alert">
              {connectorsError}
            </p>
          )}
          {connectors !== null && (
            <ul className="ops-provider-list">
              {connectors.connectors.map((row) => (
                <li key={row.provider}>
                  <ProviderRow
                    row={row}
                    pendingKey={pendingAction}
                    outcome={outcome?.provider === row.provider ? outcome : null}
                    onRun={runAction}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="ops-section" aria-labelledby="ops-apply-heading">
        <h2 id="ops-apply-heading" className="ops-section-title">
          Application automation
        </h2>
        <p className="ops-quiet">{view.applicationAutomation.note}</p>
        <ul className="ops-adapter-list">
          {view.applicationAutomation.adapters.map((adapter) => {
            const presentation = HEALTH_PRESENTATION[adapter.health];
            return (
              <li key={adapter.provider} className="ops-adapter">
                <span className="ops-adapter-name">{adapter.provider}</span>
                <span className="ops-adapter-capability">Runtime adapter present</span>
                <span className={`ops-badge ops-tone-${presentation.tone}`}>
                  <span aria-hidden="true">{presentation.symbol} </span>
                  {presentation.label}
                </span>
                <span className="ops-adapter-detail">{adapter.summary}</span>
              </li>
            );
          })}
        </ul>
        <p className="ops-quiet">
          {view.applicationAutomation.discoveryOnlyPlatforms} further platform
          {view.applicationAutomation.discoveryOnlyPlatforms === 1 ? "" : "s"} can have jobs fetched
          but have no application adapter. That is a capability boundary, not a fault.
        </p>
      </section>

      {catalog.length > 0 && (
        <section className="ops-section" aria-labelledby="ops-actions-heading">
          <h2 id="ops-actions-heading" className="ops-section-title">
            Available operator actions
          </h2>
          <ul className="ops-catalog">
            {catalog.map((action) => (
              <li key={action.id} className="ops-catalog-item">
                <span className="ops-kind">{ACTION_KIND_PRESENTATION[action.kind].label}</span>
                <span className="ops-catalog-title">{action.title}</span>
                <span className="ops-catalog-detail">{action.description}</span>
                <span className="ops-catalog-hint">{ACTION_KIND_PRESENTATION[action.kind].hint}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav className="ops-section ops-links" aria-label="Operational sub-consoles">
        <h2 className="ops-section-title">Detailed consoles</h2>
        <Link href="/admin/operations" className="admin-card">
          Operations
        </Link>
        <Link href="/admin/scanner" className="admin-card">
          Scanner
        </Link>
        <Link href="/admin/writer" className="admin-card">
          Resume Writer
        </Link>
        <Link href="/admin/applications" className="admin-card">
          Applications
        </Link>
        <Link href="/admin/activity" className="admin-card">
          Activity
        </Link>
      </nav>
    </div>
  );
}

/**
 * One subsystem, collapsed to a verdict and expandable to the evidence behind it.
 *
 * The expanded half exists so a verdict is never something an operator has to take on faith. It
 * shows what the server observed, not a restatement of the conclusion in stronger words.
 */
function SubsystemCard({ subsystem, emphasis = false }: { subsystem: AdminSubsystem; emphasis?: boolean }) {
  const presentation = HEALTH_PRESENTATION[subsystem.status];
  const repair = REPAIRABILITY_PRESENTATION[subsystem.repairability];
  const freshness = formatFreshness(subsystem.observedAt, subsystem.stale);

  return (
    <article className={`ops-card ops-tone-${presentation.tone}${emphasis ? " ops-card-emphasis" : ""}`}>
      <header className="ops-card-head">
        <h3 className="ops-card-title">{subsystem.label}</h3>
        <span className={`ops-badge ops-tone-${presentation.tone}`}>
          <span aria-hidden="true">{presentation.symbol} </span>
          {presentation.label}
        </span>
      </header>
      <p className="ops-card-summary">{subsystem.summary}</p>
      <p className="ops-freshness">
        {freshness.text}
        {freshness.stale && <span className="ops-stale"> · Stale</span>}
      </p>

      <details className="ops-details">
        <summary>Evidence and repairability</summary>
        <dl className="ops-evidence">
          <dt>What this status means</dt>
          <dd>{presentation.meaning}</dd>
          <dt>Reason code</dt>
          <dd>
            <code>{subsystem.reasonCode}</code>
          </dd>
          <dt>Repairability</dt>
          <dd>
            <strong>{repair.label}.</strong> {repair.detail}
          </dd>
          <dt>Observed</dt>
          <dd>{subsystem.observedAt ?? "Never"}</dd>
          <dt>Evidence</dt>
          <dd>
            {subsystem.evidence.length === 0 ? (
              <span className="ops-quiet">
                None recorded. A verdict other than “No data” always cites evidence; this one does
                not claim to know.
              </span>
            ) : (
              <ul className="ops-evidence-list">
                {subsystem.evidence.map((item) => (
                  <li key={`${item.label}-${item.value}`}>
                    <span className="ops-evidence-label">{item.label}</span>
                    <span className="ops-evidence-value">{item.value}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
        {subsystem.availableActions.length === 0 && (
          <p className="ops-quiet">No action is offered here.</p>
        )}
      </details>
    </article>
  );
}

/** One provider, with its two independent readings kept apart. */
function ProviderRow({
  row,
  pendingKey,
  outcome,
  onRun,
}: {
  row: ConnectorRow;
  pendingKey: string | null;
  outcome: ActionOutcome | null;
  onRun: (row: ConnectorRow, action: ConnectorRow["availableActions"][number]) => void;
}) {
  const capability = CAPABILITY_PRESENTATION[row.capability] ?? CAPABILITY_PRESENTATION.NONE;
  const repair = REPAIRABILITY_PRESENTATION[row.repairability];

  return (
    <article className="ops-provider">
      <header className="ops-provider-head">
        <h3 className="ops-provider-name">{row.provider}</h3>
        <span className="ops-capability">{capability.label}</span>
        <span className="ops-provider-sources">
          {row.configuredSourceCount ?? "—"} source{row.configuredSourceCount === 1 ? "" : "s"}
        </span>
        <span className="ops-provider-primary">{primaryEvidenceLabel(row.primaryEvidence)}</span>
      </header>

      {/* Both readings, always. The backend preserves disagreement deliberately; collapsing the two
          here would discard the very thing that makes a contradiction informative. */}
      <div className="ops-evidence-pair">
        <EvidenceBlock title="Production scans" caption="Real scheduled scans across configured sources." evidence={row.production} />
        <EvidenceBlock title="Connector probe" caption="A read-only check of one source." evidence={row.probe} />
      </div>

      <p className="ops-provider-reason">
        <strong>{repair.label}.</strong> {row.reason}
      </p>
      <p className="ops-quiet">{capability.detail}</p>

      {row.availableActions.map((action) => {
        const key = `${row.provider}:${action.repairId}`;
        const pending = pendingKey === key;
        const disabled = pendingKey !== null || row.actionableSourceId === null;
        return (
          <div key={action.repairId} className="ops-action">
            <span className="ops-kind">{ACTION_KIND_PRESENTATION[action.kind].label}</span>
            <button
              type="button"
              className="admin-button admin-button-primary"
              disabled={disabled}
              aria-disabled={disabled}
              onClick={() => onRun(row, action)}
            >
              {pending ? "Checking…" : action.title}
            </button>
            <span className="ops-action-hint">{ACTION_KIND_PRESENTATION[action.kind].hint}</span>
            {row.actionableSourceId === null && (
              <span className="ops-quiet">
                No approved, verified source is available for this provider, so there is nothing to
                check.
              </span>
            )}
          </div>
        );
      })}

      {outcome !== null && <ActionResult outcome={outcome} />}
    </article>
  );
}

function EvidenceBlock({
  title,
  caption,
  evidence,
}: {
  title: string;
  caption: string;
  evidence: ConnectorEvidenceView;
}) {
  const presentation = HEALTH_PRESENTATION[evidence.status];
  return (
    <div className={`ops-evidence-block ops-tone-${presentation.tone}`}>
      <h4 className="ops-evidence-title">{title}</h4>
      <span className={`ops-badge ops-tone-${presentation.tone}`}>
        <span aria-hidden="true">{presentation.symbol} </span>
        {presentation.label}
      </span>
      <p className="ops-quiet">{caption}</p>
      <dl className="ops-evidence">
        <dt>Last succeeded</dt>
        <dd>{evidence.lastSucceededAt ?? "Never observed"}</dd>
        <dt>Last failed</dt>
        <dd>{evidence.lastFailedAt ?? "Never observed"}</dd>
        <dt>Failures in window</dt>
        <dd>{evidence.failureCount}</dd>
        {evidence.lastFailureCategory !== null && (
          <>
            <dt>Failure kind</dt>
            <dd>
              <code>{evidence.lastFailureCategory}</code>
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

/**
 * The outcome of the action just performed, in this interaction only.
 *
 * Two things are kept apart on purpose. `actionStatus` says whether the action ran;
 * `verificationStatus` says what the evidence it produced showed. A successful diagnostic against a
 * still-broken connector is EXECUTED and VERIFIED_STILL_FAILING at the same time, and the wording
 * below has to be able to say that. "Fixed" appears nowhere.
 *
 * Nothing here is persisted, so this disappears on reload — which is correct: no repair history
 * exists, and a console that showed one after a refresh would be inventing it.
 */
function ActionResult({ outcome }: { outcome: ActionOutcome }) {
  const executed = outcome.actionStatus === "EXECUTED";
  const before = HEALTH_PRESENTATION[outcome.healthBefore as keyof typeof HEALTH_PRESENTATION];
  const after = HEALTH_PRESENTATION[outcome.healthAfter as keyof typeof HEALTH_PRESENTATION];

  const headline = !executed
    ? outcome.actionStatus === "REJECTED_INELIGIBLE"
      ? "Action refused"
      : "Action did not complete"
    : outcome.kind === "DIAGNOSTIC"
      ? "Diagnostic completed"
      : "Action completed";

  return (
    <div className="ops-result" role="status" aria-live="polite">
      <h4 className="ops-result-title">{headline}</h4>
      <p className="ops-result-line">{outcome.actionDetail}</p>
      <dl className="ops-evidence">
        <dt>What the fresh evidence showed</dt>
        <dd>{outcome.verificationDetail || "No new evidence was produced."}</dd>
        <dt>Health before</dt>
        <dd>{before?.label ?? outcome.healthBefore}</dd>
        <dt>Health after</dt>
        <dd>{after?.label ?? outcome.healthAfter}</dd>
      </dl>
      <p className="ops-quiet">
        Running an action never changes health by itself. The status above was re-read from stored
        evidence after the action ran.
      </p>
    </div>
  );
}
