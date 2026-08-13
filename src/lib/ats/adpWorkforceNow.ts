import pLimit from "p-limit";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

export interface AdpWorkforceNowIdentity {
  cid: string;
  ccId: string;
  lang: string;
}

interface AdpNamedCode {
  stringValue?: string;
  nameCode?: { codeValue?: string };
}

interface AdpRequisition {
  itemID: string;
  requisitionTitle: string;
  postDate?: string;
  requisitionDescription?: string;
  clientRequisitionID?: string;
  workLevelCode?: { shortName?: string };
  requisitionLocations?: Array<{
    address?: {
      cityName?: string;
      countrySubdivisionLevel1?: { codeValue?: string };
      countryCode?: string;
      postalCode?: string;
    };
    nameCode?: { shortName?: string };
  }>;
  customFieldGroup?: { stringFields?: AdpNamedCode[] };
}

interface AdpListResponse {
  jobRequisitions: AdpRequisition[];
  meta?: { totalNumber?: number; startSequence?: number };
}

export interface FetchAdpWorkforceNowJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production uses the public Workforce Now career center. */
  hostOverride?: string;
  detailConcurrency?: number;
}

export function encodeAdpWorkforceNowToken(identity: AdpWorkforceNowIdentity): string {
  return `${identity.cid}|${identity.ccId}|${identity.lang}`;
}

export function decodeAdpWorkforceNowToken(token: string): AdpWorkforceNowIdentity {
  const [cid, ccId, lang, ...extra] = token.split("|");
  if (
    extra.length > 0 ||
    !cid ||
    !/^[a-f0-9-]{36}$/i.test(cid) ||
    !ccId ||
    !/^[a-z0-9_:.-]+$/i.test(ccId) ||
    !lang ||
    !/^[a-z]{2}_[A-Z]{2}$/.test(lang)
  ) {
    throw new Error("Invalid ADP Workforce Now token; expected cid|ccId|lang");
  }
  return { cid, ccId, lang };
}

export function canonicalAdpWorkforceNowUrl(token: string): string {
  const { cid, ccId, lang } = decodeAdpWorkforceNowToken(token);
  const params = new URLSearchParams({ cid, ccId, type: "JS", lang });
  return `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?${params}`;
}

function query(identity: AdpWorkforceNowIdentity, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    cid: identity.cid,
    ccId: identity.ccId,
    lang: identity.lang,
    locale: identity.lang,
    ...extra,
  }).toString();
}

function customString(job: AdpRequisition, code: string): string | null {
  const field = job.customFieldGroup?.stringFields?.find(
    (candidate) => candidate.nameCode?.codeValue === code
  );
  return field?.stringValue?.trim() || null;
}

function locationText(job: AdpRequisition): string | null {
  const locations = (job.requisitionLocations ?? []).flatMap((location) => {
    const shortName = location.nameCode?.shortName?.trim();
    if (shortName) return [shortName];
    const address = location.address;
    const parts = [
      address?.cityName,
      address?.countrySubdivisionLevel1?.codeValue,
      address?.countryCode,
    ].filter((value): value is string => Boolean(value?.trim()));
    return parts.length > 0 ? [parts.join(", ")] : [];
  });
  return locations.length > 0 ? locations.join("; ") : null;
}

function normalizedJob(
  identity: AdpWorkforceNowIdentity,
  boardUrl: string,
  listing: AdpRequisition,
  detail: AdpRequisition
): NormalizedJob {
  const html = detail.requisitionDescription?.trim() || null;
  const externalPostingId = customString(detail, "ExternalJobID") ?? customString(listing, "ExternalJobID");
  const url = new URL(boardUrl);
  url.searchParams.set("jobId", externalPostingId ?? detail.itemID);
  return {
    externalId: detail.itemID || listing.itemID,
    title: detail.requisitionTitle || listing.requisitionTitle,
    location: locationText(detail) ?? locationText(listing),
    department: customString(detail, "HomeDepartment") ?? customString(detail, "JobClass"),
    url: url.toString(),
    descriptionHtml: html,
    descriptionText: stripHtml(html),
    employmentType: detail.workLevelCode?.shortName ?? listing.workLevelCode?.shortName ?? null,
    workplaceType: null,
    salaryText: customString(detail, "SalaryRange") ?? customString(listing, "SalaryRange"),
    postedAt: detail.postDate ?? listing.postDate ?? null,
    raw: { identity, listing, detail },
  };
}

/** Public ADP Workforce Now career-center adapter. The browser-facing feed supports $top/$skip,
 * publishes totalNumber, and exposes a detail resource for every itemID. We exhaust pagination for
 * production scans, then apply CareerOps' explicit U.S. filter before persistence. */
export async function fetchAdpWorkforceNowJobs(
  token: string,
  options: FetchAdpWorkforceNowJobsOptions = {}
): Promise<NormalizedJob[]> {
  const {
    hostOverride,
    maxJobs,
    detailConcurrency = 4,
    usOnly,
    existingExternalIds,
    onLocationFiltered,
    ...retryOptions
  } = options;
  const identity = decodeAdpWorkforceNowToken(token);
  const origin = hostOverride ?? "https://workforcenow.adp.com";
  const basePath = "/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions";
  const pageSize = Math.min(20, Math.max(1, maxJobs ?? 20));
  const listings: AdpRequisition[] = [];
  const seenItemIds = new Set<string>();
  // ADP's public endpoint uses a one-based start sequence. Zero is a special default that can
  // return one fewer row, which then causes overlap if treated as a conventional zero-based offset.
  let skip = 1;
  let total = Number.POSITIVE_INFINITY;

  while (skip <= total) {
    const listUrl = `${origin}${basePath}?${query(identity, {
      "$top": String(pageSize),
      "$skip": String(skip),
    })}`;
    const response = await fetchWithRetry(listUrl, { headers: { Accept: "application/json" } }, retryOptions);
    const page = await parseJsonOrThrow<AdpListResponse>(response, listUrl);
    if (!Array.isArray(page.jobRequisitions)) throw new Error("ADP Workforce Now response has no jobRequisitions array");
    for (const listing of page.jobRequisitions) {
      if (!seenItemIds.has(listing.itemID)) {
        seenItemIds.add(listing.itemID);
        listings.push(listing);
      }
    }
    total = page.meta?.totalNumber ??
      (page.jobRequisitions.length < pageSize ? listings.length : Number.POSITIVE_INFINITY);
    if (maxJobs && listings.length >= maxJobs) break;
    if (page.jobRequisitions.length === 0) break;
    skip += page.jobRequisitions.length;
  }

  const selected = maxJobs ? listings.slice(0, maxJobs) : listings;
  const boardUrl = canonicalAdpWorkforceNowUrl(token);
  const limit = pLimit(Math.max(1, Math.min(Math.trunc(detailConcurrency), 8)));
  const jobs = await Promise.all(selected.map((listing) => limit(async () => {
    const detailUrl = `${origin}${basePath}/${encodeURIComponent(listing.itemID)}?${query(identity)}`;
    const response = await fetchWithRetry(detailUrl, { headers: { Accept: "application/json" } }, retryOptions);
    const detail = await parseJsonOrThrow<AdpRequisition>(response, detailUrl);
    return normalizedJob(identity, boardUrl, listing, detail);
  })));

  return filterJobsToUs(jobs, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
}
