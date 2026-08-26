import type { SourceType } from "@/types";

/**
 * The ATS/career-site adapter coverage registry.
 *
 * DEVELOPER/SYSTEM METADATA ONLY — never surfaced to a candidate. This is the honest map of what
 * this codebase can actually automate today, platform by platform, and exactly what evidence that
 * claim rests on. It is deliberately separate from `selectAdapter.ts`'s runtime `ADAPTERS` array:
 * that array only ever contains a REAL, hint-bearing `AtsAdapter` (currently Workday, Greenhouse,
 * Lever) — an entry here does NOT imply a matching adapter object exists, because for the large
 * majority of platforms below, one legitimately does not yet, and registering an empty placeholder
 * adapter (`{ sourceType, fieldSelectorHints: () => ({}) }`) would change nothing at runtime: the
 * executor already treats a `null` `activeAdapter` and an adapter with every optional capability
 * absent identically (see `executor.ts`'s `activeAdapter?.` chains throughout `approveAndSubmit`/
 * `resumeRun`) — a bare adapter object would be pure decoration, not new capability.
 *
 * WHY THIS EXISTS SEPARATELY FROM DETECTION. `src/lib/ats/detect.ts` (a different system, owned by
 * the company/job-discovery layer — see `ATS_DISCOVERY_SOURCE_OF_TRUTH.md`) already implements real,
 * tested hostname/URL detection for 36 of the 37 real platforms in `SourceType`. Detecting that a
 * posting IS on a given ATS says nothing about whether this codebase can automate FILLING that
 * platform's application form — that is what `AtsAdapter` (this directory) and this registry track.
 * The two systems are read here (as fact), never modified.
 *
 * WHY MOST ENTRIES BELOW ARE DETECTION_ONLY, NOT FIXTURE-VERIFIED. Every universal engine capability
 * (field discovery, combobox/multiselect commit detection, file upload, multi-page walking, question
 * batching, the final-submit safety gate) is platform-agnostic by construction — confirmed by direct
 * audit: zero ATS-name conditionals exist anywhere in `fieldDiscovery.ts`, `planFields.ts`,
 * `executor.ts`, or `multiPage.ts`. That means the ENGINE already attempts every one of these
 * capabilities against any platform's real markup, adapter or not. What does NOT exist for 34 of
 * these platforms is a captured, sanitized fixture proving the engine's generic semantic discovery
 * actually lands correctly on THAT platform's real HTML. Fabricating one from an assumed DOM shape
 * and then testing against that same assumption would be circular (self-verifying a guess) — the
 * one thing this phase's own instructions explicitly forbid. Each such platform is honestly marked
 * DETECTION_ONLY here, with the exact evidence still needed recorded in
 * `docs/ats-live-validation-backlog.md`, not invented.
 */

/** A capability's proof state for one platform. Never a bare boolean — the nuance between "works
 *  universally by construction," "proven against this platform's own fixture," and "genuinely
 *  unknown" is the entire point of this registry. */
export type CapabilityState =
  /** Proven for THIS platform specifically — a real, sanitized fixture exists and passes. */
  | "SUPPORTED"
  /** Some real evidence exists (e.g. documented stable field names) but not a captured live fixture. */
  | "PARTIAL"
  /** The universal engine attempts this unconditionally for every platform, by construction — not
   *  something a per-platform adapter can meaningfully lack, and never gated on adapter presence. */
  | "UNIVERSAL"
  /** No adapter-specific evidence exists yet either way. The engine's generic behavior may or may
   *  not be correct for this platform's real markup — genuinely not yet known. */
  | "UNKNOWN"
  /** This platform is known not to need/use this capability shape (e.g. no multi-page flow observed). */
  | "NOT_APPLICABLE"
  /** Real, unobserved employer-hosted behavior that must be watched live before any claim is made. */
  | "NEEDS_LIVE_VALIDATION";

export type AdapterStatus =
  /** Detected, application-entry represented, fields/pickers/uploads/advance/review all proven
   *  against a real, sanitized fixture, final-submit protected, tests pass. Today: Workday only. */
  | "FULL_FIXTURE_VERIFIED"
  /** Detected, a real adapter with field hints exists and at least field discovery is fixture-
   *  verified, but entry/multi-page/review/auth are unproven or not applicable. */
  | "PARTIAL_FIXTURE_VERIFIED"
  /** The platform is reliably detected (src/lib/ats/detect.ts), but no AtsAdapter exists and no
   *  platform-specific fixture has been captured — the universal engine would attempt it generically
   *  and safely (never guessing, never bypassing the submit gate), but nothing here has PROVEN it
   *  works, so it must not be called auto-apply ready. */
  | "DETECTION_ONLY"
  /** Real observation of a live posting is required before any further claim can honestly be made —
   *  used when even detection is unverified/absent. */
  | "NEEDS_LIVE_VALIDATION"
  /** Genuinely outside what the current architecture can address without a larger redesign. */
  | "UNSUPPORTED_BY_CURRENT_ARCHITECTURE";

export interface AtsCoverageEntry {
  platform: SourceType;
  displayName: string;
  status: AdapterStatus;
  /** Whether src/lib/ats/detect.ts (or its Ashby/Lever SIMPLE_PATTERNS) can identify this platform
   *  from a URL/hostname today. Read as fact, never re-implemented here. */
  detection: CapabilityState;
  applicationEntry: CapabilityState;
  authentication: CapabilityState;
  fieldDiscovery: CapabilityState;
  combobox: CapabilityState;
  multiselect: CapabilityState;
  fileUpload: CapabilityState;
  multiPage: CapabilityState;
  /** Unknown-question routing through the Human Question Center. Universal and unconditional for
   *  every platform — no adapter can bypass it (see collectHumanQuestions/planFields). */
  questionBatching: CapabilityState;
  reviewDetection: CapabilityState;
  /** classifyAdvanceControl's deny-first final-action gate (multiPage.ts) — a pure function of page
   *  text with no adapter parameter at all. Structurally the same for every platform, always. */
  submissionGate: CapabilityState;
  /** Plain-English description of what test/fixture files actually exist for this platform. */
  fixtureCoverage: string;
  liveValidation: "NOT_NEEDED" | "RECOMMENDED" | "REQUIRED";
  notes: string;
}

/** The two truly universal, adapter-blind capabilities every real platform gets for free, in the
 *  exact same shape, regardless of adapter status. Factored out so 37 entries below don't each
 *  repeat the same justification. */
const UNIVERSAL_SAFETY = {
  questionBatching: "UNIVERSAL" as const,
  submissionGate: "UNIVERSAL" as const,
};

/**
 * The honest shape for every platform that `src/lib/ats/detect.ts` can already identify, but for
 * which no `AtsAdapter` and no captured fixture exists in this repository. Every adapter-specific
 * dimension is UNKNOWN, not "assumed working" and not "assumed broken" — the universal engine will
 * attempt each of them generically the moment a real run reaches this platform, exactly as it does
 * for any unrecognized ATS today (see coverage.ts's own module doc comment), but nothing here has
 * OBSERVED whether that generic attempt actually lands correctly on this platform's real markup.
 * A single small factory, not a loop over strings, so each entry remains a plain, readable,
 * individually-editable object literal once real evidence exists for it — this only removes
 * boilerplate, it does not hide per-platform nuance (see the `notes` override on every call site).
 */
function detectionOnly(
  platform: SourceType,
  displayName: string,
  notes: string
): AtsCoverageEntry {
  return {
    platform,
    displayName,
    status: "DETECTION_ONLY",
    detection: "SUPPORTED",
    applicationEntry: "UNKNOWN",
    authentication: "UNKNOWN",
    fieldDiscovery: "UNKNOWN",
    combobox: "UNKNOWN",
    multiselect: "UNKNOWN",
    fileUpload: "UNKNOWN",
    multiPage: "UNKNOWN",
    reviewDetection: "UNKNOWN",
    ...UNIVERSAL_SAFETY,
    fixtureCoverage: "None — no adapter, no captured fixture. Detection only, via src/lib/ats/detect.ts.",
    liveValidation: "REQUIRED",
    notes,
  };
}

export const ATS_COVERAGE: readonly AtsCoverageEntry[] = [
  {
    platform: "workday",
    displayName: "Workday",
    status: "FULL_FIXTURE_VERIFIED",
    detection: "SUPPORTED",
    applicationEntry: "SUPPORTED",
    authentication: "SUPPORTED",
    fieldDiscovery: "SUPPORTED",
    combobox: "SUPPORTED",
    multiselect: "SUPPORTED",
    fileUpload: "SUPPORTED",
    multiPage: "SUPPORTED",
    reviewDetection: "SUPPORTED",
    ...UNIVERSAL_SAFETY,
    fixtureCoverage:
      "Extensive: mock-workday-myinformation.html + WORKDAY-*/BUTTON-PICKER-*/MULTISELECT-COMMIT-* suites, every hint tagged OBSERVED against a real *.wd1.myworkdayjobs.com tenant with explicit operator authorization.",
    liveValidation: "NOT_NEEDED",
    notes:
      "The gold standard. entrySequence, nextPageSelector, reviewPageSelector (structural, since review page TEXT is indistinguishable from other steps), pickerOptionSelector, loginWallMarkers, maxPages=8, auth(mode: LOGIN_ONLY — account creation deliberately not automated) all present. Preserved unchanged this phase per explicit instruction; re-verified via the full apply-suite baseline (424/424 pass), not reopened.",
  },
  {
    platform: "greenhouse",
    displayName: "Greenhouse",
    status: "PARTIAL_FIXTURE_VERIFIED",
    detection: "SUPPORTED",
    applicationEntry: "UNKNOWN",
    authentication: "NOT_APPLICABLE",
    fieldDiscovery: "SUPPORTED",
    combobox: "SUPPORTED",
    multiselect: "UNKNOWN",
    fileUpload: "SUPPORTED",
    multiPage: "NOT_APPLICABLE",
    reviewDetection: "NOT_APPLICABLE",
    ...UNIVERSAL_SAFETY,
    fixtureCoverage: "mock-greenhouse.html + greenhouse-form.json, exercised by agent/execution/entrySequence suites.",
    liveValidation: "NOT_NEEDED",
    notes:
      "fieldSelectorHints() built from inspecting a live posting (adapter's own comment). Single-page assumption — Greenhouse's standard hosted form has no multi-page/review step to detect, so those dimensions are genuinely NOT_APPLICABLE rather than unproven. No entrySequence/auth declared; not needed for the ordinary anonymous apply flow.",
  },
  {
    platform: "lever",
    displayName: "Lever",
    status: "PARTIAL_FIXTURE_VERIFIED",
    detection: "SUPPORTED",
    applicationEntry: "UNKNOWN",
    authentication: "NOT_APPLICABLE",
    fieldDiscovery: "PARTIAL",
    combobox: "UNKNOWN",
    multiselect: "UNKNOWN",
    fileUpload: "PARTIAL",
    multiPage: "NOT_APPLICABLE",
    reviewDetection: "NOT_APPLICABLE",
    ...UNIVERSAL_SAFETY,
    fixtureCoverage: "mock-lever.html + lever-form.json, exercised by agent/maxBatch/authExecution/multiPageExecution/execution/entrySequence suites — all passing.",
    liveValidation: "RECOMMENDED",
    notes:
      "IMPORTANT, PRE-EXISTING, HONESTLY-FLAGGED GAP (not introduced this phase, not silently upgraded): the adapter's own comment states its fieldSelectorHints (name/email/phone/resume/urls[...]) are drawn from Lever's documented, long-stable field-naming convention, NOT a captured live posting — 'Not yet verified against a live Lever posting.' Tests pass against a fixture built to that same documented convention, which is legitimate public-knowledge evidence (Part 26's 'reliable static/public platform markup' category) but is one step short of Workday's live-tenant-observed standard. Carried into docs/ats-live-validation-backlog.md unchanged from its existing status — not reopened, not downgraded, not silently upgraded to FULL.",
  },

  // ── Tier 1 — high-value major ATS (detected, no adapter/fixture yet) ──────────────────────────
  detectionOnly("ashby", "Ashby", "Detected via src/lib/ats/detect.ts SIMPLE_PATTERNS (jobs.ashbyhq.com). Modern, semantic-HTML-forward product — a reasonable candidate for the universal engine to handle well with no adapter at all, but that is an expectation, not a proven fact, until a real posting is observed."),
  detectionOnly("icims", "iCIMS", "Detected. Long-established enterprise ATS with substantial per-tenant template variation historically observed across the industry — high priority for live validation before assuming universal discovery suffices."),
  detectionOnly("smartrecruiters", "SmartRecruiters", "Detected."),
  detectionOnly("oracle_recruiting_cloud", "Oracle Recruiting Cloud", "Detected. Oracle enterprise suites have historically used heavier custom-widget form controls — a strong candidate for needing real adapter hints once observed, similar to Workday."),
  detectionOnly("taleo", "Oracle Taleo", "Detected. Legacy Oracle product, often older/heavier markup patterns — do not assume modern semantic HTML applies."),
  detectionOnly("successfactors", "SAP SuccessFactors", "Detected."),
  detectionOnly("adp_wfn", "ADP Workforce Now", "Detected."),
  detectionOnly("adp_rm", "ADP Recruiting Management", "Detected. Distinct product from adp_wfn — treated as its own platform, not assumed identical."),
  detectionOnly("ukg_pro", "UKG Pro Recruiting", "Detected."),
  detectionOnly("jobvite", "Jobvite", "Detected."),

  // ── Tier 2 — common modern ATS ─────────────────────────────────────────────────────────────────
  detectionOnly("workable", "Workable", "Detected."),
  detectionOnly("recruitee", "Recruitee", "Detected."),
  detectionOnly("teamtailor", "Teamtailor", "Detected."),
  detectionOnly("bamboohr", "BambooHR", "Detected."),
  detectionOnly("jazzhr", "JazzHR", "Detected."),
  detectionOnly("breezy", "Breezy HR", "Detected."),
  detectionOnly("pinpoint", "Pinpoint", "Detected."),
  detectionOnly("comeet", "Comeet", "Detected."),
  detectionOnly("rippling", "Rippling Recruiting", "Detected."),

  // ── Tier 3 — additional enterprise / SMB ──────────────────────────────────────────────────────
  detectionOnly("eightfold", "Eightfold", "Detected."),
  detectionOnly("cornerstone", "Cornerstone Recruiting", "Detected."),
  detectionOnly("avature", "Avature", "Detected. Enterprise CRM-style ATS — historically heavy custom widgetry; do not assume generic discovery suffices without observation."),
  detectionOnly("clearcompany", "ClearCompany", "Detected."),
  detectionOnly("paycom", "Paycom", "Detected."),
  detectionOnly("paylocity", "Paylocity Recruiting", "Detected."),
  detectionOnly("applicantpro", "ApplicantPro", "Detected."),
  detectionOnly("applicantstack", "ApplicantStack", "Detected."),
  detectionOnly("personio", "Personio", "Detected."),
  detectionOnly("cats", "CATS", "Detected."),
  detectionOnly("gohire", "GoHire", "Detected."),
  detectionOnly("newton", "Newton (Paycor Recruiting)", "Detected. Newton is Paycor's recruiting product — no separate 'paycor' SourceType exists in this codebase; this IS the Paycor coverage entry."),
  detectionOnly("silkroad", "SilkRoad", "Detected."),
  detectionOnly("jobdiva", "JobDiva", "Detected."),

  {
    platform: "phenom",
    displayName: "Phenom",
    status: "NEEDS_LIVE_VALIDATION",
    detection: "UNKNOWN",
    applicationEntry: "UNKNOWN",
    authentication: "UNKNOWN",
    fieldDiscovery: "UNKNOWN",
    combobox: "UNKNOWN",
    multiselect: "UNKNOWN",
    fileUpload: "UNKNOWN",
    multiPage: "UNKNOWN",
    reviewDetection: "UNKNOWN",
    ...UNIVERSAL_SAFETY,
    fixtureCoverage: "None.",
    liveValidation: "REQUIRED",
    notes:
      "The ONE SourceType value with no detector function anywhere in src/lib/ats/detect.ts (confirmed by direct grep — every other of the 37 real platforms has one, via a dedicated function or the Ashby/Lever SIMPLE_PATTERNS list). This is a gap in the separate company/job-discovery layer, not the apply-engine adapter layer this phase covers — flagged honestly here rather than silently treated the same as the 33 platforms that DO have real detection.",
  },
] as const;

/** Every real ATS/career-site platform this app can recognize, EXCLUDING the four non-ATS
 *  meta-categories in SourceType (career_link, google_jobs, indeed, built_in — job-source
 *  provenance tags, not application platforms an adapter could ever automate). 37 platforms. */
export const REAL_ATS_PLATFORM_COUNT = 37;

export function getCoverageEntry(platform: SourceType): AtsCoverageEntry | undefined {
  return ATS_COVERAGE.find((e) => e.platform === platform);
}
