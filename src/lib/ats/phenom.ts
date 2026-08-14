import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import { fetchWithRetry, type FetchWithRetryOptions } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

export interface PhenomIdentity {
  host: string;
  locale: string;
}

export interface FetchPhenomJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  originOverride?: string;
  allowPrivateNetworksForTests?: boolean;
  maxJobs?: number;
  headers?: Record<string, string>;
}

const HOST_PATTERN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const LOCALE_PATTERN = /^(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)?)?$/i;

export function parsePhenomToken(token: string): PhenomIdentity {
  const parts = token.trim().split("|");
  const host = parts[0]?.trim().toLowerCase();
  const locale = parts.length > 1 ? parts[1].trim() : "global/en";

  if (!host || !HOST_PATTERN.test(host)) {
    throw new Error(`Invalid Phenom host: ${host}`);
  }
  if (!LOCALE_PATTERN.test(locale)) {
    throw new Error(`Invalid Phenom locale: ${locale}`);
  }

  return { host, locale };
}

export function encodePhenomToken(identity: { host: string; locale?: string }): string {
  const host = identity.host.trim().toLowerCase();
  const locale = identity.locale !== undefined ? identity.locale.trim() : "global/en";
  if (!HOST_PATTERN.test(host)) throw new Error(`Invalid Phenom host: ${host}`);
  if (!LOCALE_PATTERN.test(locale)) throw new Error(`Invalid Phenom locale: ${locale}`);
  return locale ? `${host}|${locale}` : `${host}|`;
}

export function normalizePhenomToken(token: string): string {
  const parsed = parsePhenomToken(token);
  return encodePhenomToken(parsed);
}

export function canonicalPhenomUrl(token: string): string {
  const { host, locale } = parsePhenomToken(token);
  return locale ? `https://${host}/${locale}/search-results` : `https://${host}/search-results`;
}

interface PhenomRawPosting {
  jobId?: string;
  jobSeqNo: string;
  title: string;
  location?: string;
  city?: string;
  state?: string;
  country?: string;
  postedDate?: string;
  applyUrl?: string;
  category?: string;
  type?: string;
  descriptionTeaser?: string;
}

export function extractPhAppDdo(html: string): Record<string, unknown> {
  // Variant 1: phApp.ddo = { ... }; or window.phApp.ddo = { ... };
  const ddoDirectMatch = html.match(/(?:window\.)?phApp\.ddo\s*=\s*(\{[\s\S]*?\});(?:\s*(?:window|phApp|document|<\/script>)|$)/i);
  if (ddoDirectMatch && ddoDirectMatch[1]) {
    try {
      return JSON.parse(ddoDirectMatch[1]);
    } catch {
      // continue to next extraction method
    }
  }

  // Variant 2: window.phApp = { ddo: { ... } };
  const phAppObjMatch = html.match(/(?:window\.)?phApp\s*=\s*\{\s*ddo:\s*(\{[\s\S]*?\})\s*\};/i);
  if (phAppObjMatch && phAppObjMatch[1]) {
    try {
      return JSON.parse(phAppObjMatch[1]);
    } catch {
      // continue to next extraction method
    }
  }

  // Variant 3: window.phData = { ... };
  const phDataMatch = html.match(/(?:window\.)?phData\s*=\s*(\{[\s\S]*?\});/i);
  if (phDataMatch && phDataMatch[1]) {
    try {
      return JSON.parse(phDataMatch[1]);
    } catch {
      // continue
    }
  }

  // Variant 4: Find any phApp.ddo = { ... } by searching index of "phApp.ddo" and extracting balanced JSON object
  const marker = "phApp.ddo";
  const markerIdx = html.indexOf(marker);
  if (markerIdx !== -1) {
    const eqIdx = html.indexOf("=", markerIdx + marker.length);
    if (eqIdx !== -1) {
      const openBrace = html.indexOf("{", eqIdx);
      if (openBrace !== -1) {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = openBrace; i < html.length; i++) {
          const ch = html[i];
          if (escape) {
            escape = false;
            continue;
          }
          if (ch === "\\") {
            escape = true;
            continue;
          }
          if (ch === '"') {
            inString = !inString;
            continue;
          }
          if (!inString) {
            if (ch === "{") depth++;
            else if (ch === "}") {
              depth--;
              if (depth === 0) {
                const jsonStr = html.slice(openBrace, i + 1);
                try {
                  return JSON.parse(jsonStr);
                } catch {
                  break;
                }
              }
            }
          }
        }
      }
    }
  }

  throw new Error("Phenom response did not contain a valid phApp.ddo object");
}

export function parsePhenomListingPage(ddo: Record<string, unknown>): {
  totalHits: number;
  jobs: PhenomRawPosting[];
} {
  const eagerLoad = ddo.eagerLoadRefineSearch as Record<string, unknown> | undefined;
  const refineSearch = ddo.refineSearch as Record<string, unknown> | undefined;
  const dataObj = (eagerLoad?.data ?? refineSearch?.data ?? ddo.data) as Record<string, unknown> | undefined;

  const rawTotalHits = eagerLoad?.totalHits ?? (refineSearch?.data as Record<string, unknown> | undefined)?.totalHits ?? ddo.totalHits ?? dataObj?.totalHits;
  if (typeof rawTotalHits !== "number" || !Number.isInteger(rawTotalHits) || rawTotalHits < 0) {
    throw new Error("Phenom response missing valid numeric totalHits");
  }

  const rawJobs = (dataObj?.jobs ?? []) as unknown[];
  if (!Array.isArray(rawJobs)) {
    throw new Error("Phenom response missing jobs array");
  }

  const jobs: PhenomRawPosting[] = [];
  for (const item of rawJobs) {
    if (!item || typeof item !== "object") continue;
    const j = item as Record<string, unknown>;
    const jobSeqNo = String(j.jobSeqNo ?? j.jobId ?? "").trim();
    const title = String(j.title ?? "").trim();
    if (!jobSeqNo || !title) continue;

    jobs.push({
      jobId: j.jobId ? String(j.jobId).trim() : undefined,
      jobSeqNo,
      title,
      location: j.location ? String(j.location).trim() : undefined,
      city: j.city ? String(j.city).trim() : undefined,
      state: j.state ? String(j.state).trim() : undefined,
      country: j.country ? String(j.country).trim() : undefined,
      postedDate: j.postedDate ? String(j.postedDate).trim() : undefined,
      applyUrl: j.applyUrl ? String(j.applyUrl).trim() : undefined,
      category: j.category ? String(j.category).trim() : undefined,
      type: j.type ? String(j.type).trim() : undefined,
      descriptionTeaser: j.descriptionTeaser ? String(j.descriptionTeaser).trim() : undefined,
    });
  }

  return { totalHits: rawTotalHits, jobs };
}

export function parsePhenomJobDetail(ddo: Record<string, unknown>): {
  description: string;
  title?: string;
  location?: string;
  city?: string;
  state?: string;
  country?: string;
  postedDate?: string;
  applyUrl?: string;
} {
  const jobDetail = ddo.jobDetail as Record<string, unknown> | undefined;
  const data = (jobDetail?.data ?? ddo.data) as Record<string, unknown> | undefined;
  const jd = (data?.job ?? data) as Record<string, unknown> | undefined;

  if (!jd || typeof jd !== "object") {
    throw new Error("Phenom detail page missing jobDetail data object");
  }

  const rawDescription = String(jd.description ?? jd.descriptionTeaser ?? "").trim();
  if (!rawDescription) {
    throw new Error("Phenom detail page missing description");
  }

  return {
    description: rawDescription,
    title: jd.title ? String(jd.title).trim() : undefined,
    location: jd.location ? String(jd.location).trim() : (jd.cityStateCountry ? String(jd.cityStateCountry).trim() : undefined),
    city: jd.city ? String(jd.city).trim() : undefined,
    state: jd.state ? String(jd.state).trim() : undefined,
    country: jd.country ? String(jd.country).trim() : undefined,
    postedDate: jd.postedDate ? String(jd.postedDate).trim() : undefined,
    applyUrl: jd.applyUrl ? String(jd.applyUrl).trim() : undefined,
  };
}

export async function fetchPhenomJobs(
  token: string,
  options: FetchPhenomJobsOptions = {}
): Promise<NormalizedJob[]> {
  const identity = parsePhenomToken(token);
  const origin = options.originOverride ?? `https://${identity.host}`;
  const baseUrl = identity.locale ? `${origin}/${identity.locale}` : origin;

  const allPostings: PhenomRawPosting[] = [];
  const seenRequisitionIds = new Set<string>();
  let authoritativePublicJobCount: number | null = null;
  let from = 0;
  const maxPages = 500;
  let pageIndex = 0;

  while (pageIndex < maxPages) {
    pageIndex++;
    const searchUrl = `${baseUrl}/search-results?from=${from}&s=1`;
    const res = await fetchWithRetry(searchUrl, {
      ...options,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...options.headers,
      },
    });

    if (res.status !== 200) {
      throw new Error(`Phenom search-results returned HTTP ${res.status}`);
    }

    const html = await res.text();
    const ddo = extractPhAppDdo(html);
    const { totalHits, jobs } = parsePhenomListingPage(ddo);

    if (authoritativePublicJobCount === null) {
      authoritativePublicJobCount = totalHits;
    } else if (totalHits !== authoritativePublicJobCount) {
      throw new Error(`Phenom totalCount mutated during pagination: initial ${authoritativePublicJobCount}, page ${pageIndex} returned ${totalHits}`);
    }

    if (authoritativePublicJobCount === 0) {
      break;
    }

    if (jobs.length === 0 && allPostings.length < authoritativePublicJobCount) {
      console.warn(`Phenom pagination returned empty page ${pageIndex} before reaching authoritative totalHits ${authoritativePublicJobCount}`);
      break;
    }

    const pageSeen = new Set<string>();
    for (const posting of jobs) {
      const idKey = posting.jobSeqNo;
      if (pageSeen.has(idKey)) {
        throw new Error(`Duplicate requisition ID detected within page in Phenom snapshot: ${idKey}`);
      }
      pageSeen.add(idKey);

      if (seenRequisitionIds.has(idKey)) {
        continue;
      }
      seenRequisitionIds.add(idKey);
      allPostings.push(posting);
    }

    if (allPostings.length > authoritativePublicJobCount) {
      throw new Error(`Phenom collected postings (${allPostings.length}) exceeded authoritative totalHits (${authoritativePublicJobCount})`);
    }

    if (allPostings.length >= authoritativePublicJobCount) {
      break;
    }

    if (options.maxJobs !== undefined) {
      const usCount = allPostings.filter((p) => {
        const loc = p.location || [p.city, p.state, p.country].filter(Boolean).join(", ");
        return classifyJobLocation(loc) === "US";
      }).length;
      if (options.usOnly && usCount >= options.maxJobs) {
        break;
      }
      if (!options.usOnly && allPostings.length >= options.maxJobs) {
        break;
      }
      if (allPostings.length >= options.maxJobs * 5) {
        break;
      }
    }

    from += jobs.length;
  }

  if (options.maxJobs === undefined && authoritativePublicJobCount !== null && allPostings.length > authoritativePublicJobCount) {
    throw new Error(`Phenom snapshot posting count mismatch: expected ${authoritativePublicJobCount}, collected ${allPostings.length}`);
  }

  // Bounded sample details for persistence / validation
  const maxToFetch = options.maxJobs ? Math.min(options.maxJobs * 3, allPostings.length) : allPostings.length;
  const jobsToProcess = allPostings.slice(0, maxToFetch);

  const normalizedJobs: NormalizedJob[] = [];

  for (const posting of jobsToProcess) {
    let description = posting.descriptionTeaser ?? "";
    let finalLocation = posting.location || [posting.city, posting.state, posting.country].filter(Boolean).join(", ");
    let finalPostedDate = posting.postedDate;
    let finalApplyUrl = posting.applyUrl;

    const detailUrl = `${baseUrl}/job/${posting.jobSeqNo}`;

    try {
      const dRes = await fetchWithRetry(detailUrl, {
        ...options,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...options.headers,
        },
      });

      if (dRes.status === 200) {
        const dHtml = await dRes.text();
        try {
          const dDdo = extractPhAppDdo(dHtml);
          const detail = parsePhenomJobDetail(dDdo);
          if (detail.description) description = detail.description;
          if (detail.location) finalLocation = detail.location;
          if (detail.postedDate) finalPostedDate = detail.postedDate;
          if (detail.applyUrl) finalApplyUrl = detail.applyUrl;
        } catch {
          // If phApp.ddo is not on detail page, fallback to HTML teaser if available
        }
      }
    } catch {
      // Fallback to teaser if detail fetch encounters transient error
    }

    const jobUrl = options.originOverride
      ? (identity.locale ? `https://${identity.host}/${identity.locale}/job/${posting.jobSeqNo}` : `https://${identity.host}/job/${posting.jobSeqNo}`)
      : (finalApplyUrl || detailUrl);

    normalizedJobs.push({
      externalId: posting.jobId || posting.jobSeqNo,
      title: posting.title,
      location: finalLocation || null,
      department: posting.category || null,
      url: jobUrl,
      descriptionHtml: description || null,
      descriptionText: stripHtml(description),
      employmentType: posting.type || null,
      workplaceType: null,
      salaryText: null,
      postedAt: finalPostedDate ? new Date(finalPostedDate).toISOString() : null,
      raw: posting,
    });
  }

  return filterJobsToUs(normalizedJobs, options, options.maxJobs);
}
