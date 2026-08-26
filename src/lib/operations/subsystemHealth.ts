import type { HealthStatus } from "./healthRules";

/**
 * ADMIN-OPS-1 — the evidence-bearing shape a health verdict must carry.
 *
 * WHY THIS EXISTS. `healthRules.ts` already returns the right *labels* — and it already refuses to
 * compute a composite score, which is the hard part. What it cannot do is explain itself: a caller
 * receives `"WARNING"` and has no way to say what was observed, when, or whether that observation is
 * still worth trusting. Admin then has two bad options — print the bare label, or invent a sentence
 * to go with it. This type removes that choice by making the evidence part of the verdict.
 *
 * THE RULE THIS ENCODES. A status is a CONCLUSION drawn from evidence, never an assumption made in
 * its absence. `NO_DATA` is therefore a first-class, non-alarming outcome: "nothing has been
 * observed" is a truthful thing to say and must never be dressed up as `HEALTHY`, nor escalated to
 * `ERROR`. Anything that cannot cite evidence for a positive verdict must not return one.
 *
 * STALENESS IS PART OF THE VERDICT, NOT A UI CONCERN. `observedAt` records when the underlying fact
 * was true; `staleAfterMs` records how long that fact stays meaningful. A consumer that renders a
 * green state without consulting both is showing yesterday's weather. `staleAfterMs` is null only
 * when a fact does not decay (a configuration flag is true until changed), never as a shrug — if a
 * signal decays and no justified threshold exists, that gap is documented rather than papered over
 * with an invented SLA.
 *
 * NO SCORES, NO PERCENTAGES, NO UPTIME. Deliberately absent, and deliberately not addable here:
 * Career-Ops persists no historical health series to compute them from, so any such number would be
 * fabricated. See `healthRules.ts`'s own header for the same refusal.
 */

/** One observed fact behind a verdict. Values are already-safe display strings — never a secret,
 *  a credential, a raw query parameter, or candidate-derived content. */
export interface HealthEvidence {
  label: string;
  value: string;
}

/**
 * How a problem could be addressed, if at all. ADMIN-OPS-1 only CLASSIFIES; it deliberately ships no
 * repair actions (those are ADMIN-OPS-4). A classification here is a claim about reality and must
 * never assert a repair path that does not already exist in code.
 */
export type RepairabilityClass =
  /** A bounded, deterministic recovery already runs on its own — nothing for an operator to do. */
  | "AUTO_RECOVERABLE"
  /** A real, existing endpoint or command performs a deterministic repair. */
  | "MANUAL_REPAIR_AVAILABLE"
  /** Nothing is broken; a configuration choice is producing this state. */
  | "CONFIGURATION_REQUIRED"
  /** The cause is outside this machine — a third-party site, provider, or network. */
  | "EXTERNAL_FAILURE"
  /** Understood, but no repair path exists that Admin could safely expose. */
  | "NOT_REPAIRABLE_FROM_ADMIN"
  /** Root cause not established. The honest default — never a fallback for "probably fine". */
  | "UNKNOWN";

export interface SubsystemHealth {
  status: HealthStatus;
  /** One plain sentence an operator can act on. Never a raw error string, never a stack trace. */
  summary: string;
  /** The observations the status was derived from. May be empty ONLY when status is NO_DATA. */
  evidence: HealthEvidence[];
  /** When the underlying fact was true. Null means nothing has been observed at all. */
  observedAt: string | null;
  /** How long `observedAt` stays meaningful. Null means the fact does not decay. */
  staleAfterMs: number | null;
  /** Stable machine-readable discriminator, so a consumer never string-matches `summary`. */
  reasonCode: string;
  repairability: RepairabilityClass;
}

/**
 * Builds a verdict, enforcing the one invariant that makes this type worth having: a positive
 * verdict must cite evidence.
 *
 * Throwing here is deliberate. This is a programming error, not a runtime condition — a caller that
 * concluded HEALTHY without an observation has a bug in its rule, and failing loudly in tests is
 * exactly how that gets caught before it reaches an operator as a green card.
 */
export function buildHealth(input: SubsystemHealth): SubsystemHealth {
  if (input.status !== "NO_DATA" && input.evidence.length === 0) {
    throw new Error(
      `Health verdict "${input.status}" (${input.reasonCode}) cites no evidence. Only NO_DATA may be evidence-free.`
    );
  }
  return input;
}

/**
 * Whether an observation has outlived its meaning.
 *
 * Never-observed is NOT stale — it is `NO_DATA`, a different and less alarming thing, and conflating
 * them is how "we have never checked" turns into "it has been broken for a long time". A fact with
 * no decay window (`staleAfterMs === null`) is never stale.
 */
export function isStale(health: Pick<SubsystemHealth, "observedAt" | "staleAfterMs">, now: Date = new Date()): boolean {
  if (health.observedAt === null || health.staleAfterMs === null) return false;
  const observed = new Date(health.observedAt).getTime();
  if (!Number.isFinite(observed)) return false;
  return now.getTime() - observed > health.staleAfterMs;
}
