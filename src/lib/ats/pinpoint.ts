import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface PinpointPosting {
  id?: string;
  title?: string;
  url?: string;
  path?: string;
  description?: string | null;
  key_responsibilities?: string | null;
  skills_knowledge_expertise?: string | null;
  benefits?: string | null;
  employment_type_text?: string | null;
  workplace_type_text?: string | null;
  compensation?: string | null;
  job?: { requisition_id?: string | null; department?: { name?: string } | null; division?: { name?: string } | null };
  location?: { name?: string; city?: string; province?: string; postal_code?: string; street_address?: string } | null;
}

export interface FetchPinpointJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only origin override. Production uses the tenant's pinpointhq.com origin. */
  hostOverride?: string;
}

export function normalizePinpointTenant(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(tenant) || tenant === "www") throw new Error("Invalid Pinpoint tenant");
  return tenant;
}

export function canonicalPinpointUrl(tenant: string): string {
  return `https://${normalizePinpointTenant(tenant)}.pinpointhq.com/`;
}

function section(heading: string, html: string | null | undefined): string {
  return html?.trim() ? `<h3>${heading}</h3>${html.trim()}` : "";
}

function locationText(posting: PinpointPosting): string | null {
  const location = posting.location;
  if (!location) return null;
  const parts = [location.name, location.city, location.province, location.postal_code]
    .map((value) => value?.trim()).filter(Boolean);
  return parts.length ? [...new Set(parts)].join(", ") : null;
}

function parsePostings(payload: unknown, origin: string): NormalizedJob[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error("Pinpoint response is not its complete public postings snapshot");
  }
  const postings = (payload as { data: PinpointPosting[] }).data;
  const seen = new Set<string>();
  return postings.map((posting) => {
    let url: URL;
    try { url = new URL(posting.url ?? ""); } catch { throw new Error("Pinpoint posting has an invalid URL"); }
    const match = url.pathname.match(/^\/(?:[a-z]{2}\/)?postings\/([a-f0-9-]{36})\/?$/i);
    const externalId = match?.[1]?.toLowerCase();
    if (!externalId || url.origin !== origin || posting.path !== url.pathname || seen.has(externalId)
      || !posting.id?.trim() || !posting.title?.trim() || !posting.description?.trim()) {
      throw new Error("Pinpoint posting has a mismatched identity, duplicate UUID, or missing core content");
    }
    seen.add(externalId);
    const descriptionHtml = [
      posting.description.trim(),
      section("Key Responsibilities", posting.key_responsibilities),
      section("Skills, Knowledge and Expertise", posting.skills_knowledge_expertise),
      section("Benefits", posting.benefits),
    ].filter(Boolean).join("\n");
    return {
      externalId,
      title: posting.title.trim(),
      location: locationText(posting),
      department: [posting.job?.division?.name, posting.job?.department?.name].filter(Boolean).join(" - ") || null,
      url: url.href,
      descriptionHtml,
      descriptionText: stripHtml(descriptionHtml),
      employmentType: posting.employment_type_text?.trim() || null,
      workplaceType: posting.workplace_type_text?.trim() || null,
      salaryText: posting.compensation?.trim() || null,
      postedAt: null,
      raw: posting,
    };
  });
}

/** Pinpoint's root public postings.json is the complete, non-paginated UI snapshot and already
 * contains full descriptions plus structured locations, so filtering needs no detail requests. */
export async function fetchPinpointJobs(tenantValue: string, options: FetchPinpointJobsOptions = {}): Promise<NormalizedJob[]> {
  const tenant = normalizePinpointTenant(tenantValue);
  const { hostOverride, maxJobs, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = (hostOverride ?? `https://${tenant}.pinpointhq.com`).replace(/\/$/, "");
  const response = await fetchWithRetry(`${origin}/postings.json`, { headers: { Accept: "application/json" } }, retryOptions);
  return filterJobsToUs(parsePostings(await response.json(), origin),
    { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
}
