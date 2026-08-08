import type { PipelineStatus } from "@/types";

/**
 * Consecutive scans (of a live ATS board) a job can go unseen before it's archived. A single miss
 * closes a job (is_active=0) immediately — that's just reflecting what the board says right now.
 * Archiving is more conservative: it's a terminal-ish state meant to declutter the default jobs
 * view, so it waits for the posting to stay gone across several rescans rather than one flaky
 * fetch. Tunable via env for anyone running scans on a different cadence.
 */
export const ARCHIVE_AFTER_MISSED_SCANS = Number(process.env.ARCHIVE_AFTER_MISSED_SCANS ?? 3);

/**
 * Pipeline stages where the user has real, active investment in a job — an application in flight
 * or an interview loop. Archiving one of these (even automatically, even after it closes upstream)
 * would bury something the user still needs to see. This is deliberately the one place this rule
 * is expressed; every archive path (automatic, in src/db/queries/jobs.ts's closeStaleJobs, and
 * manual, in the /api/jobs/[id]/archive route) calls canArchive() rather than re-checking statuses
 * inline, so the guardrail can't silently drift between the two call sites.
 */
export const PROTECTED_PIPELINE_STATUSES: readonly PipelineStatus[] = ["Applied", "Interview"];

export function canArchive(pipelineStatus: PipelineStatus): boolean {
  return !PROTECTED_PIPELINE_STATUSES.includes(pipelineStatus);
}
