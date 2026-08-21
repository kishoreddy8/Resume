"use client";

import type { TailoringPlan } from "@/lib/tailoringIntelligence/plan";
import { BulletRow, Chip, EmptyNote, StepSectionHeading, WsCard } from "./WorkspaceUI";

/**
 * Step 2 — Resume Studio, as four columns read across.
 *
 * IT IS A PLAN, NOT A RESULT. Nothing has been written yet at this point, so every card describes
 * what the writer will be told to do — drawn entirely from the persisted Tailoring Intelligence
 * plan, which itself re-reads the match result rather than evaluating anything. No model is called
 * to produce a single line on this screen.
 *
 * THE FOURTH CARD IS THE ONE THAT MATTERS. "What will be emphasised" is the plan's `emphasize`
 * list: requirements this candidate can genuinely evidence. Its counterpart, `doNotClaim`, is what
 * the writer is forbidden to introduce — shown on the same screen, because a plan that only shows
 * what it will add is half the truth about what it is going to do.
 */

/** The engine's own evidence state, in a candidate's words. */
function relevanceWords(overlapCount: number): { text: string; tone: "evidence" | "neutral" } {
  if (overlapCount >= 3) return { text: "High relevance", tone: "evidence" };
  if (overlapCount >= 1) return { text: "Some relevance", tone: "neutral" };
  return { text: "No overlap", tone: "neutral" };
}

/**
 * What the tailoring engine actually does, named from the plan it produced.
 *
 * Each line is conditional on the plan containing something for it to act on, so this never
 * promises a step the engine will not take for this particular job.
 */
function planSteps(plan: TailoringPlan): string[] {
  const out: string[] = [];
  if (plan.emphasize.length > 0) out.push("Lead with the requirements you can evidence");
  if (plan.employerEmphasis.length > 0) out.push("Order experience by how much of this job it supports");
  if (plan.sectionsAffected.length > 0)
    out.push(`Rewrite ${plan.sectionsAffected.length === 1 ? "the" : ""} ${plan.sectionsAffected.join(", ").toLowerCase()}`);
  if (plan.inventoryOnlyCount > 0)
    out.push(`Surface ${plan.inventoryOnlyCount} skill${plan.inventoryOnlyCount === 1 ? "" : "s"} declared in your inventory`);
  if (plan.doNotClaim.length > 0) out.push("Leave out anything your documents do not support");
  return out;
}

export function ResumeStudioStep({ plan }: { plan: TailoringPlan }) {
  const required = plan.requirements.filter((r) => r.requirementLevel === "Required");
  const preferred = plan.requirements.filter((r) => r.requirementLevel === "Preferred");
  const steps = planSteps(plan);

  if (plan.insufficientJdSignal || plan.requirements.length === 0) {
    return (
      <div>
        <StepSectionHeading title="Resume studio" />
        <WsCard title="No tailoring plan for this posting">
          <EmptyNote>
            {plan.insufficientJdSignal
              ? "The engine flagged this posting as carrying too little detail to evaluate, so there are no requirements to plan against. Anything shown here would be guesswork."
              : "This posting produced no extractable requirements."}
          </EmptyNote>
        </WsCard>
      </div>
    );
  }

  return (
    <div>
      <StepSectionHeading
        title="Resume studio"
        blurb="What JobHunt will emphasise before anything is written. Nothing has been generated yet."
      />

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        {/* 1 — job requirements */}
        <WsCard
          title="Job requirements"
          hint="Your resume will be tailored toward the requirements this posting actually states."
        >
          <div className="flex flex-col gap-3">
            {required.length > 0 && (
              <div>
                <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-tertiary">
                  Priority skills
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {required.slice(0, 10).map((r) => (
                    <Chip key={r.label} tone={r.state === "NONE" ? "neutral" : "evidence"}>
                      {r.label}
                    </Chip>
                  ))}
                </div>
              </div>
            )}
            {preferred.length > 0 && (
              <div>
                <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-tertiary">
                  Nice to have
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {preferred.slice(0, 8).map((r) => (
                    <Chip key={r.label} tone={r.state === "NONE" ? "neutral" : "evidence"}>
                      {r.label}
                    </Chip>
                  ))}
                </div>
              </div>
            )}
          </div>
        </WsCard>

        {/* 2 — your relevant experience */}
        <WsCard title="Your relevant experience">
          {plan.employerEmphasis.length === 0 ? (
            <EmptyNote>No recorded role overlaps this posting.</EmptyNote>
          ) : (
            <ul className="divide-y divide-[#F2F3F7] dark:divide-[var(--separator)]">
              {plan.employerEmphasis.slice(0, 5).map((e) => {
                const rel = relevanceWords(e.overlapping.length);
                return (
                  <li key={`${e.employer}-${e.title}`} className="py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[12.5px] font-semibold text-primary">{e.employer}</span>
                      <span
                        className={`shrink-0 text-[11px] font-medium ${
                          rel.tone === "evidence" ? "text-[var(--pill-success-fg)]" : "text-tertiary"
                        }`}
                      >
                        {rel.text}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-tertiary">{e.title}</div>
                    <div className="mt-0.5 text-[11px] text-tertiary">
                      Supports {e.overlapping.length} of this job&apos;s requirements
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </WsCard>

        {/* 3 — tailoring plan */}
        <WsCard title="Tailoring plan">
          {steps.length === 0 ? (
            <EmptyNote>There is nothing this posting calls for that your documents support.</EmptyNote>
          ) : (
            <ol className="flex flex-col">
              {steps.map((s, i) => (
                <li key={s} className="flex items-start gap-2 py-[5px]">
                  <span
                    aria-hidden="true"
                    className="mt-px grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full bg-[var(--accent-tint)] text-[10px] font-bold text-[var(--accent)]"
                  >
                    {i + 1}
                  </span>
                  <span className="text-[12.5px] leading-relaxed text-secondary">{s}</span>
                </li>
              ))}
            </ol>
          )}
        </WsCard>

        {/* 4 — what will be emphasised */}
        <WsCard tone="warm" title="What will be emphasised">
          {plan.emphasize.length === 0 ? (
            <EmptyNote>Nothing in this posting is supported by your documents.</EmptyNote>
          ) : (
            <ul>
              {plan.emphasize.slice(0, 6).map((r) => (
                <BulletRow key={r.label} tick>
                  {r.label}
                  {r.employers.length > 0 && (
                    <span className="text-tertiary"> — {r.employers.slice(0, 2).join(", ")}</span>
                  )}
                </BulletRow>
              ))}
            </ul>
          )}
          {plan.doNotClaim.length > 0 && (
            <div className="mt-3 border-t border-[#F0E6D2] pt-2.5 dark:border-[var(--separator)]">
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-tertiary">
                Will not be claimed
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-tertiary">
                {plan.doNotClaim.slice(0, 6).map((r) => r.label).join(", ")}
              </p>
            </div>
          )}
        </WsCard>
      </div>
    </div>
  );
}
