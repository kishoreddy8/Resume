import type { HealthStatus } from "@/lib/operations/healthRules";
import type { RepairabilityClass } from "@/lib/operations/subsystemHealth";
import type { ActionKind } from "@/lib/operations/repairRegistry";

/**
 * UI-ADMIN-1 — how the frozen operational contract is PRESENTED. Nothing here decides anything.
 *
 * The backend already settled every operational question: what the status is, whether the evidence
 * is stale, who can act, and whether an action repairs or merely re-observes. This module turns
 * those verdicts into words and tones. It is deliberately a separate file from the components that
 * use it, for two reasons: the console's JSX stays thin enough to read, and the rules that actually
 * matter — a failure never rendering as positive, a diagnostic never being labelled a fix — can be
 * tested by calling functions rather than by grepping a component.
 *
 * The one rule that governs the whole file: no function here may take an input the server did not
 * already decide, and none may produce a verdict the server did not already make. If a value has to
 * be computed from `Date.now()` or from counting evidence rows, it belongs on the server.
 */

export type Tone = "positive" | "warning" | "critical" | "neutral";

export interface StatusPresentation {
  /** Operator-facing word for the status. Always rendered as text, never colour alone. */
  label: string;
  tone: Tone;
  /** Redundant non-colour channel, so the status survives greyscale and colour-blindness. */
  symbol: string;
  /** What this status actually claims, for the expanded view and for screen readers. */
  meaning: string;
}

/**
 * The five statuses, and only the five.
 *
 * DISABLED and NO_DATA share a neutral tone because neither is a fault — but they are never
 * interchangeable, and the label, symbol and meaning all differ: one says a person switched
 * something off, the other says nothing has been observed. Conflating them is how a product ends up
 * reporting silence as consent.
 */
export const HEALTH_PRESENTATION: Record<HealthStatus, StatusPresentation> = {
  HEALTHY: {
    label: "Healthy",
    tone: "positive",
    symbol: "●",
    meaning: "Recent evidence shows this working.",
  },
  WARNING: {
    label: "Warning",
    tone: "warning",
    symbol: "▲",
    meaning: "Working, but something needs attention.",
  },
  ERROR: {
    label: "Error",
    tone: "critical",
    symbol: "✕",
    meaning: "Evidence shows this is failing.",
  },
  DISABLED: {
    label: "Disabled",
    tone: "neutral",
    symbol: "◌",
    /* UI-ADMIN-1.1 — was "Nothing is broken", which claimed more than DISABLED evidences. The status
     * says one subsystem is switched off; it says nothing about anything else, and a blanket
     * all-clear is exactly the kind of reassurance this product refuses to invent. */
    meaning: "Switched off by configuration, so it is not running. This is a choice, not a failure.",
  },
  NO_DATA: {
    label: "No data",
    tone: "neutral",
    symbol: "—",
    meaning: "Nothing has been observed, so no claim can be made either way.",
  },
};

export interface RepairabilityPresentation {
  label: string;
  /** One sentence an operator can act on — or that tells them there is nothing to act on. */
  detail: string;
}

/**
 * The repairability vocabulary, translated but not reinterpreted.
 *
 * Each entry says who can do something, which is the question this axis answers. None of them
 * promises that an action exists: whether a button appears is decided by availableActions, not by
 * the class. "Unhealthy therefore there must be a button" is precisely the inference this separation
 * exists to prevent.
 */
export const REPAIRABILITY_PRESENTATION: Record<RepairabilityClass, RepairabilityPresentation> = {
  AUTO_RECOVERABLE: {
    label: "Recovers on its own",
    detail: "Expected to recover automatically as normal work succeeds. No operator action needed.",
  },
  MANUAL_REPAIR_AVAILABLE: {
    label: "Operator action available",
    detail: "A deterministic action exists for this condition.",
  },
  CONFIGURATION_REQUIRED: {
    label: "Configuration required",
    detail: "A setting or credential must be provided outside the app. No in-app action can supply it.",
  },
  EXTERNAL_FAILURE: {
    label: "External provider issue",
    detail: "The cause is outside this machine. Admin can re-observe, but cannot repair the provider.",
  },
  NOT_REPAIRABLE_FROM_ADMIN: {
    label: "Not repairable from Admin",
    detail: "Understood, but there is no action Admin can safely take.",
  },
  UNKNOWN: {
    label: "Cause not established",
    detail: "Not enough evidence to say what would fix this.",
  },
};

/**
 * How an action is described to an operator.
 *
 * DIAGNOSTIC must never read as a cure. The registered connector recheck re-observes: if the
 * connector is broken it records another failure, and a button saying "Fix" would promise something
 * the product cannot do. The kind comes from the server and is never inferred here.
 */
export const ACTION_KIND_PRESENTATION: Record<ActionKind, { label: string; hint: string }> = {
  DIAGNOSTIC: {
    label: "Diagnostic",
    hint: "Re-observes current state and records fresh evidence. Changes nothing.",
  },
  REPAIR: {
    label: "Repair",
    hint: "Acts on state Career-Ops controls, with the intent of restoring service.",
  },
};

/**
 * Verbs a DIAGNOSTIC action may never be dressed in.
 *
 * UI-ADMIN-1.1 widened this after probing the guard rather than trusting it: the original list of
 * five, matched with a trailing word boundary, let "Fixup connector" through, and had no answer at
 * all for the ordinary synonyms an author would reach for next.
 */
export const FORBIDDEN_DIAGNOSTIC_VERBS = [
  "fix",
  "repair",
  "resolve",
  "recover",
  "restore",
  "remediate",
  "heal",
  "mend",
  "unblock",
  "cure",
] as const;

/**
 * Whether a label would overclaim for the given kind.
 *
 * Exported so the rule is testable directly rather than asserted against rendered markup, and so a
 * future action added to the registry cannot quietly arrive with a label that promises a cure.
 */
export function labelOverclaims(kind: ActionKind, label: string): boolean {
  if (kind !== "DIAGNOSTIC") return false;
  const lowered = label.toLowerCase();
  /* Stem match: a boundary is required BEFORE the verb but not after, so "fixup", "fixes" and
   * "repairing" are all caught while "amend", "secure" and "prefix" — which merely contain a verb
   * mid-word — are not. */
  return FORBIDDEN_DIAGNOSTIC_VERBS.some((verb) => new RegExp(`\\b${verb}`).test(lowered));
}

/* ================================================================================================
 * Ordering and selection. Both operate purely on server-supplied status values.
 * ============================================================================================== */

/** Attention order. DISABLED is absent on purpose: a thing an operator switched off is not news. */
const ATTENTION_RANK: Record<HealthStatus, number> = {
  ERROR: 0,
  WARNING: 1,
  NO_DATA: 2,
  HEALTHY: 3,
  DISABLED: 4,
};

export interface SubsystemLike {
  id: string;
  status: HealthStatus;
  repairability: RepairabilityClass;
}

/**
 * The subsystems that genuinely need a person, most severe first.
 *
 * Only ERROR and WARNING qualify. NO_DATA is deliberately excluded and surfaced separately: an
 * absence of evidence is worth knowing about, but presenting it beside real failures would train an
 * operator to read "we have not looked" as "it is broken" — and eventually to ignore both.
 */
export function needsAttention<T extends SubsystemLike>(subsystems: readonly T[]): T[] {
  return subsystems
    .filter((s) => s.status === "ERROR" || s.status === "WARNING")
    .sort((a, b) => ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status]);
}

/**
 * Subsystems reporting no evidence, excluding those that are simply switched off.
 *
 * Kept apart from needsAttention for the reason above, and worth showing because "nothing has ever
 * reported" is itself an operational fact — it is how a scheduler that never started looks.
 */
export function awaitingEvidence<T extends SubsystemLike>(subsystems: readonly T[]): T[] {
  return subsystems.filter((s) => s.status === "NO_DATA");
}

/** Stable display order for the full grid: worst first, then alphabetical for a calm layout. */
export function orderForDisplay<T extends SubsystemLike & { label?: string }>(subsystems: readonly T[]): T[] {
  return [...subsystems].sort((a, b) => {
    const rank = ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status];
    return rank !== 0 ? rank : (a.label ?? a.id).localeCompare(b.label ?? b.id);
  });
}

/* ================================================================================================
 * Freshness. Formatting only — the verdict is the server's.
 * ============================================================================================== */

export interface FreshnessLine {
  /** "Observed 4 min ago", or a plain statement when nothing has been observed. */
  text: string;
  /** Straight from the server's `stale` field. Never computed here. */
  stale: boolean;
  /** Machine-readable for tests and styling, so nothing has to parse `text`. */
  kind: "OBSERVED" | "NEVER_OBSERVED";
}

/**
 * Turns an observation timestamp into a sentence, WITHOUT deciding whether it is stale.
 *
 * The distinction matters more than it looks. Formatting "4 minutes ago" needs the current time;
 * deciding that four minutes is too old needs a policy, and that policy lives in the health rules
 * with the threshold it was derived from. A component that compared `Date.now()` against
 * `staleAfterMs` would be a second, quietly diverging staleness authority — so `stale` is passed
 * through untouched and `now` is only ever used for wording.
 */
export function formatFreshness(
  observedAt: string | null,
  stale: boolean,
  now: Date = new Date()
): FreshnessLine {
  if (observedAt === null) {
    return { text: "No observation recorded", stale, kind: "NEVER_OBSERVED" };
  }
  const observed = new Date(observedAt).getTime();
  if (!Number.isFinite(observed)) {
    return { text: "Observation time unreadable", stale, kind: "NEVER_OBSERVED" };
  }
  const seconds = Math.max(0, Math.round((now.getTime() - observed) / 1000));
  return { text: `Observed ${humanizeAgo(seconds)}`, stale, kind: "OBSERVED" };
}

function humanizeAgo(seconds: number): string {
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/* ================================================================================================
 * Discovery connector presentation.
 * ============================================================================================== */

export const CAPABILITY_PRESENTATION: Record<string, { label: string; detail: string }> = {
  SCANNABLE: {
    label: "Scanned",
    detail: "The scheduled scanner will fetch this provider's approved sources.",
  },
  CONNECTOR_NOT_SCANNED: {
    label: "Connector only",
    detail:
      "A working fetch connector exists, but the scanner does not select this provider — so no source of it is scanned. A coverage boundary, not a fault.",
  },
  NONE: {
    label: "No connector",
    detail: "No fetch implementation exists for this platform.",
  },
};

/**
 * Which of a provider's two independent readings the server says to lead with.
 *
 * "Lead with" is all this decides. Both readings are always rendered: the backend deliberately
 * preserves contradictory evidence — a production scan succeeding while the probe fails is a real
 * and useful state — and hiding the quieter half would throw away the disagreement that makes it
 * informative.
 */
export function primaryEvidenceLabel(primary: string): string {
  if (primary === "PRODUCTION_SCAN") return "Leading: real scans";
  if (primary === "PROBE") return "Leading: connector probe";
  return "No evidence yet";
}
