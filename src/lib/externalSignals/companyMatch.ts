import { findCompanyIdByVerifiedDomain, findCompanyIdsByAliasName } from "@/db/queries/organizationRegistry";
import { normalizeOrganizationDomain } from "@/db/organizationRegistryCore";
import type { CompanyMatchResult, NormalizedExternalJob } from "./types";

/**
 * Phase 5/6 — resolve an external listing's employer to an existing CareerOps company, using the
 * SAME identity primitives the rest of the registry already writes through (organization_domains,
 * organization_aliases — see companyMatch.test.ts's "Microsoft Corp." style cases). Priority, per the
 * task spec: (1) verified employer domain, (2) direct employer/apply URL domain, (3) organization
 * aliases, (4) normalized company name — (3) and (4) collapse into one query here because
 * syncLegacyCompanyToOrganizationRegistry already writes every company's own name as a primary alias
 * row, so there is no separate "raw name" table to also check.
 *
 * Never auto-resolves an ambiguous match: >1 alias hit is reported AMBIGUOUS, not guessed.
 */
export function matchCompanyForObservation(job: NormalizedExternalJob): CompanyMatchResult {
  // Tier 1: verified employer domain, from whichever field looks like an employer's own domain
  // rather than an aggregator's (directEmployerUrl first, since employerName never carries a URL).
  for (const candidateUrl of [job.directEmployerUrl, job.applyUrl]) {
    if (!candidateUrl) continue;
    const domain = safeDomainFromUrl(candidateUrl);
    if (!domain) continue;
    const companyId = findCompanyIdByVerifiedDomain(domain);
    if (companyId) return { companyId, confidence: "DOMAIN", reason: `Verified domain match on ${domain}` };
  }

  // Tier 3/4: organization alias (covers both a distinct legal alias and the company's own primary
  // name, since both live in organization_aliases).
  const employerName = job.employerName.trim();
  if (!employerName) return { companyId: null, confidence: "UNMATCHED", reason: "No employer name on the listing" };

  const aliasMatches = findCompanyIdsByAliasName(employerName);
  if (aliasMatches.length === 1) {
    return { companyId: aliasMatches[0], confidence: "ALIAS", reason: `Alias/name match on "${employerName}"` };
  }
  if (aliasMatches.length > 1) {
    return { companyId: null, confidence: "AMBIGUOUS", reason: `"${employerName}" matches ${aliasMatches.length} distinct companies — not auto-resolved` };
  }

  return { companyId: null, confidence: "UNMATCHED", reason: `No CareerOps company matches "${employerName}"` };
}

function safeDomainFromUrl(url: string): string | null {
  try {
    const normalized = normalizeOrganizationDomain(url);
    return normalized || null;
  } catch {
    return null;
  }
}
