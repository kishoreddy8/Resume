import { getCompany } from "@/db/queries/companies";
import { normalizeOrganizationDomain } from "@/db/organizationRegistryCore";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import { CANONICAL_INGESTION_MAX_AGE_DAYS, parseAtsDate } from "@/lib/ats/jobFreshness";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import type {
  CompanyMatchResult,
  EmployerRelationship,
  NormalizedExternalJob,
  ObservationDecision,
  SignalClassification,
  UrlClassification,
} from "./types";

/**
 * Phase 7 — conservative staffing/recruiter detection. Deliberately NOT a giant hardcoded agency
 * name list (per the task's own instruction) — evidence-based: (a) language patterns that show up in
 * agency-posted listings regardless of which agency it is, or (b) the apply/direct URL resolving to a
 * domain that is NOT the matched company's own verified domain (posting under Company X's name but
 * routing applicants to an unrelated third-party domain). Either alone is enough to flag
 * STAFFING_AGENCY; absence of both evidence is UNKNOWN, never DIRECT_EMPLOYER by default.
 */
const AGENCY_LANGUAGE_PATTERNS: RegExp[] = [
  /\bstaffing\b/i,
  /\brecruiting\b/i,
  /\brecruitment\b/i,
  /\btalent solutions?\b/i,
  /\bconfidential client\b/i,
  /\bon behalf of\b/i,
  /\bvia\s+\S+/i, // "Confidential Client via BrightStar Staffing"
  /\bstaffing agency\b/i,
  /\bexecutive search\b/i,
];

/** Exported so other modules (e.g. Stage 13's new-employer onboarding eligibility check) can reuse
 *  the exact same evidence-based detection without duplicating the pattern list. */
export function containsAgencyLanguage(employerName: string): boolean {
  return AGENCY_LANGUAGE_PATTERNS.some((re) => re.test(employerName));
}

export function classifyEmployerRelationship(job: NormalizedExternalJob, match: CompanyMatchResult): EmployerRelationship {
  if (containsAgencyLanguage(job.employerName)) return "STAFFING_AGENCY";

  if (match.companyId) {
    const company = getCompany(match.companyId);
    const verifiedDomain = company?.verified_domain ? normalizeOrganizationDomain(company.verified_domain) : null;
    const destinationUrl = job.directEmployerUrl ?? job.applyUrl;
    if (verifiedDomain && destinationUrl) {
      const destinationDomain = safeDomain(destinationUrl);
      // A confidently-matched company (by name/alias) whose apply destination resolves to a
      // completely different domain than its own verified site is exactly the "advertising work
      // for an unnamed/mismatched client" pattern — treated as agency evidence even with no
      // language hit. A destination on a well-known ATS vendor's own domain (e.g. boards.
      // greenhouse.io) is NOT a mismatch — that's the employer's real board, just vendor-hosted.
      if (destinationDomain && !isSameOrAtsHostedDomain(destinationDomain, verifiedDomain, destinationUrl)) {
        return "STAFFING_AGENCY";
      }
    }
  }

  // ATS_BOARD is standalone-strong evidence (an existing company's own board/token identity).
  // NAME is only ever returned by matchCompanyForObservation when already corroborated by
  // independent ATS/apply-URL evidence (Stage 12's multi-signal requirement) — safe to trust here too.
  if (match.confidence === "DOMAIN") return "DIRECT_EMPLOYER";
  if (match.confidence === "ALIAS") return "DIRECT_EMPLOYER";
  if (match.confidence === "ATS_BOARD") return "DIRECT_EMPLOYER";
  if (match.confidence === "NAME") return "DIRECT_EMPLOYER";
  return "UNKNOWN_EMPLOYER_RELATIONSHIP";
}

function isSameOrAtsHostedDomain(destinationDomain: string, verifiedDomain: string, destinationUrl: string): boolean {
  if (destinationDomain === verifiedDomain || destinationDomain.endsWith(`.${verifiedDomain}`)) return true;
  // A real ATS vendor domain (boards.greenhouse.io, X.wd5.myworkdayjobs.com, ...) is a legitimate
  // employer board even though it isn't the employer's own domain — detectAtsFromUrlString already
  // knows the full list of these, so defer to it rather than re-listing vendor domains here. Must be
  // called with the FULL destination URL (not a domain-only reconstruction): several detectors
  // (Workday's tenant/site, Greenhouse's board token, ...) only appear in the URL PATH, so a
  // domain-only "https://{host}" always fails detection even for a genuine, real employer board.
  return detectAtsFromUrlString(destinationUrl) !== null;
}

export function classifyUrlEvidence(job: NormalizedExternalJob, match: CompanyMatchResult): { classification: UrlClassification; provider: string | null; boardToken: string | null } {
  const candidateUrl = job.directEmployerUrl ?? job.applyUrl;
  if (!candidateUrl) return { classification: "AGGREGATOR_ONLY", provider: null, boardToken: null };

  const detection = detectAtsFromUrlString(candidateUrl);
  if (detection) return { classification: "DIRECT_ATS", provider: detection.sourceType, boardToken: detection.atsBoardToken };

  if (match.companyId) {
    const company = getCompany(match.companyId);
    const verifiedDomain = company?.verified_domain ? normalizeOrganizationDomain(company.verified_domain) : null;
    const destinationDomain = safeDomain(candidateUrl);
    if (verifiedDomain && destinationDomain && (destinationDomain === verifiedDomain || destinationDomain.endsWith(`.${verifiedDomain}`))) {
      return { classification: "GENERIC_EMPLOYER", provider: null, boardToken: null };
    }
  }

  return { classification: "UNKNOWN", provider: null, boardToken: null };
}

function safeDomain(url: string): string | null {
  try {
    const normalized = normalizeOrganizationDomain(url);
    return normalized || null;
  } catch {
    return null;
  }
}

export interface CoverageState {
  activeJobCount: number;
  resolutionStatus: string;
}

/** Phase 8 — signal classification. COVERAGE_MISMATCH (inadequate CareerOps coverage + confident
 *  direct-employer evidence) is the priority-queue signal that feeds the Discovery V2 bridge. */
export function classifySignal(
  match: CompanyMatchResult,
  relationship: EmployerRelationship,
  coverage: CoverageState | null
): SignalClassification {
  if (match.confidence === "AMBIGUOUS") return "AMBIGUOUS";
  if (match.confidence === "UNMATCHED" || !match.companyId) return "NO_SIGNAL";
  if (relationship === "STAFFING_AGENCY") return "AGENCY_FILTERED";

  const adequatelyCovered = coverage !== null && coverage.activeJobCount >= 1 && coverage.resolutionStatus === "VERIFIED";
  if (adequatelyCovered) return "ALREADY_COVERED";

  return relationship === "DIRECT_EMPLOYER" ? "COVERAGE_MISMATCH" : "EXTERNAL_HIRING_SIGNAL";
}

/** Phase 10 — minimum bar for SECONDARY_JOB_CANDIDATE eligibility specifically. Distinct from signal
 *  classification: a row can be a legitimate EXTERNAL_HIRING_SIGNAL or COVERAGE_MISMATCH worth
 *  recording as evidence while still failing this gate (e.g. no description, non-US) and therefore
 *  never becoming a jobs-table row. */
export function evaluateQualityGate(
  job: NormalizedExternalJob,
  match: CompanyMatchResult,
  relationship: EmployerRelationship,
  urlClassification: UrlClassification
): ObservationDecision | null {
  if (match.confidence === "AMBIGUOUS") return "AMBIGUOUS_EMPLOYER";
  if (match.confidence === "UNMATCHED" || !match.companyId) return "DISCOVERY_BEACON_ONLY";
  if (relationship === "STAFFING_AGENCY") return "STAFFING_AGENCY";

  const locationScope = classifyJobLocation(job.location);
  if (locationScope === "NON_US") return "NON_US";

  if (!job.title.trim()) return "INVALID";
  const candidateUrl = job.listingUrl || job.applyUrl;
  if (!candidateUrl || !isParseableUrl(candidateUrl)) return "INVALID";
  if (!job.applyUrl && !job.directEmployerUrl) return "LOW_QUALITY";
  if (!job.description || job.description.trim().length < 100) return "LOW_QUALITY";

  const staleness = evaluateStaleness(job.postedAt);
  if (staleness === "STALE") return "STALE";
  // Phase 6: an age that cannot be established must never be silently treated as fresh — that
  // would broaden eligibility beyond what the evidence supports. Unlike isJobFreshForIngestion's
  // ATS-specific "missing/unparseable date -> fall back to discovery timestamp, eligible" rule
  // (which is correct there because a fresh ATS scan finding the posting live IS itself fresh
  // evidence), an external listing's unparseable date has no equivalent "we just saw it on the
  // official board" guarantee — it stays evidence-only, never a secondary-job candidate.
  if (staleness === "UNKNOWN") return "DISCOVERY_BEACON_ONLY";

  // Only a confident direct-employer relationship with resolvable ATS/generic-employer URL
  // evidence ever qualifies automatically — Phase 7's explicit rule. Everything else that got this
  // far (UNKNOWN relationship, or DIRECT_EMPLOYER with only an AGGREGATOR_ONLY url) is real,
  // recorded evidence but stays review-only.
  if (relationship === "DIRECT_EMPLOYER" && (urlClassification === "DIRECT_ATS" || urlClassification === "GENERIC_EMPLOYER")) {
    return null; // null = passes the gate; caller decides SECONDARY_JOB_CANDIDATE vs DISCOVERY_BEACON_ONLY
  }
  return "DISCOVERY_BEACON_ONLY";
}

function isParseableUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Reuses parseAtsDate (the same date parser the ATS ingestion pipeline uses — src/lib/ats/
 *  jobFreshness.ts) and compares against the one canonical CANONICAL_INGESTION_MAX_AGE_DAYS
 *  threshold, so external and ATS freshness policy can never diverge again. postedAt=null or
 *  unparseable (e.g. Google Jobs' relative "2 days ago" text) is UNKNOWN, never FRESH — see
 *  evaluateQualityGate's own comment for why that differs from the ATS-side fallback rule. */
function evaluateStaleness(postedAt: string | null): "FRESH" | "STALE" | "UNKNOWN" {
  if (!postedAt) return "UNKNOWN";
  const parsed = parseAtsDate(postedAt);
  if (!parsed) return "UNKNOWN";
  const ageDays = Math.floor((Date.now() - parsed.getTime()) / DAY_MS);
  return ageDays > CANONICAL_INGESTION_MAX_AGE_DAYS ? "STALE" : "FRESH";
}
