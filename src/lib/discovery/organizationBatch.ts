import pLimit from "p-limit";
import { createCompany, recordDiscoveryResult, updateCompanyDomainIdentity } from "@/db/queries/companies";
import { recordDiscoveryRun } from "@/db/queries/discoveryRuns";
import { nextOrganizationsForDiscovery, recordOrganizationDiscoveryState } from "@/db/queries/organizationDiscovery";
import { getCompanyForOrganization } from "@/db/queries/organizationRegistry";
import { discoverCompanySource, type DiscoveryResult } from "@/lib/ats/discovery";
import { discoverCompanySourceBrowser } from "@/lib/ats/discoveryBrowser";
import { resolveDomainIdentity } from "@/lib/companyIdentity/resolveDomain";
import {
  BROWSER_DISCOVERY_CONCURRENCY,
  HTTP_DISCOVERY_CONCURRENCY,
  type DiscoveryBatchSummary,
} from "@/lib/discovery/batch";
import type { DomainIdentityResult } from "@/types";

export interface OrganizationDiscoveryBatchOptions {
  batchSize?: number;
  httpConcurrency?: number;
  browserConcurrency?: number;
  useBrowserFallback?: boolean;
  allowPrivateNetworksForTests?: boolean;
}

function counters() {
  return {
    domainsVerified: 0, domainsAmbiguous: 0, domainsUnresolved: 0, domainsFailedTemporary: 0,
    careersPagesResolved: 0, atsVerified: 0, needsAdapter: 0, sourceUnresolved: 0,
    sourceFailedTemporary: 0,
  };
}

function isConnectorIdentityConflict(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: (?:companies\.(?:source_type|ats_board_token|career_page_url)|job_sources\.(?:source_url|provider|source_key))/.test(error.message);
}

function unresolvedInvalidUrl(error: unknown): DomainIdentityResult | null {
  if (!(error instanceof TypeError) || error.message !== "Invalid URL") return null;
  return {
    status: "UNRESOLVED",
    domain: null,
    method: "unresolved",
    confidence: null,
    evidence: ["deterministic_invalid_url_during_domain_resolution"],
    channelsChecked: {
      jsonLd: "not_checked",
      footer: "not_checked",
      aboutPage: "not_checked",
      termsPrivacyPage: "not_checked",
    },
    careersEvidence: null,
  };
}

export async function runOrganizationDiscoveryBatch(
  options: OrganizationDiscoveryBatchOptions = {}
): Promise<DiscoveryBatchSummary> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const organizations = nextOrganizationsForDiscovery(options.batchSize ?? 1000);
  const httpLimit = pLimit(options.httpConcurrency ?? HTTP_DISCOVERY_CONCURRENCY);
  const browserLimit = pLimit(options.browserConcurrency ?? BROWSER_DISCOVERY_CONCURRENCY);
  const totals = counters();
  const errors: string[] = [];

  await Promise.all(organizations.map((organization) => httpLimit(async () => {
    try {
      let domain: DomainIdentityResult;
      try {
        domain = await resolveDomainIdentity(organization.canonicalName, {
          allowPrivateNetworksForTests: options.allowPrivateNetworksForTests,
        });
      } catch (error) {
        const terminalInvalidUrl = unresolvedInvalidUrl(error);
        if (!terminalInvalidUrl) throw error;
        // A malformed third-party URL is deterministic for this evidence set. Checkpoint it as
        // unresolved instead of retrying the same organization forever in the final cohort.
        totals.domainsUnresolved++;
        recordOrganizationDiscoveryState({
          organizationId: organization.organizationId,
          resolvedCompanyId: null,
          domain: terminalInvalidUrl,
          source: null,
        });
        return;
      }
      let source = null;
      let companyId: number | null = null;

      if (domain.status === "VERIFIED" && domain.domain) {
        totals.domainsVerified++;
        source = await discoverCompanySource(`https://${domain.domain}/`, {
          allowPrivateNetworksForTests: options.allowPrivateNetworksForTests,
        });
        if (source.status === "UNRESOLVED" && options.useBrowserFallback) {
          source = await browserLimit(() => discoverCompanySourceBrowser(`https://${domain.domain}/`, {
            allowPrivateNetworksForTests: options.allowPrivateNetworksForTests,
          }));
        }
        if (source.status === "VERIFIED") {
          totals.atsVerified++;
          totals.careersPagesResolved++;
        } else if (source.status === "GENERIC_SUPPORTED") totals.careersPagesResolved++;
        else if (source.status === "NEEDS_ADAPTER") totals.needsAdapter++;
        else if (source.status === "FAILED_TEMPORARY") totals.sourceFailedTemporary++;
        else totals.sourceUnresolved++;

        let company = getCompanyForOrganization(organization.organizationId);
        companyId = company?.id ?? null;
        try {
          if (!company) {
            company = createCompany({
              name: organization.canonicalName,
              source_type: "career_link",
              career_page_url: `https://${domain.domain}/`,
              organization_id: organization.organizationId,
            });
            companyId = company.id;
          }
          updateCompanyDomainIdentity(company.id, { verifiedDomain: domain.domain, domainIdentityStatus: domain.status });
          recordDiscoveryResult(company.id, source);
        } catch (error) {
          if (!isConnectorIdentityConflict(error)) throw error;
          // The same company URL, provider identity, or source URL is already owned by another
          // canonical organization. Never force-merge or duplicate it during automation.
          // Checkpoint this organization as an explicit review item so it does not retry forever.
          if (source.status === "VERIFIED") {
            totals.atsVerified--;
            totals.careersPagesResolved--;
          } else if (source.status === "GENERIC_SUPPORTED") totals.careersPagesResolved--;
          else if (source.status === "NEEDS_ADAPTER") totals.needsAdapter--;
          else if (source.status === "FAILED_TEMPORARY") totals.sourceFailedTemporary--;
          else totals.sourceUnresolved--;
          totals.needsAdapter++;
          source = {
            status: "NEEDS_ADAPTER",
            sourceType: null,
            atsBoardToken: null,
            discoveredJobsUrl: source.discoveredJobsUrl,
            reason: `Connector identity conflicts with an existing organization: ${error instanceof Error ? error.message : String(error)}`,
            suspectedAts: "connector_identity_conflict",
          } satisfies DiscoveryResult;
          // Do not call the legacy-company sync again here: its existing source URL may itself be
          // the conflicting identity. The organization-level checkpoint below preserves the
          // review status, discovered URL, evidence, and optional resolved company ID without
          // mutating either side of the conflict.
        }
      } else if (domain.status === "AMBIGUOUS") totals.domainsAmbiguous++;
      else if (domain.status === "FAILED_TEMPORARY") totals.domainsFailedTemporary++;
      else totals.domainsUnresolved++;

      recordOrganizationDiscoveryState({
        organizationId: organization.organizationId,
        resolvedCompanyId: companyId,
        domain,
        source,
      });
    } catch (error) {
      errors.push(`${organization.canonicalName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  })));

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedMs;
  const summary: DiscoveryBatchSummary = {
    startedAt, finishedAt, durationMs, employersAttempted: organizations.length, ...totals, errors,
  };
  recordDiscoveryRun({
    startedAt, finishedAt, employersAttempted: organizations.length, ...totals, durationMs,
    errorSummary: errors.length ? errors.join("; ").slice(0, 2000) : null,
  });
  return summary;
}
