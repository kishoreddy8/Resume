import type { SourceType } from "@/types";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import type { AtsAdapter } from "./types";
import { greenhouseAdapter } from "./adapters/greenhouse";
import { leverAdapter } from "./adapters/lever";
import { workdayAdapter } from "./adapters/workday";

/**
 * Choosing the form adapter for a job.
 *
 * IDENTITY COMES FROM THE EXISTING ATS LAYER, NOT FROM HERE. Career-Ops already discovers, detects
 * and normalises sources; every job row carries the resulting `source_type`. This module consumes
 * that value. It deliberately contains no hostname patterns of its own — a second detector would be
 * a second opinion, and two opinions about the same posting eventually disagree.
 *
 * The URL fallback exists only for a job whose row has no source_type recorded, and even then it
 * calls the CONNECTOR LAYER'S OWN detector rather than reimplementing one.
 */

/* PHASE 9E — Workday joins the list only now, and deliberately. `ATS_APPLICATION_ADAPTER_ASSESSMENT.md`
 * refused to write this adapter until its form had actually been observed rather than guessed at;
 * that observation happened on 2026-08-25 against a live tenant, is pinned by a sanitized fixture,
 * and is covered by the WORKDAY-* tests. See adapters/workday.ts for what the observation changed
 * about the original assumptions. */
const ADAPTERS: readonly AtsAdapter[] = [greenhouseAdapter, leverAdapter, workdayAdapter];

export interface AdapterSelection {
  adapter: AtsAdapter;
  sourceType: SourceType;
  /** How the identity was established, for the run's history. */
  via: "job_record" | "connector_detector";
}

export function selectAdapter(job: { source_type?: SourceType | null; url?: string | null }): AdapterSelection | null {
  if (job.source_type) {
    const adapter = ADAPTERS.find((a) => a.sourceType === job.source_type);
    return adapter ? { adapter, sourceType: job.source_type, via: "job_record" } : null;
  }

  if (job.url) {
    const detected = detectAtsFromUrlString(job.url);
    if (detected) {
      const adapter = ADAPTERS.find((a) => a.sourceType === detected.sourceType);
      if (adapter) return { adapter, sourceType: detected.sourceType, via: "connector_detector" };
    }
  }

  /* No adapter automates this ATS yet. The run stops and says so rather than falling back to a
   * generic form-filler that would guess at an unfamiliar layout. */
  return null;
}

/** Which ATS platforms currently have form automation. Not the list Career-Ops can DISCOVER. */
export function automatedSourceTypes(): SourceType[] {
  return ADAPTERS.map((a) => a.sourceType);
}
