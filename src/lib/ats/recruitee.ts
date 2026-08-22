import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

export interface FetchRecruiteeJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production is always the tenant's Recruitee host. */
  hostOverride?: string;
}

export function normalizeRecruiteeTenant(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(tenant) || tenant === "www" || tenant === "api") {
    throw new Error("Invalid Recruitee tenant");
  }
  return tenant;
}

export function canonicalRecruiteeUrl(tenant: string): string {
  return `https://${normalizeRecruiteeTenant(tenant)}.recruitee.com/`;
}

function xmlValue(fragment: string, tag: string): string | null {
  const match = fragment.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return null;
  const value = match[1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").trim();
  return decodeHtmlEntities(value);
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function locationText(fragment: string): string | null {
  const locations = [...fragment.matchAll(/<location>([\s\S]*?)<\/location>/gi)].map((entry) => {
    const parts = [xmlValue(entry[1], "city"), xmlValue(entry[1], "state"), xmlValue(entry[1], "country")]
      .filter((value): value is string => Boolean(value?.trim()));
    return parts.join(", ");
  }).filter(Boolean);
  if (locations.length > 0) return [...new Set(locations)].join("; ");
  const fallback = [xmlValue(fragment, "city"), xmlValue(fragment, "country")]
    .filter((value): value is string => Boolean(value?.trim()));
  if (fallback.length > 0) return fallback.join(", ");
  return xmlValue(fragment, "location");
}

export function parseRecruiteeFeed(xml: string, tenant: string, origin: string): NormalizedJob[] {
  if (!/^\s*<\?xml\b/i.test(xml) || !/<offers>[\s\S]*<\/offers>\s*$/i.test(xml)) {
    throw new Error("Recruitee response is not its public XML offers feed");
  }
  const jobs: NormalizedJob[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<offer>([\s\S]*?)<\/offer>/gi)) {
    const offer = match[1];
    const id = xmlValue(offer, "id");
    const title = xmlValue(offer, "title");
    const careersUrl = xmlValue(offer, "careers_url");
    const description = xmlValue(offer, "description");
    const requirements = xmlValue(offer, "requirements");
    const descriptionHtml = [description, requirements].filter(Boolean).join("\n");
    const location = locationText(offer);
    if (!id || !/^\d+$/.test(id) || !title || !careersUrl || !location) {
      throw new Error("Recruitee offer is missing a stable ID, title, canonical URL, or location");
    }
    if (seen.has(id)) throw new Error("Recruitee feed contains a duplicate offer ID");
    seen.add(id);
    let canonicalUrl: URL;
    try {
      canonicalUrl = new URL(careersUrl);
    } catch {
      throw new Error("Recruitee offer has an invalid canonical URL");
    }
    if (canonicalUrl.hostname !== `${tenant}.recruitee.com`) {
      throw new Error("Recruitee offer URL does not match the requested tenant");
    }
    const descriptionText = stripHtml(descriptionHtml);
    jobs.push({
      externalId: id,
      title: stripHtml(title),
      location,
      department: xmlValue(offer, "department"),
      url: canonicalUrl.toString(),
      descriptionHtml: descriptionHtml || null,
      descriptionText,
      employmentType: xmlValue(offer, "employment_type_code"),
      workplaceType: xmlValue(offer, "remote") === "true"
        ? "Remote"
        : xmlValue(offer, "hybrid") === "true"
          ? "Hybrid"
          : xmlValue(offer, "on_site") === "true"
            ? "On-site"
            : null,
      salaryText: extractSalaryText(descriptionText),
      postedAt: parseDate(xmlValue(offer, "published_at")),
      raw: { slug: xmlValue(offer, "slug"), company: xmlValue(offer, "company_name"), origin },
    });
  }
  return jobs;
}

/** Recruitee's official public XML feed is a complete, non-paginated snapshot of published jobs.
 * It is explicitly excluded from the provider's forthcoming Careers API token requirement. */
export async function fetchRecruiteeJobs(
  tenantValue: string,
  options: FetchRecruiteeJobsOptions = {}
): Promise<NormalizedJob[]> {
  const tenant = normalizeRecruiteeTenant(tenantValue);
  const { hostOverride, maxJobs, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (hostOverride ?? `https://${tenant}.recruitee.com`).replace(/\/$/, "");
  const response = await fetchWithRetry(`${origin}/api/feeds/offers.xml`, {
    headers: { Accept: "application/xml, text/xml" },
  }, retryOptions);
  return filterJobsToUs(parseRecruiteeFeed(await response.text(), tenant, origin), {
    usOnly,
    existingExternalIds,
    onLocationFiltered,
  }, maxJobs);
}
