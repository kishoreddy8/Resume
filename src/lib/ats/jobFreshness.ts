import type { NormalizedJob } from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FreshnessEvaluation {
  eligible: boolean;
  ageDays: number | null;
  reason: string;
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
  const str = value.trim();
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
 * Evaluates whether a job posting is eligible for production ingestion under the 20-day freshness rule.
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
  maxAgeDays: number = 20,
  now: Date = new Date()
): FreshnessEvaluation {
  // Rule 1: Existing jobs in the DB are always eligible for rescan updates
  if (existingJob) {
    return {
      eligible: true,
      ageDays: null,
      reason: "Existing job in database; eligible for rescan update",
    };
  }

  const postedDate = parseAtsDate(job.postedAt);

  // Rule 3a: Missing date -> fallback to discovery timestamp
  if (!postedDate) {
    return {
      eligible: true,
      ageDays: null,
      reason: "Missing or unparseable posted date; allowed via discovery timestamp",
    };
  }

  // Rule 3b: Future date (> 24 hours ahead) -> treat as unverified date glitch, fallback to discovery
  if (postedDate.getTime() > now.getTime() + DAY_MS) {
    return {
      eligible: true,
      ageDays: 0,
      reason: "Future posted date detected; allowed via discovery timestamp",
    };
  }

  const ageDays = Math.max(0, Math.floor((now.getTime() - postedDate.getTime()) / DAY_MS));

  // Rule 2: Fresh new job (<= 20 days)
  if (ageDays <= maxAgeDays) {
    return {
      eligible: true,
      ageDays,
      reason: `Job is fresh (${ageDays} day(s) old <= ${maxAgeDays} days)`,
    };
  }

  // Rule 4: Stale new discovery (> 20 days)
  return {
    eligible: false,
    ageDays,
    reason: `Job is stale (${ageDays} day(s) old > ${maxAgeDays} days limit)`,
  };
}
