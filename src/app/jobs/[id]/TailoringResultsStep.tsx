"use client";

import type { TailoringPlan } from "@/lib/tailoringIntelligence/plan";
import type { QualityWorkflowData } from "./useQualityWorkflow";
import { BulletRow, Chip, EmptyNote, StepSectionHeading, WsCard } from "./WorkspaceUI";

/**
 * Step 3 — Tailoring Results, as five columns read across.
 *
 * WHAT IS ACTUALLY PERSISTED, AND WHAT IS NOT. I audited the tailoring output before building this:
 *
 *   EXISTS  — per-iteration review scores (overall, ATS, blocking-issue count), the review's
 *             `missingRequiredSkills`, and the plan's `emphasize` / `doNotClaim` / `employerEmphasis`.
 *   ABSENT  — any per-skill change type. Nothing records that a skill was "added" rather than
 *             "strengthened" or "surfaced".
 *   ABSENT  — any before/after ordering of experience. Only the final prioritisation exists.
 *
 * So two cards keep the reference's position and shape but carry a truthful title instead of an
 * invented one: "Skills highlighted" rather than Added/Strengthened/Surfaced, and "Experience
 * prioritisation" rather than Before → After. Labelling an emphasis list as a diff would be
 * inventing a change history, and a resume screen is the last place to do that.
 *
 * THE IMPACT NUMBERS ARE REAL. The iteration table genuinely records a first and a later pass, so
 * the movement between them is a measured fact, not a manufactured "+18% improvement". Where only
 * one iteration exists, no movement is claimed.
 */

function iterationImpact(data: QualityWorkflowData | null) {
  const iters = data?.iterations ?? [];
  if (iters.length === 0) return null;
  const sorted = [...iters].sort((a, b) => a.iteration - b.iteration);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return {
    passes: sorted.length,
    firstOverall: first.overall,
    lastOverall: last.overall,
    firstAts: first.ats,
    lastAts: last.ats,
    blocking: last.blocking,
    moved: sorted.length > 1 && first.overall !== null && last.overall !== null && first.overall !== last.overall,
  };
}

/**
 * Why the resume was changed, from signals that actually exist.
 *
 * Each line is conditional on the thing it describes being present in the plan or the review, so
 * nothing here claims a change the engine did not make. There is deliberately no "improved your
 * chances" — nothing in the system measures that.
 */
function reasons(plan: TailoringPlan | null, data: QualityWorkflowData | null): string[] {
  const out: string[] = [];
  if (plan && plan.emphasize.length > 0) out.push("Led with the requirements your documents evidence");
  if (plan && plan.employerEmphasis.length > 0) out.push("Ordered experience by how much of this job it supports");
  if (plan && plan.doNotClaim.length > 0) out.push("Left out everything your documents do not support");
  const impact = iterationImpact(data);
  if (impact?.moved) out.push("Re-reviewed and corrected until the quality gate's criteria were met");
  if (data?.review && data.review.truthfulnessScore === 100)
    out.push("Every claim traced back to your master documents");
  return out.slice(0, 5);
}

export function TailoringResultsStep({
  plan,
  data,
}: {
  plan: TailoringPlan | null;
  data: QualityWorkflowData | null;
}) {
  const impact = iterationImpact(data);
  /* Requirements the JD asked for that nothing in the candidate's documents supports. Two real
   * sources: the plan's do-not-claim list and the review's own missing-required-skills. */
  const notIncluded = [
    ...new Set([...(plan?.doNotClaim ?? []).map((r) => r.label), ...(data?.review?.missingRequiredSkills ?? [])]),
  ];
  const highlighted = plan?.emphasize ?? [];
  const priority = plan?.employerEmphasis ?? [];
  const why = reasons(plan, data);

  return (
    <div>
      <StepSectionHeading
        title="Tailoring results"
        blurb="What was emphasised for this job, and what was deliberately left out."
      />

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {/* 1 — impact */}
        <WsCard title="Tailoring impact">
          {!impact ? (
            <EmptyNote>No resume has been produced for this job yet.</EmptyNote>
          ) : (
            <ul>
              <BulletRow>
                {impact.passes} review {impact.passes === 1 ? "pass" : "passes"} run
              </BulletRow>
              {impact.lastOverall !== null && (
                <BulletRow>
                  Final review score {impact.lastOverall}
                  {impact.moved && impact.firstOverall !== null && (
                    <span className="text-tertiary"> — up from {impact.firstOverall} on the first pass</span>
                  )}
                </BulletRow>
              )}
              {impact.lastAts !== null && impact.firstAts !== null && impact.lastAts !== impact.firstAts && (
                <BulletRow>
                  ATS alignment {impact.firstAts} → {impact.lastAts}
                </BulletRow>
              )}
              <BulletRow>
                {impact.blocking === 0 ? "No blocking issues on the final pass" : `${impact.blocking} blocking issues`}
              </BulletRow>
            </ul>
          )}
        </WsCard>

        {/* 2 — skills highlighted (no per-skill diff is persisted; see the note above) */}
        <WsCard title="Skills highlighted">
          {highlighted.length === 0 ? (
            <EmptyNote>Nothing in this posting is supported by your documents.</EmptyNote>
          ) : (
            <ul className="divide-y divide-[#F2F3F7] dark:divide-[var(--separator)]">
              {highlighted.slice(0, 6).map((r) => (
                <li key={r.label} className="py-[5px]">
                  <div className="truncate text-[12.5px] text-primary">{r.label}</div>
                  <div className="mt-0.5 truncate text-[11px] text-tertiary">
                    {r.employers.length > 0 ? r.employers.slice(0, 2).join(", ") : "Master Skills Inventory"}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </WsCard>

        {/* 3 — not included */}
        <WsCard title="Not included — no evidence found">
          {notIncluded.length === 0 ? (
            <EmptyNote>No unsupported skill was identified for this posting.</EmptyNote>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {notIncluded.slice(0, 10).map((label) => (
                  <Chip key={label} tone="neutral">
                    {label}
                  </Chip>
                ))}
              </div>
              <p className="mt-2.5 text-[11px] leading-relaxed text-tertiary">
                The posting asked for these and your documents do not evidence them, so the writer was
                forbidden to claim them.
              </p>
            </>
          )}
        </WsCard>

        {/* 4 — experience prioritisation (no before/after is persisted; see the note above) */}
        <WsCard title="Experience prioritisation">
          {priority.length === 0 ? (
            <EmptyNote>No experience reordering was needed.</EmptyNote>
          ) : (
            <>
              <ol className="flex flex-col">
                {priority.slice(0, 5).map((e, i) => (
                  <li key={`${e.employer}-${i}`} className="flex items-start gap-2 py-[5px]">
                    <span
                      aria-hidden="true"
                      className="mt-px grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full bg-[var(--chip-bg)] text-[10px] font-bold text-[var(--chip-text)]"
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] text-primary">{e.employer}</span>
                      <span className="block truncate text-[11px] text-tertiary">
                        supports {e.overlapping.length}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-[11px] leading-relaxed text-tertiary">
                The order the writer was given. No previous ordering is recorded, so no before/after
                comparison is shown.
              </p>
            </>
          )}
        </WsCard>

        {/* 5 — reasons */}
        <WsCard title="Reasons for changes">
          {why.length === 0 ? (
            <EmptyNote>No tailoring has run for this job yet.</EmptyNote>
          ) : (
            <ul>
              {why.map((r) => (
                <BulletRow key={r} tick>
                  {r}
                </BulletRow>
              ))}
            </ul>
          )}
        </WsCard>
      </div>
    </div>
  );
}
