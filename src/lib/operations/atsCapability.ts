import { automatedSourceTypes } from "@/lib/apply/agent/selectAdapter";
import { DISCOVERY_CONNECTOR_PROVIDERS, SCANNABLE_PROVIDERS } from "@/lib/ats/scannableProviders";
import type { SourceType } from "@/types";

/**
 * ADMIN-OPS-1 — the one place that says what Career-Ops can actually DO with an ATS, per axis.
 *
 * WHY THIS EXISTS. "Supported" is the most dangerous word available to an Admin console, because it
 * has four unrelated meanings here and collapsing any two of them produces a confident falsehood:
 *
 *   1. RECOGNITION — a URL can be identified as belonging to this platform.
 *   2. AUTOMATION  — a runtime adapter exists that can attempt to fill this platform's form.
 *   3. VALIDATION  — that adapter has been checked against captured markup.
 *   4. HEALTH      — it is working right now.
 *
 * Recognition is cheap and broad; automation is expensive and narrow. On this branch that gap is
 * enormous — every entry in `SourceType` can be catalogued, while `selectAdapter`'s ADAPTERS array
 * holds three. A run against anything outside those three does not degrade or fall back: it is
 * refused outright before a browser opens (see the start route's `unsupported_ats` response). So
 * "Career-Ops knows this ATS" and "Career-Ops can apply here" are not two ends of a spectrum, they
 * are different facts, and only one of them may ever be drawn as a capability an operator can rely on.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO, AND WHY.
 *
 * It does not assert recognition coverage — and the reason is stronger than "a registry from another
 * branch is missing". `src/lib/ats/detect.ts` exports exactly two things: the `AtsDetection` type and
 * `detectAtsFromUrlString(url)`. Its ~34 per-platform detectors are module-private and hand-chained
 * inside that one function; there is no exported list, no map, and no way to enumerate them. So the
 * only ways to answer "is this platform detectable" from out here are to hardcode the platform list,
 * or to hardcode a probe URL per platform — both of which are the same mistake, a second copy of
 * detector knowledge that can silently drift from the detector itself and would then report coverage
 * the engine does not actually have. This module refuses the question and reports UNKNOWN.
 *
 * That verdict is about the AUTHORITY, not the branch. If the capability registry from
 * apply/ats-adapters-35plus is later merged it will supply a `detection` field per platform, but it
 * is a hand-maintained mirror of detect.ts, not derived from it — so merging it does not by itself
 * make recognition observable. It makes it ASSERTED. Whichever way that is resolved (deriving from a
 * detector registry detect.ts would need to export, or treating the registry as authoritative and
 * testing it against detect.ts) is an ADMIN-OPS-3 decision; until then UNKNOWN is the honest answer.
 *
 * It also never derives validation evidence: fixtures live in test fixtures, and reading a green test
 * run as a live-site guarantee is exactly the inference that must not be made.
 *
 * AUTOMATION IS READ FROM THE RUNTIME REGISTRY ITSELF, never from a parallel list. `selectAdapter`
 * is the function the engine actually calls, so `automatedSourceTypes()` cannot drift from what the
 * engine will really do — a second hand-maintained list could, and the disagreement would surface as
 * a promise the product does not keep.
 */

/** Platforms that are catalogued as real ATS vendors, as opposed to Career-Ops' own meta sources. */
const META_SOURCE_TYPES: ReadonlySet<string> = new Set(["career_link", "google_jobs", "indeed", "built_in"]);

export type RecognitionSupport = "UNKNOWN";
export type AutomationSupport = "RUNTIME_ADAPTER" | "NONE";
export type ValidationEvidence = "UNKNOWN";

/**
 * ADMIN-OPS-3 — whether Career-Ops can FETCH jobs from a platform. Entirely independent of whether
 * it can APPLY to one.
 */
export type DiscoverySupport =
  /** A connector exists AND the scanner is willing to select this provider's sources. */
  | "SCANNABLE"
  /** A fetch connector exists, but the scanner's provider allowlist excludes it, so no source of
   *  this provider is ever selected for scanning. Real today for `phenom`. */
  | "CONNECTOR_NOT_SCANNED"
  /** No discovery connector. */
  | "NONE";

export interface AtsCapability {
  sourceType: SourceType;
  /**
   * ADMIN-OPS-3 — the DISCOVERY axis, added because its absence made this model actively misleading.
   *
   * Without it every platform outside the three apply adapters reported `automation: NONE` and
   * `recognition: UNKNOWN` — which reads as "Career-Ops can do nothing here". That is false for 36
   * platforms: Ashby, iCIMS, Taleo and the rest all have real, individually-tested job-fetch
   * connectors dispatched by fetchJobsForCompany. The product can find their jobs perfectly well; it
   * just cannot auto-apply to them. Reporting only the apply axis understated real capability as
   * badly as claiming apply support would have overstated it.
   */
  discovery: DiscoverySupport;
  /**
   * Whether a URL for this platform can be identified. NOT observable in this worktree — the
   * capability registry that would answer it is not on this branch. Reported honestly as UNKNOWN
   * rather than inferred from the presence of a runtime adapter, which would be circular.
   */
  recognition: RecognitionSupport;
  /** Whether the apply engine has a real adapter for it. This IS observable and authoritative. */
  automation: AutomationSupport;
  /** What proof exists that the adapter matches real markup. Not derivable here — see header. */
  validation: ValidationEvidence;
  /**
   * The only claim Admin may make about auto-apply readiness. True ONLY when a runtime adapter
   * exists; recognition never contributes, because recognising a site does not mean anything can be
   * filled in on it.
   */
  canAttemptApplication: boolean;
}

/** Whether this source type is a real external ATS rather than one of Career-Ops' own meta sources. */
export function isRealAtsPlatform(sourceType: string): boolean {
  return !META_SOURCE_TYPES.has(sourceType);
}

/** Providers the scanner will select sources for — derived from the one authority, never restated. */
const SCANNABLE = new Set<string>(SCANNABLE_PROVIDERS);

/**
 * Platforms with a job-fetch connector. Read from the single authority rather than restating the
 * "+ phenom" delta a third time — see DISCOVERY_CONNECTOR_PROVIDERS.
 */
const DISCOVERY_CONNECTORS = new Set<string>(DISCOVERY_CONNECTOR_PROVIDERS);

export function getAtsCapability(sourceType: SourceType): AtsCapability {
  const automated = automatedSourceTypes().includes(sourceType);
  const discovery: DiscoverySupport = !DISCOVERY_CONNECTORS.has(sourceType)
    ? "NONE"
    : SCANNABLE.has(sourceType)
    ? "SCANNABLE"
    : "CONNECTOR_NOT_SCANNED";
  return {
    sourceType,
    discovery,
    recognition: "UNKNOWN",
    automation: automated ? "RUNTIME_ADAPTER" : "NONE",
    validation: "UNKNOWN",
    /* Deliberately identical to `automated` and deliberately not a broader expression: this is the
     * single field an Admin card would bind to, and it must not be reachable from any input other
     * than the runtime registry. */
    canAttemptApplication: automated,
  };
}

export interface AtsCapabilityCounts {
  /** Platforms whose sources the scanner will fetch. Never conflate with runtimeAdapters. */
  scannableDiscovery: number;
  /** Platforms with a fetch connector the scanner's allowlist excludes. */
  connectorNotScanned: number;
  /** Platforms with a real runtime adapter — the only number that means "can attempt to apply". */
  runtimeAdapters: number;
  /** Platforms whose recognition support this worktree cannot observe. */
  recognitionUnknown: number;
  /** Platforms with validation evidence this worktree can prove. Structurally zero here. */
  validated: number;
}

/**
 * Counts, for an Admin summary line. `recognitionUnknown` is reported rather than suppressed
 * precisely so the gap stays visible — a console that silently omitted it would imply the registry
 * had been consulted and found nothing, which is not what happened.
 */
export function summarizeAtsCapabilities(sourceTypes: readonly SourceType[]): AtsCapabilityCounts {
  const real = sourceTypes.filter((s) => isRealAtsPlatform(s));
  const capabilities = real.map(getAtsCapability);
  return {
    scannableDiscovery: capabilities.filter((c) => c.discovery === "SCANNABLE").length,
    connectorNotScanned: capabilities.filter((c) => c.discovery === "CONNECTOR_NOT_SCANNED").length,
    runtimeAdapters: capabilities.filter((c) => c.automation === "RUNTIME_ADAPTER").length,
    recognitionUnknown: capabilities.filter((c) => c.recognition === "UNKNOWN").length,
    validated: capabilities.filter((c) => c.validation !== "UNKNOWN").length,
  };
}
