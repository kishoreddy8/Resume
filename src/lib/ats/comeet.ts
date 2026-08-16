import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface ComeetCompany { slug?: string; company_uid?: string; token?: string }
interface ComeetPosition {
  name?: string; department?: string | null; uid?: string; employment_type?: string | null;
  workplace_type?: string | null; time_updated?: string | null; url_comeet_hosted_page?: string;
  location?: { name?: string; country?: string; city?: string; state?: string; postal_code?: string; is_remote?: boolean };
  custom_fields?: { details?: Array<{ name?: string; value?: string; order?: number }> };
}

export interface FetchComeetJobsOptions extends FetchWithRetryOptions, LocationFilterOptions { maxJobs?: number; hostOverride?: string }

export function normalizeComeetToken(value: string): string {
  const [slug, companyUid, ...extra] = value.trim().split("|");
  if (extra.length || !/^[a-z0-9-]+$/i.test(slug ?? "") || !/^[a-z0-9.]+$/i.test(companyUid ?? "")) throw new Error("Invalid Comeet board token");
  return `${slug.toLowerCase()}|${companyUid.toUpperCase()}`;
}

export function canonicalComeetUrl(value: string): string {
  const [slug, uid] = normalizeComeetToken(value).split("|");
  return `https://www.comeet.com/jobs/${slug}/${uid}`;
}

function embeddedJson<T>(html: string, variable: string): T {
  const match = html.match(new RegExp(`(?:var\\s+)?${variable}\\s*=\\s*([^\\r\\n]+?);\\s*(?:\\r?\\n|$)`));
  if (!match) throw new Error(`Comeet board has no ${variable} snapshot`);
  try { return JSON.parse(match[1]) as T; } catch { throw new Error(`Comeet ${variable} snapshot is malformed`); }
}

function parseBoard(html: string, origin: string, slug: string, companyUid: string): NormalizedJob[] {
  const company = embeddedJson<ComeetCompany>(html, "COMPANY_DATA");
  const positions = embeddedJson<ComeetPosition[]>(html, "COMPANY_POSITIONS_DATA");
  if (company.slug !== slug || company.company_uid?.toUpperCase() !== companyUid || !company.token || !Array.isArray(positions)) {
    throw new Error("Comeet board identity or complete positions snapshot does not match the requested company");
  }
  const seen = new Set<string>();
  return positions.map((position) => {
    const id = position.uid?.toUpperCase();
    const urlValue = position.url_comeet_hosted_page;
    const details = [...(position.custom_fields?.details ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!id || !/^[A-Z0-9.]+$/.test(id) || !position.name?.trim() || !urlValue || details.length === 0) {
      throw new Error("Comeet position is missing a stable ID, title, URL, or full description");
    }
    const url = new URL(urlValue);
    const match = url.pathname.match(/^\/jobs\/([a-z0-9-]+)\/([a-z0-9.]+)\/[^/]+\/([a-z0-9.]+)\/?$/i);
    if (url.origin !== origin || match?.[1].toLowerCase() !== slug || match?.[2].toUpperCase() !== companyUid || match?.[3].toUpperCase() !== id || seen.has(id)) {
      throw new Error("Comeet position has mismatched tenant identity or a duplicate ID");
    }
    seen.add(id);
    const descriptionHtml = details.map((detail) => `<h3>${detail.name ?? "Details"}</h3>${detail.value ?? ""}`).join("\n");
    const descriptionText = stripHtml(descriptionHtml);
    const location = position.location;
    const countryCode = location?.country?.trim();
    const country = countryCode && /^[A-Z]{2}$/.test(countryCode)
      ? new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode) ?? countryCode
      : countryCode;
    const locationText = [location?.city, location?.state, country, location?.postal_code].filter(Boolean).join(", ") || (location?.is_remote ? "Remote" : null);
    // A single position with no full description is a per-job content gap, not a board failure —
    // keep it (with a blank description scan.ts's own descriptionFailures counting expects) rather
    // than aborting the whole board (see jobContentFailure.ts).
    return { externalId: id, title: position.name.trim(), location: locationText, department: position.department?.trim() || null,
      url: url.href, descriptionHtml: descriptionText ? descriptionHtml : null, descriptionText,
      employmentType: position.employment_type ?? null,
      workplaceType: position.workplace_type ?? (location?.is_remote ? "Remote" : null),
      salaryText: descriptionText ? extractSalaryText(descriptionText) : null,
      postedAt: position.time_updated ?? null, raw: position };
  });
}

/** Comeet embeds the complete current positions snapshot, including descriptions and structured
 * locations, in its public tenant board; no detail requests are required. */
export async function fetchComeetJobs(tokenValue: string, options: FetchComeetJobsOptions = {}): Promise<NormalizedJob[]> {
  const token = normalizeComeetToken(tokenValue); const [slug, companyUid] = token.split("|");
  const { hostOverride, maxJobs, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (hostOverride ?? "https://www.comeet.com").replace(/\/$/, "");
  const response = await fetchWithRetry(`${origin}/jobs/${slug}/${companyUid}`, { headers: { Accept: "text/html" } }, retryOptions);
  return filterJobsToUs(parseBoard(await response.text(), origin, slug, companyUid),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
}
