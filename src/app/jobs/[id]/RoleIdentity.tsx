"use client";

import type { JobMatchResult } from "@/lib/match/types";

/**
 * What role this posting actually is, in Career-Ops' own taxonomy.
 *
 * Source: `recommendedTrack` — the match engine's deterministic classification of the JOB, computed
 * from the criticality-weighted distribution of its requirement categories (trackRecommendation.ts).
 * It is a closed enum of six tracks, so nothing here is free text and nothing is inferred.
 *
 * Two things the design brief asked for are deliberately absent, because the data for them does not
 * exist rather than because they were skipped:
 *
 *   SECONDARY ROLES — `recommendTrack` returns only the winning track; the runner-up scores are
 *   computed and discarded inside the engine. The candidate-side notion (secondary_target_roles in
 *   candidate_settings) is a different concept — the roles the CANDIDATE is targeting, not roles
 *   this JOB aligns to — and reaching it from this pane needs a settings request this page does not
 *   make. Rendering either as "secondary roles for this job" would be a fabrication.
 *
 *   CANONICAL PATH — there is no role hierarchy anywhere in the codebase. No parent/child taxonomy,
 *   no path structure, nothing to render. A breadcrumb would have to be invented level by level.
 *
 * So this renders one role, with the engine's own note about why the alignment scored as it did.
 */
export function RoleIdentity({ result }: { result: JobMatchResult }) {
  const track = result.recommendedTrack;
  const alignment = result.dimensionScores?.roleAlignment ?? null;
  const detail = result.roleAlignmentDetail;
  const classified = track !== "General / Unclassified";

  return (
    <div className="relative">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Primary role</div>

      <div className="mt-1 flex items-baseline gap-2.5">
        {/* The identity marker: the aperture's dot, reused at the smallest scale the language has.
         *  Hollow when the engine could not classify the posting. */}
        <span
          aria-hidden="true"
          className={`mt-[1px] h-2 w-2 shrink-0 rounded-full ${
            classified
              ? "bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]"
              : "bg-transparent ring-1 ring-inset ring-[var(--border)]"
          }`}
        />
        <span className="min-w-0 text-[17px] font-semibold leading-tight tracking-[-0.015em] text-primary">
          {track}
        </span>
        {alignment !== null && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-tertiary">{Math.round(alignment)}% aligned</span>
        )}
      </div>

      {/* The engine's own explanation, verbatim. */}
      {detail?.note && <p className="mt-1.5 text-[11.5px] leading-relaxed text-tertiary">{detail.note}</p>}

      <p className="mt-1.5 text-[11px] leading-relaxed text-tertiary">
        No secondary roles or canonical path — the engine does not record either.
      </p>
    </div>
  );
}
