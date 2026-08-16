import type { Job, NormalizedJob, ScanRunStatus, SourceType } from "@/types";

/**
 * A company's job-list fetch either fully succeeds or the whole scanCompany() call throws (handled
 * separately, in scan.ts's catch block, as "failed"). This function only decides between the two
 * outcomes reachable when nothing threw: "success" (every discovered job's description/location
 * resolved cleanly) or "partial" (the list itself was complete, but ≥1 job's description permanently
 * failed after retries, or ≥1 job's location remained UNKNOWN — reachable on any provider, not just
 * Workday). The input is descriptionFailures + unknownLocationCount only; scan.ts deliberately does
 * not fold sample/verification-scan mode into this count (see its own comment on isSampleScan).
 */
export function determineScanStatus(descriptionFailures: number): Exclude<ScanRunStatus, "failed"> {
  return descriptionFailures > 0 ? "partial" : "success";
}

/**
 * SAFETY RULE: failed or partial scans must never close/archive/delete jobs — only a fully
 * successful scan of an authoritative ATS board may act on "this job disappeared" (see
 * closeStaleJobs in src/db/queries/jobs.ts). career_link scrapes were already excluded from this
 * before this feature (they're best-effort, never authoritative) — that rule is preserved here,
 * not reintroduced.
 *
 * Deliberately conservative: a "partial" scan's job *list* is actually complete (only per-job
 * description enrichment failed), so closing missing jobs would arguably still be safe — but the
 * task's safety rule is a blanket "partial scans never close," so that's what this enforces.
 */
export function canRunLifecycleActions(status: ScanRunStatus, sourceType: SourceType): boolean {
  if (sourceType === "career_link") return false;
  return status === "success";
}

/**
 * True if any field a rescan could plausibly change actually differs from what's stored — used
 * only to split scan_runs' jobs_updated/jobs_unchanged counters (upsertJob's own
 * "inserted"|"updated"|"suppressed" return contract is unaffected — see src/lib/scan.ts's doc
 * comment on why that stays untouched). Does not affect what gets written to the DB; upsertJob
 * always writes the incoming job's fields regardless of this result.
 */
export function hasContentChanged(before: Job, job: NormalizedJob): boolean {
  return (
    before.title !== job.title ||
    before.location !== job.location ||
    before.department !== job.department ||
    before.url !== job.url ||
    before.description_html !== job.descriptionHtml ||
    before.description_text !== job.descriptionText ||
    before.employment_type !== job.employmentType ||
    before.workplace_type !== job.workplaceType ||
    before.salary_text !== job.salaryText ||
    before.posted_at !== job.postedAt
  );
}
