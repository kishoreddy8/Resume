import { discoverCompanySource, type DiscoveryResult } from "@/lib/ats/discovery";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import { fetchJobsForCompany } from "@/lib/normalize";
import { validateJobSample } from "@/lib/ats/pendingConnectorValidation";
import { categorizeThrownError } from "@/lib/scan/errors";
import { decodeWorkdayToken } from "@/lib/ats/workday";
import { canonicalAdpRmUrl } from "@/lib/ats/adpRecruitingManagement";
import { canonicalAdpWorkforceNowUrl } from "@/lib/ats/adpWorkforceNow";
import { canonicalApplicantProUrl } from "@/lib/ats/applicantpro";
import { canonicalApplicantStackUrl } from "@/lib/ats/applicantstack";
import { canonicalAvatureUrl } from "@/lib/ats/avature";
import { canonicalBambooHrUrl } from "@/lib/ats/bamboohr";
import { canonicalBreezyUrl } from "@/lib/ats/breezy";
import { canonicalCatsUrl } from "@/lib/ats/cats";
import { canonicalClearCompanyUrl } from "@/lib/ats/clearcompany";
import { canonicalComeetUrl } from "@/lib/ats/comeet";
import { canonicalCornerstoneUrl } from "@/lib/ats/cornerstone";
import { canonicalEightfoldUrl } from "@/lib/ats/eightfold";
import { canonicalGoHireUrl } from "@/lib/ats/gohire";
import { canonicalIcimsUrl } from "@/lib/ats/icims";
import { canonicalJazzHrUrl } from "@/lib/ats/jazzhr";
import { canonicalJobDivaUrl } from "@/lib/ats/jobdiva";
import { canonicalJobviteUrl } from "@/lib/ats/jobvite";
import { canonicalNewtonUrl } from "@/lib/ats/newton";
import { canonicalOracleRecruitingCloudUrl } from "@/lib/ats/oracleRecruitingCloud";
import { canonicalPaycomUrl } from "@/lib/ats/paycom";
import { canonicalPaylocityUrl } from "@/lib/ats/paylocity";
import { canonicalPersonioUrl } from "@/lib/ats/personio";
import { canonicalPhenomUrl } from "@/lib/ats/phenom";
import { canonicalPinpointUrl } from "@/lib/ats/pinpoint";
import { canonicalRipplingUrl } from "@/lib/ats/rippling";
import { canonicalSilkRoadUrl } from "@/lib/ats/silkroad";
import { canonicalSmartRecruitersUrl } from "@/lib/ats/smartrecruiters";
import { canonicalSuccessFactorsUrl } from "@/lib/ats/successfactors";
import { canonicalTaleoUrl } from "@/lib/ats/taleo";
import { canonicalTeamtailorUrl } from "@/lib/ats/teamtailor";
import { canonicalUkgProUrl } from "@/lib/ats/ukgPro";
import { canonicalWorkableUrl } from "@/lib/ats/workable";
import type { Company, SourceType } from "@/types";

/**
 * ATS Source Self-Healing, Stage 2 — read-only shadow rediscovery. Composes the SAME
 * discovery/detection/validation building blocks the rest of the codebase already uses for onboarding
 * new companies (discoverCompanySource, detectAtsFromUrlString, fetchJobsForCompany,
 * validateJobSample) — this module adds no new discovery or validation ENGINE, only the "start from a
 * company's current, apparently-stale source and see what discovery finds today" orchestration and
 * the confidence/recommendation layer on top.
 *
 * SHADOW MODE ONLY: nothing in this module writes to companies, job_sources, or any other production
 * table. attemptSourceRediscovery is a pure read (network I/O aside) — see its own doc comment.
 */

// --- Canonical-URL reconstruction, by source_type -----------------------------------------------
// Reused directly from each provider's own existing canonical*Url export (the same functions
// detect.ts already imports for its own DiscoveryResult output) — greenhouse/lever/ashby have no
// dedicated export (their canonical shape is a single inline template each provider's own detectX
// function already uses; see detect.ts's detectGreenhouse/SIMPLE_PATTERNS), so those three are
// reproduced here as the exact same one-line templates, not new logic.
const CANONICAL_URL_BUILDERS: Partial<Record<SourceType, (token: string) => string>> = {
  greenhouse: (token) => `https://job-boards.greenhouse.io/${encodeURIComponent(token)}`,
  lever: (token) => `https://jobs.lever.co/${encodeURIComponent(token)}`,
  ashby: (token) => `https://jobs.ashbyhq.com/${encodeURIComponent(token)}`,
  workday: (token) => {
    const { tenant, host, site } = decodeWorkdayToken(token);
    return `https://${tenant}.${host}.myworkdayjobs.com/${site}`;
  },
  adp_rm: canonicalAdpRmUrl,
  adp_wfn: canonicalAdpWorkforceNowUrl,
  applicantpro: canonicalApplicantProUrl,
  applicantstack: canonicalApplicantStackUrl,
  avature: canonicalAvatureUrl,
  bamboohr: canonicalBambooHrUrl,
  breezy: canonicalBreezyUrl,
  cats: canonicalCatsUrl,
  clearcompany: canonicalClearCompanyUrl,
  comeet: canonicalComeetUrl,
  cornerstone: canonicalCornerstoneUrl,
  eightfold: canonicalEightfoldUrl,
  gohire: canonicalGoHireUrl,
  icims: canonicalIcimsUrl,
  jazzhr: canonicalJazzHrUrl,
  jobdiva: canonicalJobDivaUrl,
  jobvite: canonicalJobviteUrl,
  newton: canonicalNewtonUrl,
  oracle_recruiting_cloud: canonicalOracleRecruitingCloudUrl,
  paycom: canonicalPaycomUrl,
  paylocity: canonicalPaylocityUrl,
  personio: canonicalPersonioUrl,
  phenom: canonicalPhenomUrl,
  pinpoint: canonicalPinpointUrl,
  rippling: canonicalRipplingUrl,
  silkroad: canonicalSilkRoadUrl,
  smartrecruiters: canonicalSmartRecruitersUrl,
  successfactors: canonicalSuccessFactorsUrl,
  taleo: canonicalTaleoUrl,
  teamtailor: canonicalTeamtailorUrl,
  ukg_pro: canonicalUkgProUrl,
  workable: canonicalWorkableUrl,
};

/** Never throws — an unbuildable/malformed token (exactly the kind of thing invalid_config evidence
 *  already implies) just means no reconstructable URL, not a crash. */
function reconstructCanonicalUrl(sourceType: SourceType, token: string): string | null {
  const builder = CANONICAL_URL_BUILDERS[sourceType];
  if (!builder) return null;
  try {
    return builder(token);
  } catch {
    return null;
  }
}

// A SafeFetchError surfaced through discoverCompanySource's own catch (see discovery.ts) always
// folds its reason into a "Could not reach {url}: {message}" string — disallowed_host is the one
// reason that means "this would have been an SSRF-unsafe redirect/target," not merely unreachable.
// String-matching on safeFetch.ts's own fixed message prefixes is a deliberate, minimal way to
// recover that one distinction without modifying discovery.ts's public contract (out of scope here).
const UNSAFE_REDIRECT_SIGNATURE = /Disallowed host|Disallowed IP literal/;

export interface SourceSnapshot {
  sourceType: SourceType | null;
  atsBoardToken: string | null;
  url: string | null;
}

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export type RediscoveryRecommendation =
  | "AUTO_REPLACE_CANDIDATE"
  | "NEEDS_SOURCE_REVIEW"
  | "NO_REPLACEMENT_FOUND"
  | "CURRENT_SOURCE_STILL_VALID"
  | "SECURITY_REJECTION";

/** Deterministic, transparent evidence flags — see this module's doc comment. No AI/LLM judgment;
 *  every flag is a plain boolean derived from a specific, named fact already computed above it. */
export interface ConfidenceInputs {
  officialCareerPageDirectLink: boolean;
  sameProvider: boolean;
  sameCompanyDomain: boolean;
  candidateValidationPassed: boolean;
  companyIdentityConfirmed: boolean;
  /** Stage 1+2 has no data source for corporate-parent/subsidiary relationships — always false, an
   *  honest "not evaluated," never a guessed true. A future stage could wire this to a real signal. */
  parentRelationshipConfirmed: boolean;
  crossProviderMigration: boolean;
  returnedValidJobs: boolean;
  zeroJobValidBoard: boolean;
  unsafeRedirect: boolean;
  thirdPartyAggregator: boolean;
}

export interface RediscoveryAttemptResult {
  companyId: number;
  companyName: string;
  oldSource: SourceSnapshot;
  candidateSource: SourceSnapshot | null;
  discoveryOutcome: DiscoveryResult["status"] | "NO_INPUT_URL";
  discoveryReason: string;
  sameAsCurrent: boolean;
  providerChanged: boolean;
  evidence: string[];
  validationOutcome: "PASSED" | "FAILED" | "NOT_ATTEMPTED";
  validationReason: string | null;
  confidenceInputs: ConfidenceInputs;
  confidence: ConfidenceLevel | null;
  recommendedAction: RediscoveryRecommendation;
}

const emptyConfidenceInputs = (): ConfidenceInputs => ({
  officialCareerPageDirectLink: false,
  sameProvider: false,
  sameCompanyDomain: false,
  candidateValidationPassed: false,
  companyIdentityConfirmed: false,
  parentRelationshipConfirmed: false,
  crossProviderMigration: false,
  returnedValidJobs: false,
  zeroJobValidBoard: false,
  unsafeRedirect: false,
  thirdPartyAggregator: false,
});

/**
 * Deterministic HIGH/MEDIUM/LOW confidence from the evidence flags — see this module's own doc
 * comment on why this stays a small set of explicit if/else rules, never a weighted/numeric score.
 */
function deriveConfidence(inputs: ConfidenceInputs): ConfidenceLevel {
  if (inputs.unsafeRedirect || inputs.thirdPartyAggregator) return "LOW";
  if (!inputs.candidateValidationPassed) return "LOW";
  if (!inputs.companyIdentityConfirmed) return "LOW";
  if (inputs.sameProvider && !inputs.crossProviderMigration) return "HIGH";
  // Validation passed and identity is confirmed, but the provider changed (a genuine migration) or
  // the board is a clean zero-job board (structurally valid, nothing to sample-verify against) —
  // real, positive evidence, just not as strong as an exact same-provider correction.
  if (inputs.crossProviderMigration || inputs.zeroJobValidBoard) return "MEDIUM";
  return "LOW";
}

function deriveRecommendation(
  discoveryOutcome: RediscoveryAttemptResult["discoveryOutcome"],
  sameAsCurrent: boolean,
  inputs: ConfidenceInputs,
  confidence: ConfidenceLevel | null
): RediscoveryRecommendation {
  if (inputs.unsafeRedirect) return "SECURITY_REJECTION";
  if (discoveryOutcome !== "VERIFIED") return "NO_REPLACEMENT_FOUND";
  if (sameAsCurrent) return "CURRENT_SOURCE_STILL_VALID";
  if (!inputs.candidateValidationPassed) return "NEEDS_SOURCE_REVIEW";
  return confidence === "HIGH" ? "AUTO_REPLACE_CANDIDATE" : "NEEDS_SOURCE_REVIEW";
}

function hostnameOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Registrable-domain-ish comparison: strips a leading "www." and compares the last two labels, so
 *  "careers.example.com" is recognized as the same company domain as "example.com" without needing a
 *  full public-suffix list — deliberately conservative (a false "different" is safe here; it only
 *  costs a confidence downgrade, never a false-positive identity match). */
function sameRegistrableDomain(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (h: string) => h.replace(/^www\./, "").split(".").slice(-2).join(".");
  return norm(a) === norm(b);
}

export interface AttemptSourceRediscoveryOptions {
  /** Test-only injection point, mirroring checkConnectorHealth's own fetcher override. */
  discoverer?: typeof discoverCompanySource;
  fetcher?: typeof fetchJobsForCompany;
  sampleSize?: number;
}

/**
 * Read-only. Never mutates company/job_sources rows, never touches jobs/lifecycle state. The
 * candidate is validated by fetching a small sample directly from the CANDIDATE'S source (an
 * in-memory Company-shaped object, never written to the database) — never by reusing the failing
 * current source, and never by assuming discovery alone is sufficient (see Step 5's own requirement).
 */
export async function attemptSourceRediscovery(
  company: Company,
  options: AttemptSourceRediscoveryOptions = {}
): Promise<RediscoveryAttemptResult> {
  const discoverer = options.discoverer ?? discoverCompanySource;
  const fetcher = options.fetcher ?? fetchJobsForCompany;
  const sampleSize = Math.max(1, Math.min(Math.trunc(options.sampleSize ?? 3), 3));
  const evidence: string[] = [];

  const oldUrl = company.source_type && company.ats_board_token
    ? reconstructCanonicalUrl(company.source_type, company.ats_board_token)
    : null;
  const oldSource: SourceSnapshot = {
    sourceType: company.source_type,
    atsBoardToken: company.ats_board_token,
    url: oldUrl,
  };

  // Prefer the company's own recorded career page (most robust to a full provider migration); fall
  // back to the reconstructed current-board URL (catches a token/site rename on the SAME provider,
  // or a redirect to wherever the board actually lives now).
  const discoveryInputUrl = company.career_page_url ?? oldUrl;
  if (!discoveryInputUrl) {
    evidence.push("No career_page_url on file and the current source_type/ats_board_token could not be reconstructed into a URL — nothing to rediscover from.");
    return {
      companyId: company.id,
      companyName: company.name,
      oldSource,
      candidateSource: null,
      discoveryOutcome: "NO_INPUT_URL",
      discoveryReason: evidence[0],
      sameAsCurrent: false,
      providerChanged: false,
      evidence,
      validationOutcome: "NOT_ATTEMPTED",
      validationReason: null,
      confidenceInputs: emptyConfidenceInputs(),
      confidence: null,
      recommendedAction: "NO_REPLACEMENT_FOUND",
    };
  }
  evidence.push(
    company.career_page_url
      ? `Re-ran discovery from the company's recorded career page: ${discoveryInputUrl}`
      : `No career_page_url on file — re-ran discovery from the reconstructed current source URL: ${discoveryInputUrl}`
  );

  const discovery = await discoverer(discoveryInputUrl);
  evidence.push(`Discovery result: ${discovery.status} — ${discovery.reason}`);

  const inputs = emptyConfidenceInputs();
  inputs.officialCareerPageDirectLink = Boolean(company.career_page_url);
  inputs.unsafeRedirect = discovery.status !== "VERIFIED" && UNSAFE_REDIRECT_SIGNATURE.test(discovery.reason);

  if (discovery.status !== "VERIFIED") {
    const confidence = inputs.unsafeRedirect ? "LOW" : null;
    return {
      companyId: company.id,
      companyName: company.name,
      oldSource,
      candidateSource: null,
      discoveryOutcome: discovery.status,
      discoveryReason: discovery.reason,
      sameAsCurrent: false,
      providerChanged: false,
      evidence,
      validationOutcome: "NOT_ATTEMPTED",
      validationReason: null,
      confidenceInputs: inputs,
      confidence,
      recommendedAction: deriveRecommendation(discovery.status, false, inputs, confidence),
    };
  }

  const candidateSource: SourceSnapshot = {
    sourceType: discovery.sourceType,
    atsBoardToken: discovery.atsBoardToken,
    url: discovery.discoveredJobsUrl,
  };
  const sameAsCurrent = discovery.sourceType === company.source_type && discovery.atsBoardToken === company.ats_board_token;
  const providerChanged = discovery.sourceType !== null && discovery.sourceType !== company.source_type;
  inputs.sameProvider = discovery.sourceType === company.source_type;
  inputs.crossProviderMigration = providerChanged;

  if (sameAsCurrent) {
    evidence.push("Rediscovery independently confirmed the exact same source_type/ats_board_token already on file — the current source is still the correct one.");
    return {
      companyId: company.id,
      companyName: company.name,
      oldSource,
      candidateSource,
      discoveryOutcome: discovery.status,
      discoveryReason: discovery.reason,
      sameAsCurrent,
      providerChanged: false,
      evidence,
      validationOutcome: "NOT_ATTEMPTED",
      validationReason: null,
      confidenceInputs: inputs,
      confidence: null,
      recommendedAction: "CURRENT_SOURCE_STILL_VALID",
    };
  }

  // Company identity check — the ONLY cross-check available in Stage 1+2 without a corporate-parent
  // data source (see parentRelationshipConfirmed's own doc comment above): does the discovered
  // board's hostname share a registrable domain with the company's own verified domain (when one
  // exists), or is the candidate's canonical URL literally the same host detectAtsFromUrlString would
  // re-derive from itself (a pure identity self-check, always true for a well-formed VERIFIED result,
  // catching only a construction bug rather than adding a real signal on its own).
  const candidateHost = hostnameOf(candidateSource.url);
  inputs.sameCompanyDomain = sameRegistrableDomain(candidateHost, company.verified_domain);
  const selfDetected = candidateSource.url ? detectAtsFromUrlString(candidateSource.url) : null;
  inputs.companyIdentityConfirmed = Boolean(
    selfDetected && selfDetected.sourceType === candidateSource.sourceType && selfDetected.atsBoardToken === candidateSource.atsBoardToken
  );
  if (company.domain_identity_status === "VERIFIED" && company.verified_domain) {
    evidence.push(
      inputs.sameCompanyDomain
        ? `Candidate board host (${candidateHost}) matches the company's verified domain (${company.verified_domain}).`
        : `Candidate board host (${candidateHost}) does not obviously match the company's verified domain (${company.verified_domain}) — third-party ATS hosting is normal and expected here, this is not itself disqualifying.`
    );
  }

  // Validate the CANDIDATE source directly — never the failing current source, never discovery
  // output alone (Step 5's explicit requirement). Uses the exact same fetchJobsForCompany dispatch
  // every real scan/validation path uses, against an in-memory Company-shaped object that is never
  // persisted.
  let validationOutcome: RediscoveryAttemptResult["validationOutcome"] = "NOT_ATTEMPTED";
  let validationReason: string | null = null;
  if (candidateSource.sourceType && candidateSource.atsBoardToken) {
    const ephemeralCandidate: Company = { ...company, source_type: candidateSource.sourceType, ats_board_token: candidateSource.atsBoardToken };
    try {
      const jobs = await fetcher(ephemeralCandidate, { maxJobs: sampleSize, usOnly: true, maxAttempts: 2, timeoutMs: 15_000 });
      inputs.returnedValidJobs = jobs.length > 0;
      inputs.zeroJobValidBoard = jobs.length === 0;
      const sampleError = jobs.length > 0 ? validateJobSample(jobs) : null;
      if (sampleError) {
        validationOutcome = "FAILED";
        validationReason = sampleError;
        inputs.candidateValidationPassed = false;
      } else {
        validationOutcome = "PASSED";
        validationReason = jobs.length > 0
          ? `Validated ${jobs.length} genuine U.S. job sample${jobs.length === 1 ? "" : "s"} from the candidate source`
          : "Candidate board reached successfully with zero current U.S. jobs — structurally valid, empty board";
        inputs.candidateValidationPassed = true;
      }
    } catch (err) {
      const category = categorizeThrownError(err);
      validationOutcome = "FAILED";
      validationReason = err instanceof Error ? err.message : String(err);
      inputs.candidateValidationPassed = false;
      evidence.push(`Candidate validation fetch failed (${category}): ${validationReason}`);
    }
  } else {
    validationReason = "Discovery marked VERIFIED without both a sourceType and atsBoardToken — cannot validate";
  }
  evidence.push(`Candidate validation: ${validationOutcome}${validationReason ? ` — ${validationReason}` : ""}`);

  const confidence = deriveConfidence(inputs);
  return {
    companyId: company.id,
    companyName: company.name,
    oldSource,
    candidateSource,
    discoveryOutcome: discovery.status,
    discoveryReason: discovery.reason,
    sameAsCurrent,
    providerChanged,
    evidence,
    validationOutcome,
    validationReason,
    confidenceInputs: inputs,
    confidence,
    recommendedAction: deriveRecommendation(discovery.status, sameAsCurrent, inputs, confidence),
  };
}
