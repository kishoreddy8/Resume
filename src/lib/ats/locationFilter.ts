import { classifyJobLocation } from "@/lib/jobLocationScope";
import type { NormalizedJob } from "@/types";

export interface LocationFilterOptions {
  usOnly?: boolean;
  /** Existing provider IDs are retained as lifecycle-only sightings when a U.S.-scoped scan
   * excludes them. This prevents a filter rollout from being mistaken for a provider closure. */
  existingExternalIds?: ReadonlySet<string>;
  /** Workday-only list fingerprints, keyed by provider requisition ID. */
  existingListingFingerprints?: ReadonlyMap<string, string>;
  /** Reports excluded final classifications to scan observability without coupling connectors to
   * persistence. UNKNOWN makes an authoritative scan partial so it can never drive closures. */
  onLocationFiltered?: (scope: "NON_US" | "UNKNOWN", job: NormalizedJob) => void;
}

export function filterJobsToUs(
  jobs: NormalizedJob[],
  options: LocationFilterOptions,
  maxJobs?: number
): NormalizedJob[] {
  if (!options.usOnly) return jobs.slice(0, maxJobs);

  const included: NormalizedJob[] = [];
  const lifecycleSightings: NormalizedJob[] = [];
  for (const job of jobs) {
    const scope = classifyJobLocation(job.location);
    if (scope === "US") {
      if (maxJobs === undefined || included.length < maxJobs) included.push(job);
    } else {
      options.onLocationFiltered?.(scope, job);
      if (job.externalId && options.existingExternalIds?.has(job.externalId)) {
        lifecycleSightings.push({ ...job, lifecycleOnly: true });
      }
    }
  }
  return [...included, ...lifecycleSightings];
}
