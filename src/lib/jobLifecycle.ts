import type { JobAgeBand, PipelineStatus } from "@/types";

/**
 * Final age-based Job Lifecycle Management policy.
 *
 * Age source: reliable posted_at, else first_seen_at. NEVER last_seen_at — last_seen_at only
 * records when a scan most recently re-confirmed the posting still exists, so using it would reset
 * a job's age back to ~0 every time an unchanged posting is simply seen again, which defeats "how
 * long has this actually been sitting unactioned" entirely.
 *
 *   0–3 days   Fresh    — visible on the main Jobs dashboard, highlighted as high priority.
 *   4–7 days   Active   — visible on the main Jobs dashboard, no special highlight.
 *   8–10 days  Archived — hidden from the default Jobs view (still visible in Archived Jobs) —
 *                         but ONLY if the job is unapplied and unpinned (see below).
 *   >10 days   Deleted  — the job record is permanently removed — ONLY if unapplied and unpinned.
 *
 * Protected pipeline stages — Applied, Interviewing, Offer, Employer Rejected — plus a manual
 * `pinned` flag are NEVER auto-archived or auto-deleted by age, or by a posting closing upstream,
 * regardless of how old they get. This is enforced in exactly one place (isLifecycleProtected,
 * below) and checked by every archive/delete path — the scan-time "posting closed" handler in
 * closeStaleJobs, the age sweep in runAgeBasedSweep, and the manual archive API route — so the
 * guarantee can't drift between call sites.
 */

export const FRESH_MAX_DAYS = 3;
export const ACTIVE_MAX_DAYS = 7;
export const ARCHIVE_MAX_DAYS = 10; // 8-10 inclusive is the archive window; >10 is delete-eligible

export const PROTECTED_PIPELINE_STATUSES: readonly PipelineStatus[] = [
  "Applied",
  "Interviewing",
  "Offer",
  "Employer Rejected",
];

export interface LifecycleGuardInput {
  pipelineStatus: PipelineStatus;
  pinned: 0 | 1 | boolean;
}

function isPinned(pinned: 0 | 1 | boolean): boolean {
  return pinned === true || pinned === 1;
}

/** True if this job must never be auto-archived or auto-deleted, by any mechanism. */
export function isLifecycleProtected(input: LifecycleGuardInput): boolean {
  return PROTECTED_PIPELINE_STATUSES.includes(input.pipelineStatus) || isPinned(input.pinned);
}

export function canArchive(input: LifecycleGuardInput): boolean {
  return !isLifecycleProtected(input);
}

export function canDelete(input: LifecycleGuardInput): boolean {
  return !isLifecycleProtected(input);
}

export interface JobAgeInput {
  posted_at: string | null;
  first_seen_at: string;
}

/**
 * "Reliable" posted_at: present, parses to a real date, and not in the future — some ATS feeds
 * have been observed to send missing or placeholder dates, and a future-dated posting is more
 * likely bad data than a genuinely reliable signal to compute age from.
 */
export function getJobAgeSource(job: JobAgeInput, now: Date = new Date()): { source: "posted_at" | "first_seen_at"; date: Date } {
  if (job.posted_at) {
    const posted = new Date(job.posted_at);
    if (!Number.isNaN(posted.getTime()) && posted.getTime() <= now.getTime()) {
      return { source: "posted_at", date: posted };
    }
  }
  return { source: "first_seen_at", date: new Date(job.first_seen_at) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function getJobAgeDays(job: JobAgeInput, now: Date = new Date()): number {
  const { date } = getJobAgeSource(job, now);
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
}

export function getJobAgeBand(ageDays: number): JobAgeBand {
  if (ageDays <= FRESH_MAX_DAYS) return "fresh";
  if (ageDays <= ACTIVE_MAX_DAYS) return "active";
  if (ageDays <= ARCHIVE_MAX_DAYS) return "aging";
  return "stale";
}
