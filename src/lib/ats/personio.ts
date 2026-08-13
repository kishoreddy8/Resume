import { extractSalaryText } from "@/lib/extractSalary";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

export interface FetchPersonioJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production uses the tenant's jobs.personio.de origin. */
  hostOverride?: string;
}

export function normalizePersonioTenant(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(tenant) || tenant === "www") throw new Error("Invalid Personio tenant");
  return tenant;
}

export function canonicalPersonioUrl(tenant: string): string {
  return `https://${normalizePersonioTenant(tenant)}.jobs.personio.de/`;
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

function parseFeed(xml: string, origin: string): NormalizedJob[] {
  if (!/^\s*<\?xml\b/i.test(xml) || !/<workzag-jobs>[\s\S]*<\/workzag-jobs>\s*$/i.test(xml)) {
    throw new Error("Personio response is not its public XML jobs feed");
  }
  const jobs: NormalizedJob[] = [];
  const seen = new Set<string>();
  for (const position of xml.matchAll(/<position>([\s\S]*?)<\/position>/gi)) {
    const id = xmlValue(position[1], "id");
    const title = xmlValue(position[1], "name");
    const office = xmlValue(position[1], "office");
    const descriptions = [...position[1].matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/gi)]
      .map((entry) => ({ heading: xmlValue(entry[1], "name"), value: xmlValue(entry[1], "value") }))
      .filter((entry): entry is { heading: string; value: string } => Boolean(entry.heading && entry.value));
    if (!id || !/^\d+$/.test(id) || !title || !office || descriptions.length === 0) {
      throw new Error("Personio position is missing a stable ID, title, location, or full description");
    }
    if (seen.has(id)) throw new Error("Personio feed contains a duplicate position ID");
    seen.add(id);
    const descriptionHtml = descriptions.map(({ heading, value }) => `<h3>${heading}</h3>${value}`).join("\n");
    const descriptionText = stripHtml(descriptionHtml);
    jobs.push({
      externalId: id,
      title: stripHtml(title),
      location: stripHtml(office),
      department: xmlValue(position[1], "department"),
      url: `${origin}/job/${id}`,
      descriptionHtml,
      descriptionText,
      employmentType: xmlValue(position[1], "schedule") ?? xmlValue(position[1], "employmentType"),
      workplaceType: /\bremote\b/i.test(office) ? "Remote" : null,
      salaryText: extractSalaryText(descriptionText),
      postedAt: parseDate(xmlValue(position[1], "createdAt")),
      raw: {
        subcompany: xmlValue(position[1], "subcompany"),
        recruitingCategory: xmlValue(position[1], "recruitingCategory"),
        employmentType: xmlValue(position[1], "employmentType"),
        occupation: xmlValue(position[1], "occupation"),
        seniority: xmlValue(position[1], "seniority"),
      },
    });
  }
  return jobs;
}

/** Personio's public XML feed is a complete, non-paginated board snapshot with full descriptions
 * and structured office values, so the shared U.S. filter runs without detail requests. */
export async function fetchPersonioJobs(tenantValue: string, options: FetchPersonioJobsOptions = {}): Promise<NormalizedJob[]> {
  const tenant = normalizePersonioTenant(tenantValue);
  const { hostOverride, maxJobs, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (hostOverride ?? `https://${tenant}.jobs.personio.de`).replace(/\/$/, "");
  const response = await fetchWithRetry(`${origin}/xml`, { headers: { Accept: "application/xml, text/xml" } }, retryOptions);
  return filterJobsToUs(parseFeed(await response.text(), origin),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
}
