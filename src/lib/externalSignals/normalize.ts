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

export function normalizeRawResult(source: ExternalSignalSource, raw: unknown): NormalizedExternalJob {
  if (source === "indeed") return normalizeIndeedResult(raw as RawIndeedResult);
  return normalizeGoogleJobsResult(raw as RawGoogleJobsResult);
}
