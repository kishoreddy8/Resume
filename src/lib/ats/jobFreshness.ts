import type {
  FreshnessConfidence,
  FreshnessDateType,
  FreshnessProvenance,
  NormalizedJob,
  SourceType,
} from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FreshnessEvaluation {
  eligible: boolean;
  ageDays: number | null;
  reason: string;
  provenance: FreshnessProvenance;
}

/**
 * Maps each supported ATS provider to its native semantic date type.
 */
export function getProviderDateType(sourceType?: SourceType): FreshnessDateType {
  if (!sourceType) return "POSTED";
  switch (sourceType) {
    case "greenhouse":
    case "comeet":
      return "UPDATED";
    case "lever":
    case "rippling":
    case "eightfold":
    case "personio":
      return "CREATED";
    case "ashby":
    case "workable":
    case "teamtailor":
    case "smartrecruiters":
    case "paylocity":
      return "PUBLISHED";
    case "workday":
    case "icims":
    case "adp_wfn":
    case "adp_rm":
    case "bamboohr":
    case "jobvite":
    case "ukg_pro":
    case "oracle_recruiting_cloud":
    case "cornerstone":
    case "jobdiva":
    case "gohire":
    case "applicantpro":
    case "applicantstack":
    case "breezy":
    case "jazzhr":
    case "paycom":
    case "avature":
      return "POSTED";
    case "clearcompany":
    case "pinpoint":
    case "cats":
    case "newton":
    case "silkroad":
    case "taleo":
    case "career_link":
      return "FIRST_SEEN";
    default:
      return "POSTED";
  }
}

/**
 * Parses any standard ATS date string or numeric timestamp into a valid Date object.
 * Returns null if the value is missing, invalid, or unparseable.
 */
export function parseAtsDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Handle seconds vs milliseconds timestamps
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const str = String(value).trim();
  if (!str) return null;

  // Handle US MM/DD/YYYY format (e.g. JobDiva "08/14/2026")
  const usDateMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usDateMatch) {
    const month = Number(usDateMatch[1]) - 1;
    const day = Number(usDateMatch[2]);
    const year = Number(usDateMatch[3]);
    const d = new Date(Date.UTC(year, month, day));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Standard ISO / RFC / YYYY-MM-DD parse
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Evaluates whether a job posting is eligible for production ingestion under the 20-day freshness rule
 * and produces full provenance explaining why the job is considered fresh.
 *
 * Rules:
 * 1. Rescans of already-existing database jobs are ALWAYS eligible (they update last_seen_at and follow lifecycle).
 * 2. New discoveries with a reliable posting date must be <= maxAgeDays (default: 20 days).
 * 3. New discoveries with missing, unparseable, or future dates safely fall back to the discovery timestamp (eligible).
 * 4. New discoveries older than maxAgeDays (> 20 days) are rejected from initial production ingestion.
 */
export function isJobFreshForIngestion(
  job: NormalizedJob,
  existingJob: { id: number } | undefined,
  sourceType?: SourceType,
  maxAgeDays: number = 20,
  now: Date = new Date()
): FreshnessEvaluation {
  const rawDate = job.postedAt !== null && job.postedAt !== undefined ? String(job.postedAt).trim() : null;

  // Rule 1: Rescans of existing DB jobs are always eligible (preserves lifecycle)
  if (existingJob) {
    const provDateType = rawDate ? (job.freshnessDateType ?? getProviderDateType(sourceType)) : "FIRST_SEEN";
    return {
      eligible: true,
      ageDays: null,
      reason: "Existing job in database; eligible for rescan update",
      provenance: {
        dateType: provDateType,
        confidence: "HIGH",
        basisDate: rawDate ? parseAtsDate(rawDate)?.toISOString() ?? null : null,
        rawDate,
        ageDays: null,
        reason: "Existing job in database; eligible for rescan update",
      },
    };
  }

  // Rule 3a: Missing date -> fallback to discovery timestamp
  if (!rawDate) {
    return {
      eligible: true,
      ageDays: 0,
      reason: "Missing provider date; allowed via discovery timestamp fallback",
      provenance: {
        dateType: "FIRST_SEEN",
        confidence: "LOW",
        basisDate: now.toISOString(),
        rawDate: null,
        ageDays: 0,
        reason: "Missing provider date; allowed via discovery timestamp fallback",
      },
    };
  }

  const postedDate = parseAtsDate(rawDate);

  // Rule 3b: Invalid/unparseable date -> fallback to discovery timestamp
  if (!postedDate) {
    return {
      eligible: true,
      ageDays: 0,
      reason: "Unparseable provider date; allowed via discovery timestamp fallback",
      provenance: {
        dateType: "UNKNOWN",
        confidence: "NONE",
        basisDate: now.toISOString(),
        rawDate,
        ageDays: 0,
        reason: "Unparseable provider date; allowed via discovery timestamp fallback",
      },
    };
  }

  // Rule 3c: Future date (> 24 hours ahead) -> treat as unverified date glitch, fallback to discovery
  if (postedDate.getTime() > now.getTime() + DAY_MS) {
    return {
      eligible: true,
      ageDays: 0,
      reason: "Future posted date detected (>24h ahead); allowed via discovery timestamp fallback",
      provenance: {
        dateType: "UNKNOWN",
        confidence: "NONE",
        basisDate: now.toISOString(),
        rawDate,
        ageDays: 0,
        reason: "Future posted date detected (>24h ahead); allowed via discovery timestamp fallback",
      },
    };
  }

  // Calculate age in days (with 0 day minimum for timezone drift within 24h)
  const ageDays = Math.max(0, Math.floor((now.getTime() - postedDate.getTime()) / DAY_MS));
  const dateType = job.freshnessDateType ?? getProviderDateType(sourceType);
  const confidence: FreshnessConfidence =
    dateType === "POSTED" || dateType === "PUBLISHED"
      ? "HIGH"
      : dateType === "CREATED" || dateType === "UPDATED"
      ? "MEDIUM"
      : "LOW";

  // Rule 2: Fresh new job (<= maxAgeDays)
  if (ageDays <= maxAgeDays) {
    return {
      eligible: true,
      ageDays,
      reason: `Job is fresh (${ageDays} day(s) old <= ${maxAgeDays} days via ${dateType} date)`,
      provenance: {
        dateType,
        confidence,
        basisDate: postedDate.toISOString(),
        rawDate,
        ageDays,
        reason: `Job is fresh (${ageDays} day(s) old <= ${maxAgeDays} days via ${dateType} date)`,
      },
    };
  }

  // Rule 4: Stale new discovery (> maxAgeDays)
  return {
    eligible: false,
    ageDays,
    reason: `Job is stale (${ageDays} day(s) old > ${maxAgeDays} days limit via ${dateType} date)`,
    provenance: {
      dateType,
      confidence,
      basisDate: postedDate.toISOString(),
      rawDate,
      ageDays,
      reason: `Job is stale (${ageDays} day(s) old > ${maxAgeDays} days limit via ${dateType} date)`,
    },
  };
}
