import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface AdpRmIdentity { slug: string; siteId: string; orgoid: string; clientId: string }
interface AdpRmSite extends Partial<AdpRmIdentity> {
  id?: string; domain?: string; orgoid?: string; isiClientId?: string; clientName?: string;
  active?: boolean; isMyJobsEnabled?: boolean; myJobsToken?: string;
}
interface AdpRmJob {
  reqId?: string; clientRequisitionID?: string; jobTitle?: string; publishedJobTitle?: string;
  jobDescription?: string; jobQualifications?: string; workLevelCode?: string; postingDate?: string;
  careerSiteDomains?: string[];
  requisitionLocations?: Array<{ nameCode?: { longName?: string }; address?: {
    cityName?: string; postalCode?: string; country?: { codeValue?: string; longName?: string };
    countrySubdivisionLevel1?: { codeValue?: string; longName?: string };
  } }>;
}
interface AdpRmPage { count?: number; jobRequisitions?: AdpRmJob[] }
export interface FetchAdpRmJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number; myJobsOriginOverride?: string; apiOriginOverride?: string;
}

export function decodeAdpRmToken(value: string): AdpRmIdentity {
  const [slug, siteId, orgoid, clientId, ...extra] = value.trim().split("|");
  if (extra.length || !/^[a-z0-9-]+$/.test(slug ?? "") || !/^[a-f0-9-]{36}$/i.test(siteId ?? "")
    || !/^[A-Z0-9]{8,32}$/.test(orgoid ?? "") || !/^[a-z0-9_-]{2,64}$/i.test(clientId ?? "")) {
    throw new Error("Invalid ADP Recruiting Management token");
  }
  return { slug: slug.toLowerCase(), siteId: siteId.toLowerCase(), orgoid, clientId };
}

export function normalizeAdpRmToken(value: string): string {
  const i = decodeAdpRmToken(value);
  return `${i.slug}|${i.siteId}|${i.orgoid}|${i.clientId}`;
}

export function canonicalAdpRmUrl(value: string): string {
  const identity = decodeAdpRmToken(normalizeAdpRmToken(value));
  const url = new URL(`https://myjobs.adp.com/${identity.slug}`);
  url.searchParams.set("siteId", identity.siteId);
  url.searchParams.set("orgoid", identity.orgoid);
  url.searchParams.set("clientId", identity.clientId);
  return url.toString();
}

function locationText(job: AdpRmJob): string {
  const values = (job.requisitionLocations ?? []).map((location) => {
    const address = location.address;
    return [address?.cityName, address?.countrySubdivisionLevel1?.codeValue,
      address?.country?.codeValue].filter(Boolean).join(", ") || location.nameCode?.longName || "";
  }).filter(Boolean);
  return values.join("; ") || "Unknown";
}

function normalizeJob(job: AdpRmJob, identity: AdpRmIdentity): NormalizedJob {
  const externalId = job.reqId?.trim();
  const title = (job.publishedJobTitle ?? job.jobTitle)?.trim();
  if (!externalId || !/^\d+$/.test(externalId) || !title
    || !job.careerSiteDomains?.some((domain) => domain.toLowerCase() === identity.slug)) {
    throw new Error("ADP Recruiting Management listing has invalid tenant/job identity");
  }
  const descriptionHtml = [job.jobDescription, job.jobQualifications].filter(Boolean).join("\n") || null;
  const descriptionText = descriptionHtml ? stripHtml(descriptionHtml) : "";
  const url = new URL(canonicalAdpRmUrl(normalizeAdpRmToken(`${identity.slug}|${identity.siteId}|${identity.orgoid}|${identity.clientId}`)));
  url.pathname = `/${identity.slug}/cx/job-details`;
  url.searchParams.set("reqId", externalId);
  return {
    externalId,
    title,
    location: locationText(job),
    department: null,
    url: url.toString(),
    descriptionHtml,
    descriptionText,
    employmentType: job.workLevelCode?.trim() || null,
    workplaceType: /\bremote\b/i.test(locationText(job)) ? "Remote" : null,
    salaryText: null,
    postedAt: job.postingDate ?? null,
    raw: { identity, listing: job },
  };
}

/** Legacy ADP Recruiting Management boards now redirect to MyJobs. The exact MyJobs tenant
 * configuration supplies a short-lived public token; the corresponding public feed includes
 * complete descriptions and a count, so every page is exhausted before the shared U.S. gate. */
export async function fetchAdpRmJobs(tokenValue: string, options: FetchAdpRmJobsOptions = {}): Promise<NormalizedJob[]> {
  const trimmed = tokenValue.trim();
  const slug = trimmed.includes("|") ? decodeAdpRmToken(normalizeAdpRmToken(trimmed)).slug : trimmed.toLowerCase();
  const { maxJobs, myJobsOriginOverride = "https://myjobs.adp.com", apiOriginOverride = "https://my.adp.com",
    usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const siteUrl = `${myJobsOriginOverride}/public/staffing/v1/career-site/${slug}`;
  const site = await parseJsonOrThrow<AdpRmSite>(await fetchWithRetry(siteUrl,
    { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }, retryOptions), siteUrl);
  if (site.domain?.toLowerCase() !== slug || !site.id || !site.orgoid || !site.isiClientId
    || site.active !== true || site.isMyJobsEnabled !== true || !site.myJobsToken) {
    throw new Error("ADP Recruiting Management tenant configuration identity mismatch");
  }
  const identity: AdpRmIdentity = {
    slug: site.domain.toLowerCase(),
    siteId: site.id.toLowerCase(),
    orgoid: site.orgoid,
    clientId: site.isiClientId,
  };
  const pageSize = 100; const listings: AdpRmJob[] = []; const seen = new Set<string>();
  let skip = 0; let reportedTotal: number | null = null;
  while (reportedTotal === null || skip < reportedTotal) {
    const url = new URL(`${apiOriginOverride}/myadp_prefix/mycareer/public/staffing/v1/job-requisitions/apply-custom-filters`);
    url.searchParams.set("$select", "reqId,jobTitle,publishedJobTitle,type,jobDescription,jobQualifications,workLocations,workLevelCode,clientRequisitionID,postingDate,requisitionLocations,careerSiteDomains");
    url.searchParams.set("$top", String(pageSize)); url.searchParams.set("$skip", String(skip));
    const response = await fetchWithRetry(url.toString(), { headers: { Accept: "application/json",
      "Accept-Language": "en-US", myjobstoken: site.myJobsToken, rolecode: "manager",
      Origin: myJobsOriginOverride, Referer: `${myJobsOriginOverride}/` } }, retryOptions);
    const page = await parseJsonOrThrow<AdpRmPage>(response, url.toString());
    const rows = page.jobRequisitions;
    if (!Array.isArray(rows) || !Number.isInteger(page.count) || (page.count ?? -1) < 0
      || (reportedTotal !== null && page.count !== reportedTotal) || rows.length > pageSize) {
      throw new Error("ADP Recruiting Management returned invalid or shifted pagination");
    }
    reportedTotal = page.count!;
    for (const row of rows) {
      const id = row.reqId?.trim() ?? "";
      if (!id || seen.has(id)) throw new Error(`ADP Recruiting Management duplicate/invalid job ${id}`);
      seen.add(id); listings.push(row);
    }
    if (rows.length === 0) break;
    skip += rows.length;
  }
  if (listings.length !== reportedTotal) throw new Error("ADP Recruiting Management traversal did not match count");
  return filterJobsToUs(listings.map((job) => normalizeJob(job, identity)),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
}
