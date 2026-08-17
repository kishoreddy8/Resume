import { createCompany, getCompany, updateCompanyDomainIdentity } from "@/db/queries/companies";
import { createProposalFromDiscoveryV2 } from "@/db/queries/atsSourceProposals";
import {
  findCompanyIdByVerifiedDomain,
  findOrganizationIdByDomain,
  findOrganizationIdsByAliasName,
  getCompanyForOrganization,
  getOrganizationForCompany,
} from "@/db/queries/organizationRegistry";
import { normalizeOrganizationDomain } from "@/db/organizationRegistryCore";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import { CANONICAL_INGESTION_MAX_AGE_DAYS, parseAtsDate } from "@/lib/ats/jobFreshness";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import { containsAgencyLanguage } from "./classify";
import type { AtsDetection } from "@/lib/ats/detect";
import type { AtsSourceProposal } from "@/types";
import type { CompanyMatchResult, NormalizedExternalJob } from "./types";

/**
 * Stage 13 — safe onboarding of a legitimate U.S. employer that Built In surfaces but CareerOps does
 * not yet track. Deliberately narrow: only ever considered for an UNMATCHED observation (never
 * AMBIGUOUS — see evaluateNewEmployerEligibility's first check), requires the SAME evidence bar as an
 * existing-company secondary job (US, <=20 days, real description, not staffing, real Apply/employer
 * URL), plus domain-specific safety (not an aggregator/tracker domain, not already claimed by an
 * existing company). Reuses the canonical company/organization write path (createCompany,
 * updateCompanyDomainIdentity, createProposalFromDiscoveryV2) verbatim — no second registry, no
 * second proposal system.
 */

/** Known non-employer domains: Built In itself, ad-tracking redirect hosts, and common job
 *  aggregators — Phase 4's explicit list plus the same aggregator set normalize.ts's Google Jobs
 *  normalizer already treats as non-direct-employer evidence. Never used to REJECT a company that
 *  already matched some other way — only to withhold NEW-employer identity evidence. */
const NON_EMPLOYER_DOMAINS = new Set([
  "builtin.com",
  "doubleclick.net",
  "googleadservices.com",
  "google.com",
  "indeed.com",
  "linkedin.com",
  "dice.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "monster.com",
  "careerbuilder.com",
  "simplyhired.com",
]);

function isNonEmployerDomain(domain: string): boolean {
  if (NON_EMPLOYER_DOMAINS.has(domain)) return true;
  for (const blocked of NON_EMPLOYER_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

function safeDomainFromUrl(url: string): string | null {
  try {
    const normalized = normalizeOrganizationDomain(url);
    return normalized || null;
  } catch {
    return null;
  }
}

export interface NewEmployerEligibility {
  eligible: boolean;
  reason: string;
  /** The employer's OWN domain, only set when the apply/direct-employer URL is NOT a recognized ATS
   *  vendor domain (Phase 4: an ATS vendor domain proves ATS identity, never company.verified_domain). */
  verifiedDomain: string | null;
  atsDetection: AtsDetection | null;
}

export function evaluateNewEmployerEligibility(job: NormalizedExternalJob, match: CompanyMatchResult): NewEmployerEligibility {
  const deny = (reason: string): NewEmployerEligibility => ({ eligible: false, reason, verifiedDomain: null, atsDetection: null });

  // Only ever applicable to a genuinely unmatched observation — an ambiguous match must never fall
  // through into "let's just create a new company instead."
  if (match.confidence !== "UNMATCHED") return deny("Not applicable — employer already resolved or ambiguous");

  const employerName = job.employerName.trim();
  if (!employerName) return deny("No employer name on the listing");
  if (containsAgencyLanguage(employerName)) return deny("Staffing/recruiter language detected in employer name");

  const locationScope = classifyJobLocation(job.location);
  if (locationScope !== "US") return deny(`Location scope is ${locationScope}, not US`);

  if (!job.postedAt) return deny("No posting date available");
  const parsedDate = parseAtsDate(job.postedAt);
  if (!parsedDate) return deny("Posting date is unparseable");
  const ageDays = Math.floor((Date.now() - parsedDate.getTime()) / (24 * 60 * 60 * 1000));
  if (ageDays > CANONICAL_INGESTION_MAX_AGE_DAYS) return deny(`Posting is ${ageDays} days old, exceeds the ${CANONICAL_INGESTION_MAX_AGE_DAYS}-day window`);

  if (!job.description || job.description.trim().length < 100) return deny("Description too short or missing");

  const candidateUrl = job.directEmployerUrl ?? job.applyUrl;
  if (!candidateUrl) return deny("No direct Apply/employer URL present");

  const domain = safeDomainFromUrl(candidateUrl);
  if (!domain) return deny("Apply/employer URL domain is not parseable");
  if (isNonEmployerDomain(domain)) return deny(`Domain "${domain}" is a known aggregator/tracker, not employer identity evidence`);

  const existingCompanyId = findCompanyIdByVerifiedDomain(domain);
  if (existingCompanyId) return deny(`Domain "${domain}" is already claimed by an existing CareerOps company (id ${existingCompanyId})`);

  const atsDetection = detectAtsFromUrlString(candidateUrl);
  if (atsDetection) {
    return { eligible: true, reason: `ATS-hosted apply URL detected (${atsDetection.sourceType})`, verifiedDomain: null, atsDetection };
  }
  return { eligible: true, reason: `Employer-owned apply/direct-employer domain: ${domain}`, verifiedDomain: domain, atsDetection: null };
}

export interface NewEmployerOnboardingResult {
  outcome: "created" | "linked_existing_organization" | "skipped_ineligible" | "skipped_conflict";
  companyId: number | null;
  organizationId: number | null;
  reason: string;
  proposalCreated: AtsSourceProposal | null;
}

/**
 * The ONLY function that creates a new company from a Built In (or any future external) observation.
 * Reuses createCompany/updateCompanyDomainIdentity/createProposalFromDiscoveryV2 verbatim. Never sets
 * companies.source_type to anything but 'career_link' and never sets ats_board_token directly — a
 * detected ATS becomes a PENDING_REVIEW proposal only (Phase 6: "never bypass review safety").
 */
export function onboardNewEmployerIfEligible(job: NormalizedExternalJob, match: CompanyMatchResult): NewEmployerOnboardingResult {
  const eligibility = evaluateNewEmployerEligibility(job, match);
  if (!eligibility.eligible) {
    return { outcome: "skipped_ineligible", companyId: null, organizationId: null, reason: eligibility.reason, proposalCreated: null };
  }

  // Phase 15 — reuse an existing organization (the Stage 12-discovered H1B-org-only case) instead of
  // creating a duplicate one. Domain evidence is checked first when available, but alias/name lookup
  // is always ALSO checked (not only as a fallback when no domain evidence exists) — a Built In
  // listing's apply URL frequently uses a domain CareerOps has never seen even when the employer
  // itself already has an H1B-derived organization row under its own registered legal name. Any
  // ambiguity found by either lookup (multiple distinct organizations) is treated as ineligible rather
  // than guessed. Known limitation, deliberately not addressed here: the alias lookup is still an
  // EXACT normalized-name match — it does not strip a leading article ("The Boeing Company" vs
  // "Boeing"), only trailing legal suffixes (Stage 12's normalizeForLegalNameMatch) — so a short
  // brand-style employer name will still create a new organization rather than reusing a full legal
  // name the H1B pipeline registered. Extending that normalization was judged out of scope here (it
  // did not change any outcome in this stage's own live shadow) and is called out in the final report.
  let existingOrgId: number | undefined;
  if (eligibility.verifiedDomain) {
    existingOrgId = findOrganizationIdByDomain(eligibility.verifiedDomain);
  }
  if (existingOrgId === undefined) {
    const orgIds = findOrganizationIdsByAliasName(job.employerName);
    if (orgIds.length > 1) {
      return { outcome: "skipped_ineligible", companyId: null, organizationId: null, reason: "Employer name matches multiple existing organizations — ambiguous", proposalCreated: null };
    }
    existingOrgId = orgIds[0];
  }

  let organizationHasNoCompany = false;
  if (existingOrgId !== undefined) {
    const linkedCompany = getCompanyForOrganization(existingOrgId);
    if (linkedCompany) {
      // The organization already has a company — this should already have matched via the normal
      // tiers upstream. Treat as a safety no-op rather than ever creating a duplicate.
      return { outcome: "skipped_conflict", companyId: linkedCompany.id, organizationId: existingOrgId, reason: "Existing organization already has a linked company", proposalCreated: null };
    }
    organizationHasNoCompany = true;
  }

  const company = createCompany({
    name: job.employerName.trim(),
    source_type: "career_link",
    organization_id: organizationHasNoCompany ? existingOrgId : undefined,
  });

  if (eligibility.verifiedDomain) {
    updateCompanyDomainIdentity(company.id, { verifiedDomain: eligibility.verifiedDomain, domainIdentityStatus: "VERIFIED" });
  }

  let proposalCreated: AtsSourceProposal | null = null;
  if (eligibility.atsDetection) {
    const refreshedCompany = getCompany(company.id) ?? company;
    proposalCreated = createProposalFromDiscoveryV2({
      companyId: company.id,
      currentSourceType: refreshedCompany.source_type,
      currentBoardToken: refreshedCompany.ats_board_token,
      candidate: {
        provider: eligibility.atsDetection.sourceType,
        boardToken: eligibility.atsDetection.atsBoardToken,
        canonicalUrl: eligibility.atsDetection.canonicalSourceUrl ?? null,
        // MEDIUM/NOT_ATTEMPTED is deliberate: this evidence is a single incidental apply URL, not an
        // independent board-level crawl/validation — never HIGH+VALIDATED_JOBS, so this can never be
        // auto-approved (isProposalApprovable requires exactly that combination). A human must
        // independently validate before this source is ever activated.
        confidence: "MEDIUM",
        validationStatus: "NOT_ATTEMPTED",
        recommendation: "NEEDS_SOURCE_REVIEW",
        evidenceTypes: ["built_in_apply_url"],
        evidenceUrls: [job.applyUrl ?? job.directEmployerUrl ?? job.listingUrl],
      },
    });
  }

  const organizationId = getOrganizationForCompany(company.id)?.id ?? existingOrgId ?? null;
  return {
    outcome: organizationHasNoCompany ? "linked_existing_organization" : "created",
    companyId: company.id,
    organizationId,
    reason: eligibility.reason,
    proposalCreated,
  };
}
