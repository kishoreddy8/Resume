import pLimit from "p-limit";
import { createCompany, getCompanyByName, recordDiscoveryResult, updateCompanyDomainIdentity } from "@/db/queries/companies";
import { recordDiscoveryRun } from "@/db/queries/discoveryRuns";
import { recordEmployerIdentityResolution } from "@/db/queries/employerIdentityResolutions";
import { discoverCompanySource } from "@/lib/ats/discovery";
import { discoverCompanySourceBrowser } from "@/lib/ats/discoveryBrowser";
import { resolveDomainIdentity } from "@/lib/companyIdentity/resolveDomain";
import { nextPriorityEmployers } from "@/lib/discovery/priority";
import type { CompanyResolutionStatus, SourceType } from "@/types";

/**
 * Bounded batch H1B employer discovery — see the approved plan's §17/§19/§22. Batch SIZE and
 * CONCURRENCY are independent, deliberately: a batch may include up to DISCOVERY_BATCH_SIZE
 * employers while only a much smaller number of network operations run simultaneously.
 *
 * No Redis/Kafka/external queue — a single Node process iterating a DB-driven priority list
 * (src/lib/discovery/priority.ts) is sufficient at this scale. Resumable and idempotent by
 * construction: every outcome is persisted per-employer as soon as it's known (recordEmployer
 * IdentityResolution/recordDiscoveryResult), and nextPriorityEmployers itself excludes anything
 * already VERIFIED or not yet retry-eligible — a killed/restarted run simply picks up wherever the
 * priority query says to continue, with no separate checkpoint file needed. One employer's failure
 * (caught per-item) never aborts the batch.
 *
 * KNOWN SIMPLIFICATION (documented honestly, not silently done): WIKIDATA_CONCURRENCY and
 * HTTP_DISCOVERY_CONCURRENCY are enforced via the SAME per-employer concurrency gate in this
 * implementation, since each employer's resolution makes at most one Wikidata call as part of an
 * otherwise HTTP-bound pipeline (resolveDomainIdentity itself has no separate concurrency knob for
 * its internal Wikidata call). A dedicated Wikidata-only limiter injected into resolveDomainIdentity
 * would allow finer-grained control if Wikidata's real-world behavior ever proves tighter than
 * general HTTP concurrency in practice — not built here since HTTP_DISCOVERY_CONCURRENCY (default
 * 3) already sits comfortably under Wikidata's documented 5-parallel-per-IP cap.
 */

export const DISCOVERY_BATCH_SIZE = 100;
export const HTTP_DISCOVERY_CONCURRENCY = 3;
export const BROWSER_DISCOVERY_CONCURRENCY = 1;
/** See the KNOWN SIMPLIFICATION note above — currently just an alias of HTTP_DISCOVERY_CONCURRENCY,
 *  kept as its own named export so call sites and future refactors can treat it independently. */
export const WIKIDATA_CONCURRENCY = HTTP_DISCOVERY_CONCURRENCY;

export interface DiscoveryBatchOptions {
  batchSize?: number;
  httpConcurrency?: number;
  browserConcurrency?: number;
  /** Whether to attempt Tier 3 (browser) careers/ATS discovery when Tier 1/2 resolves UNRESOLVED
   *  for an already-VERIFIED domain. Default true; set false to keep a batch HTTP-only (cheaper,
   *  faster, no Playwright launches) when browser fallback isn't needed for a given run. */
  useBrowserFallback?: boolean;
  /** Test-only — passed straight through to every safeFetch/browser call this batch makes. */
  allowPrivateNetworksForTests?: boolean;
}

export interface DiscoveryBatchSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  employersAttempted: number;
  domainsVerified: number;
  domainsAmbiguous: number;
  domainsUnresolved: number;
  domainsFailedTemporary: number;
  careersPagesResolved: number;
  atsVerified: number;
  needsAdapter: number;
  sourceUnresolved: number;
  sourceFailedTemporary: number;
  errors: string[];
}

function emptyCounters() {
  return {
    domainsVerified: 0,
    domainsAmbiguous: 0,
    domainsUnresolved: 0,
    domainsFailedTemporary: 0,
    careersPagesResolved: 0,
    atsVerified: 0,
    needsAdapter: 0,
    sourceUnresolved: 0,
    sourceFailedTemporary: 0,
  };
}

export async function runDiscoveryBatch(options: DiscoveryBatchOptions = {}): Promise<DiscoveryBatchSummary> {
  const batchSize = options.batchSize ?? DISCOVERY_BATCH_SIZE;
  const httpConcurrency = options.httpConcurrency ?? HTTP_DISCOVERY_CONCURRENCY;
  const browserConcurrency = options.browserConcurrency ?? BROWSER_DISCOVERY_CONCURRENCY;
  const useBrowserFallback = options.useBrowserFallback ?? true;
  const allowPrivateNetworksForTests = options.allowPrivateNetworksForTests;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const employers = nextPriorityEmployers(batchSize);

  const httpLimit = pLimit(httpConcurrency);
  const browserLimit = pLimit(browserConcurrency);
  const counters = emptyCounters();
  const errors: string[] = [];

  await Promise.all(
    employers.map((sponsor) =>
      httpLimit(async () => {
        try {
          const domainResult = await resolveDomainIdentity(sponsor.employer_name_raw, { allowPrivateNetworksForTests });

          let resolvedCompanyId: number | null = null;

          if (domainResult.status === "VERIFIED" && domainResult.domain) {
            counters.domainsVerified++;

            let source = await discoverCompanySource(`https://${domainResult.domain}/`, { allowPrivateNetworksForTests });
            if (source.status === "UNRESOLVED" && useBrowserFallback) {
              source = await browserLimit(() => discoverCompanySourceBrowser(`https://${domainResult.domain}/`, { allowPrivateNetworksForTests }));
            }
            tallySourceResult(counters, source.status);

            let company = getCompanyByName(sponsor.employer_name_raw);
            if (!company) {
              company = createCompany({
                name: sponsor.employer_name_raw,
                source_type: "career_link" as SourceType,
                career_page_url: `https://${domainResult.domain}/`,
              });
            }
            updateCompanyDomainIdentity(company.id, { verifiedDomain: domainResult.domain, domainIdentityStatus: domainResult.status });
            recordDiscoveryResult(company.id, source);
            resolvedCompanyId = company.id;
          } else if (domainResult.status === "AMBIGUOUS") {
            counters.domainsAmbiguous++;
          } else if (domainResult.status === "FAILED_TEMPORARY") {
            counters.domainsFailedTemporary++;
          } else {
            counters.domainsUnresolved++;
          }

          recordEmployerIdentityResolution(sponsor.id, domainResult, resolvedCompanyId);
        } catch (err) {
          // One employer's failure must never abort the batch — caught, recorded, continue.
          errors.push(`${sponsor.employer_name_raw}: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
    )
  );

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - t0;
  const summary: DiscoveryBatchSummary = { startedAt, finishedAt, durationMs, employersAttempted: employers.length, ...counters, errors };

  recordDiscoveryRun({
    startedAt,
    finishedAt,
    employersAttempted: summary.employersAttempted,
    domainsVerified: counters.domainsVerified,
    domainsAmbiguous: counters.domainsAmbiguous,
    domainsUnresolved: counters.domainsUnresolved,
    domainsFailedTemporary: counters.domainsFailedTemporary,
    careersPagesResolved: counters.careersPagesResolved,
    atsVerified: counters.atsVerified,
    needsAdapter: counters.needsAdapter,
    sourceUnresolved: counters.sourceUnresolved,
    sourceFailedTemporary: counters.sourceFailedTemporary,
    durationMs,
    errorSummary: errors.length > 0 ? errors.join("; ").slice(0, 2000) : null,
  });

  return summary;
}

function tallySourceResult(counters: ReturnType<typeof emptyCounters>, status: CompanyResolutionStatus): void {
  if (status === "VERIFIED") counters.atsVerified++;
  else if (status === "NEEDS_ADAPTER") counters.needsAdapter++;
  else if (status === "UNRESOLVED") counters.sourceUnresolved++;
  else if (status === "FAILED_TEMPORARY") counters.sourceFailedTemporary++;
  if (status === "VERIFIED" || status === "GENERIC_SUPPORTED") counters.careersPagesResolved++;
}
