import crypto from "node:crypto";
import type { ExternalSignalSource, NormalizedExternalJob } from "./types";

/**
 * Deterministic dedup key (Phase 11): the provider's own stable listing ID when available, else a
 * hash of (employer + title + location + listing URL). Computed once at normalization time and
 * never recomputed later, so a listing's identity can't silently drift between observations.
 */
export function fingerprintFor(job: Pick<NormalizedExternalJob, "providerJobId" | "employerName" | "title" | "location" | "listingUrl">): string {
  if (job.providerJobId) return job.providerJobId;
  const basis = [job.employerName, job.title, job.location ?? "", job.listingUrl].join("|").toLowerCase().trim();
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

// --- Indeed (borderline/indeed-scraper — confirmed live field shape, 2026-08-16) -----------------

export interface RawIndeedResult {
  jobKey?: string;
  title?: string;
  companyName?: string;
  companyUrl?: string;
  jobUrl?: string;
  applyUrl?: string;
  datePublished?: string;
  jobType?: string[];
  isRemote?: boolean;
  descriptionText?: string;
  "location.formattedAddressShort"?: string;
  "location.countryCode"?: string;
  "salary.salaryText"?: string;
  location?: { formattedAddressShort?: string; countryCode?: string };
  salary?: { salaryText?: string };
  [key: string]: unknown;
}

export function normalizeIndeedResult(raw: RawIndeedResult): NormalizedExternalJob {
  const location = raw["location.formattedAddressShort"] ?? raw.location?.formattedAddressShort ?? null;
  const salaryText = raw["salary.salaryText"] ?? raw.salary?.salaryText ?? null;
  const jobUrl = raw.jobUrl ?? "";
  return {
    source: "indeed",
    providerJobId: raw.jobKey ?? null,
    employerName: raw.companyName ?? "",
    title: raw.title ?? "",
    location,
    description: raw.descriptionText ?? null,
    postedAt: raw.datePublished ?? null,
    listingUrl: jobUrl,
    applyUrl: raw.applyUrl ?? null,
    // Indeed's applyUrl, when present, IS the destination the seeker lands on — sometimes the
    // employer's own ATS, sometimes a staffing agency's ATS/site. Direct-employer-ness is a
    // classification question (Phase 7), not something normalize() decides.
    directEmployerUrl: raw.applyUrl ?? null,
    employmentType: raw.jobType?.[0] ?? null,
    salaryText,
    raw,
  };
}

// --- Google Jobs (johnvc/google-jobs-scraper---pay-per-result — confirmed live field shape) -------

export interface RawGoogleJobsResult {
  title?: string;
  company_name?: string;
  location?: string;
  via?: string;
  job_id?: string;
  description?: string;
  detected_extensions?: { posted_at?: string; schedule_type?: string };
  apply_options?: { title?: string; link?: string }[];
  source_link?: string;
  share_link?: string;
  [key: string]: unknown;
}

export function normalizeGoogleJobsResult(raw: RawGoogleJobsResult): NormalizedExternalJob {
  // apply_options lists one entry per destination network (LinkedIn, Indeed, the employer's own
  // ATS, ...). Prefer whichever entry's title suggests the employer's own site over a known
  // aggregator name — best-effort; final direct-vs-aggregator classification still happens later.
  const applyOptions = raw.apply_options ?? [];
  const knownAggregators = ["linkedin", "indeed", "glassdoor", "ziprecruiter", "monster", "careerbuilder"];
  const directCandidate = applyOptions.find((opt) => !knownAggregators.some((agg) => (opt.title ?? "").toLowerCase().includes(agg)));
  const applyUrl = directCandidate?.link ?? applyOptions[0]?.link ?? null;

  return {
    source: "google_jobs",
    providerJobId: raw.job_id ?? null,
    employerName: raw.company_name ?? "",
    title: raw.title ?? "",
    location: raw.location ?? null,
    description: raw.description ?? null,
    // Google Jobs reports relative text ("2 days ago"), not an ISO date — stored as-is; freshness
    // logic treats a non-ISO postedAt as unparseable rather than guessing a date.
    postedAt: raw.detected_extensions?.posted_at ?? null,
    listingUrl: raw.share_link ?? raw.source_link ?? "",
    applyUrl,
    directEmployerUrl: directCandidate ? directCandidate.link ?? null : null,
    employmentType: raw.detected_extensions?.schedule_type ?? null,
    salaryText: null,
    raw,
  };
}

// --- Built In (public builtin.com job pages — confirmed live field shape, Stage 10 feasibility) ---
// FREE_DIRECT: a plain local fetch() against builtin.com's own public HTML/JSON-LD, no paid
// scraping service of any kind (see providers.ts's builtInProvider). Every field below was
// confirmed against real, live builtin.com responses during Stage 10's read-only feasibility probe.

/** A small, deterministic set of known ad-tracking redirect hosts Built In's own Apply button
 *  sometimes wraps a destination URL in (e.g. a paid-placement listing). The real destination
 *  appears unencoded as the final segment of the tracking URL's own query string — this never
 *  follows the redirect over the network, and never touches an unrecognized host; anything else is
 *  returned completely unchanged. */
const AD_TRACKING_REDIRECT_HOSTS = new Set(["ad.doubleclick.net"]);

/** Confirmed live example (Stage 10): an Optum/UnitedHealth Group listing's Apply href was
 *  "https://ad.doubleclick.net/ddm/clk/638473186;444755998;k?https://careers.unitedhealthgroup.com/job/...".
 *  Deterministically extracts the LAST embedded absolute URL in the string and validates it parses
 *  as a real URL before using it — never a network follow, never a guess. */
export function unwrapTrackingRedirect(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!AD_TRACKING_REDIRECT_HOSTS.has(parsed.hostname.toLowerCase())) return url;
  const matches = [...url.matchAll(/https?:\/\//g)];
  if (matches.length < 2) return url;
  const embedded = url.slice(matches[matches.length - 1].index);
  try {
    new URL(embedded);
    return embedded;
  } catch {
    return url;
  }
}

/**
 * Combined shape this module's own provider.search() produces per listing — the schema.org
 * JobPosting fields from the job-detail page's own JSON-LD, plus the Apply button's raw href
 * (extracted from the surrounding HTML, since Built In never puts the apply destination in the
 * JSON-LD itself — see Stage 10's investigation). Never fabricated: every field is either present
 * on the real page or left null/undefined, exactly as scraped.
 */
export interface RawBuiltInResult {
  identifierValue?: string;
  title?: string;
  hiringOrganizationName?: string;
  datePosted?: string;
  description?: string;
  addressLocality?: string;
  addressRegion?: string;
  addressCountry?: string;
  jobLocationType?: string;
  employmentType?: string;
  baseSalaryText?: string;
  listingUrl?: string;
  applyHref?: string;
  [key: string]: unknown;
}

function builtInLocationText(raw: RawBuiltInResult): string | null {
  const cityState = [raw.addressLocality, raw.addressRegion].filter(Boolean).join(", ");
  if (cityState) return cityState;
  const isUs = raw.addressCountry?.toUpperCase() === "USA" || raw.addressCountry?.toUpperCase() === "US";
  if (raw.jobLocationType === "TELECOMMUTE" && isUs) return "Remote - United States";
  if (isUs) return "United States";
  return raw.addressCountry ?? null;
}

export function normalizeBuiltInResult(raw: RawBuiltInResult): NormalizedExternalJob {
  const applyUrl = raw.applyHref ? unwrapTrackingRedirect(raw.applyHref) : null;
  return {
    source: "built_in",
    providerJobId: raw.identifierValue ?? null,
    employerName: raw.hiringOrganizationName ?? "",
    title: raw.title ?? "",
    location: builtInLocationText(raw),
    description: raw.description ?? null,
    // Built In's datePosted is a plain YYYY-MM-DD (no time component) — stored as-is; classify.ts's
    // shared parseAtsDate already handles this exact format.
    postedAt: raw.datePosted ?? null,
    listingUrl: raw.listingUrl ?? "",
    applyUrl,
    // Built In's own JobPosting JSON-LD carries directApply:false on every listing observed in
    // Stage 10 — application always happens off-Built-In, on the employer's real ATS/careers site
    // (or, rarely, through a wrapped ad-tracking redirect to that same real destination — see
    // unwrapTrackingRedirect above). Same convention as Indeed's own normalizer: the raw apply
    // destination is recorded here at face value; whether it's genuinely a direct employer/ATS link
    // vs. a staffing intermediary is classify.ts's decision (classifyEmployerRelationship/
    // classifyUrlEvidence), never something normalize() decides on its own.
    directEmployerUrl: applyUrl,
    employmentType: raw.employmentType ?? null,
    salaryText: raw.baseSalaryText ?? null,
    raw,
  };
}

export function normalizeRawResult(source: ExternalSignalSource, raw: unknown): NormalizedExternalJob {
  if (source === "indeed") return normalizeIndeedResult(raw as RawIndeedResult);
  if (source === "built_in") return normalizeBuiltInResult(raw as RawBuiltInResult);
  return normalizeGoogleJobsResult(raw as RawGoogleJobsResult);
}
