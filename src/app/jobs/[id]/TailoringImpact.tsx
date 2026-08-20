"use client";

import type { JobMatchResult } from "@/lib/match/types";

/**
 * What tailoring did — and, before it runs, what it has to work with.
 *
 * THE PRODUCT GAP, stated plainly rather than papered over:
 *
 * Career-Ops does not currently record tailoring change provenance. The engine computes the
 * information a "what changed" view would need — jdPriorityMatrix.ts ranks each JD requirement into
 * P0..P5 with a STRONG/PARTIAL/NONE evidence strength, skillRanking.ts produces a recommended skill
 * order, and bulletRanking.ts ranks and re-orders experience bullets — but none of it is persisted
 * alongside the generated resume, and no API route exposes any of it. There is no stored before/
 * after, no reordering record, and no list of JD requirements the writer deliberately did not add.
 *
 * So the "surfaced / reordered / rewritten / not added" sections the design calls for cannot be
 * rendered truthfully today. The alternative — diffing the rendered resume text in the browser to
 * guess what changed — would produce confident, unverifiable claims about a document the
 * truthfulness gates exist to protect. That is precisely the wrong trade, so it is not done.
 *
 * Before tailoring, readiness IS fully derivable from the match result, so that is shown instead of
 * an empty diff.
 */
export function TailoringImpact({
  result,
  approved,
  generatedFileCount,
}: {
  result: JobMatchResult | null;
  approved: boolean;
  generatedFileCount: number;
}) {
  if (!result) {
    return <p className="text-[12px] leading-relaxed text-tertiary">This posting has not been evaluated yet.</p>;
  }

  const strong = (result.employerEvidencedMatches ?? []).length;
  const partial = (result.inventoryOnlyMatches ?? []).length + (result.transferableMatches ?? []).length;
  const missing = (result.missingRequirements ?? []).length;
  const unknown = (result.unresolvedRequirements ?? []).length;

  // Requirements the JD asks for that the candidate cannot evidence. Tailoring must not add these —
  // this is the list the truthfulness gates protect, so naming it is useful before a run, not after.
  const unsupported = (result.missingRequirements ?? []).map((m) => m.requirement.label);

  if (generatedFileCount > 0) {
    return (
      <div className="space-y-2.5">
        <p className="text-[12.5px] leading-relaxed text-secondary">
          <span className="font-medium text-primary">
            {generatedFileCount} generated file{generatedFileCount === 1 ? "" : "s"}
          </span>{" "}
          exist for this job.
        </p>
        <div className="rounded-[var(--radius-md)] bg-[var(--z0-bg)] px-3 py-2.5">
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-tertiary">Change provenance</div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-secondary">
            Detailed tailoring change provenance is not currently recorded. JobHunt does not persist what was
            surfaced, reordered, rewritten, or deliberately not added, so no before/after can be shown without
            inventing it.
          </p>
        </div>
        {unsupported.length > 0 && (
          <div>
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-tertiary">
              JD requirements with no candidate evidence
            </div>
            <ul className="mt-1 space-y-0.5">
              {unsupported.slice(0, 6).map((label) => (
                <li key={label} className="flex items-baseline gap-2 text-[11.5px] text-tertiary">
                  <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full ring-1 ring-inset ring-[var(--border)]" />
                  {label} — must not be added by tailoring
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-tertiary">Tailoring readiness</div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
        <span className="text-[var(--success)]">
          <span className="font-semibold tabular-nums">{strong}</span> strong
        </span>
        <span className="text-[var(--warning)]">
          <span className="font-semibold tabular-nums">{partial}</span> partial
        </span>
        <span className="text-tertiary">
          <span className="font-semibold tabular-nums">{missing}</span> not found
        </span>
        {unknown > 0 && (
          <span className="text-tertiary">
            <span className="font-semibold tabular-nums">{unknown}</span> unknown
          </span>
        )}
      </div>
      <p className="text-[11.5px] leading-relaxed text-tertiary">
        {approved
          ? "Approved for tailoring. Resume Writer is off, so nothing runs automatically — run the skill in Claude Code."
          : "Counts come from the match evaluation. Nothing is written or submitted until you approve tailoring."}
      </p>
    </div>
  );
}
