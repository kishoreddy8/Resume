import type { NormalizedJob } from "@/types";

/**
 * Connector Reliability Final Hardening — the shared fix for a defect found across ~11 ATS
 * adapters (BambooHR, Oracle Recruiting Cloud, ApplicantPro, Rippling, Paycom, ClearCompany,
 * Workable, UKG, Eightfold, Comeet, JobDiva): each per-job detail fetch runs inside
 * `Promise.all(selected.map(...))`, so a plain `throw` for ONE job with a missing/empty
 * description rejects the whole `Promise.all` — aborting the entire company's scan over a single
 * job's content gap. See src/lib/scan.ts's own `if (!job.descriptionText) descriptionFailures++`
 * handling: the codebase already has a correct, established mechanism for exactly this — an
 * isolated per-job description gap is a data-quality WARNING (see
 * src/db/queries/atsCoverage.ts's DESCRIPTION_PARTIAL), not a connector failure, unless it happens
 * for every discovered job (src/lib/scan.ts's hasCompleteDescriptionFailure, which still correctly
 * marks the whole scan 'partial' when it does). This helper makes the affected adapters participate
 * in that existing mechanism instead of aborting.
 *
 * Deliberately narrow: only for the specific "the description content itself is missing/empty"
 * case. A DETAIL IDENTITY MISMATCH (wrong job ID, wrong tenant, a canonical URL that doesn't match)
 * is a different, more serious signal — it can mean cross-tenant data confusion, not just "this one
 * posting lacks body text" — and every affected adapter's identity checks are deliberately left as
 * real throws, unchanged, by this fix.
 */
export function degradeMissingDescription(listing: NormalizedJob): NormalizedJob {
  return { ...listing, descriptionHtml: null, descriptionText: "" };
}
