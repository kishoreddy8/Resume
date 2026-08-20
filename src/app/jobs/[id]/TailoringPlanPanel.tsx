"use client";

import { motion, useReducedMotion } from "motion/react";
import type { TailoringPlan, PlanRequirement, EvidenceState } from "@/lib/tailoringIntelligence/plan";
import { EVIDENCE_STATE_LABEL } from "@/lib/tailoringIntelligence/plan";

/**
 * Why this resume will be tailored the way it will be.
 *
 * WHAT THIS ANSWERS. What the job asks for, what the candidate can actually evidence, what should
 * be led with, what must not be claimed, and which employers carry the weight for THIS job. Until
 * now that reasoning existed only inside the writer handoff — computed, used, and never shown — so
 * approving tailoring meant approving something you could not inspect.
 *
 * EVERY VALUE IS READ, NOT DERIVED HERE. The states come from the deterministic Phase 2 engine's
 * own buckets and the employer overlap is a count over them. There is no score, no percentage, no
 * confidence meter and no ranking of the candidate: the vocabulary is exactly the five states the
 * engine distinguishes, and "no evidence found" is a statement about the documents, never about the
 * person.
 *
 * THIS IS GUIDANCE, NOT A DECISION. The existing tailoring engine, resume writer and deterministic
 * validators remain the authority — the panel says so on screen, because a plan that looks like a
 * verdict invites people to trust it over the gate that actually protects them.
 */

const STATE_STYLE: Record<EvidenceState, { dot: string; text: string }> = {
  STRONG: { dot: "bg-[var(--success)]", text: "text-[var(--success)]" },
  PARTIAL: { dot: "bg-[var(--warning)]", text: "text-[var(--warning)]" },
  MENTIONED: { dot: "bg-transparent ring-1 ring-inset ring-[var(--warning)]", text: "text-secondary" },
  NONE: { dot: "bg-transparent ring-1 ring-inset ring-[var(--border)]", text: "text-tertiary" },
  UNKNOWN: { dot: "bg-transparent ring-1 ring-inset ring-[var(--border)]", text: "text-tertiary" },
};

function RequirementRow({ r }: { r: PlanRequirement }) {
  const style = STATE_STYLE[r.state];
  const sources: string[] = [];
  if (r.employers.length > 0) sources.push(r.employers.join(", "));
  if (r.inventoryOnly) sources.push("Skills Inventory only — no employer attribution");
  if (r.transferableReason) sources.push(r.transferableReason);
  if (typeof r.yearsStated === "number") sources.push(`${r.yearsStated}y stated`);

  return (
    <li className="flex gap-2.5 py-1.5">
      <span aria-hidden="true" className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[12.5px] text-primary">{r.label}</span>
          {/* The state is a WORD, so nothing depends on the dot's colour. */}
          <span className={`text-[10.5px] ${style.text}`}>{EVIDENCE_STATE_LABEL[r.state]}</span>
          <span className="text-[10px] uppercase tracking-[0.07em] text-tertiary">{r.requirementLevel}</span>
        </div>
        {sources.length > 0 && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-tertiary">{sources.join(" · ")}</p>
        )}
      </div>
    </li>
  );
}

function Block({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">{title}</h3>
      {note && <p className="mt-1 text-[11px] leading-relaxed text-tertiary">{note}</p>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

export function TailoringPlanPanel({ plan }: { plan: TailoringPlan }) {
  const reduced = useReducedMotion() ?? false;

  if (plan.insufficientJdSignal || plan.requirements.length === 0) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] px-3.5 py-3">
        <p className="text-[12.5px] text-secondary">No tailoring plan for this posting.</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-tertiary">
          {plan.insufficientJdSignal
            ? "The engine flagged this posting as carrying too little detail to evaluate, so there are no requirements to plan against. Anything shown here would be guesswork."
            : "This posting produced no extractable requirements."}
        </p>
      </div>
    );
  }

  const emphasize = plan.emphasize.slice(0, 12);
  const doNotClaim = plan.doNotClaim.slice(0, 12);

  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0.12 } : { type: "spring", duration: 0.34, bounce: 0 }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Block
          title="Lead with this"
          note="Requirements this candidate can evidence, Required before Preferred."
        >
          <ul className="divide-y divide-[var(--separator)]">
            {emphasize.map((r) => (
              <RequirementRow key={`e-${r.label}`} r={r} />
            ))}
          </ul>
          {plan.emphasize.length > emphasize.length && (
            <p className="mt-1.5 text-[11px] text-tertiary">
              +{plan.emphasize.length - emphasize.length} more evidenced requirements.
            </p>
          )}
        </Block>

        <Block
          title="Do not claim"
          note="Nothing in the candidate's documents supports these. The writer must not introduce them, and the validators reject a resume that does."
        >
          {doNotClaim.length === 0 ? (
            <p className="text-[12px] text-tertiary">
              Every requirement this posting states has some evidence behind it.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--separator)]">
              {doNotClaim.map((r) => (
                <RequirementRow key={`d-${r.label}`} r={r} />
              ))}
            </ul>
          )}
          {plan.doNotClaim.length > doNotClaim.length && (
            <p className="mt-1.5 text-[11px] text-tertiary">
              +{plan.doNotClaim.length - doNotClaim.length} more with no evidence.
            </p>
          )}
        </Block>
      </div>

      {plan.employerEmphasis.length > 0 && (
        <Block
          title="Experience to emphasize"
          note="Ordered by how many of this job's evidenced requirements each role already supports — a count over the engine's output, not a judgement of the role."
        >
          <ol className="flex flex-col gap-2">
            {plan.employerEmphasis.map((e, i) => (
              <li key={e.employer} className="rounded-[var(--radius-lg)] border border-[var(--border)] px-3 py-2.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[11px] tabular-nums text-tertiary">{i + 1}</span>
                  <span className="text-[12.5px] font-medium text-primary">{e.employer}</span>
                  <span className="text-[11px] text-tertiary">{e.title}</span>
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-secondary">
                  {e.overlapping.length > 0 ? (
                    <>
                      Supports {e.overlapping.length} of this job&rsquo;s requirements:{" "}
                      <span className="text-tertiary">{e.overlapping.join(", ")}</span>
                    </>
                  ) : (
                    <span className="text-tertiary">
                      Supports none of this job&rsquo;s stated requirements — no reason to lead with it here.
                    </span>
                  )}
                </p>
                {e.notEvidencedHere.length > 0 && (
                  <p className="mt-1 text-[11px] leading-relaxed text-tertiary">
                    <span className="text-secondary">Never attribute to {e.employer}: </span>
                    {e.notEvidencedHere.slice(0, 8).join(", ")}
                    {e.notEvidencedHere.length > 8 ? ` +${e.notEvidencedHere.length - 8} more` : ""}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </Block>
      )}

      {plan.sectionsAffected.length > 0 && (
        <Block title="Sections this would touch">
          <ul className="flex flex-wrap gap-1.5">
            {plan.sectionsAffected.map((s) => (
              <li
                key={s}
                className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[11.5px] text-secondary"
              >
                {s}
              </li>
            ))}
          </ul>
        </Block>
      )}

      <p className="rounded-[var(--radius-lg)] border border-[var(--border)] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-tertiary">
        <span className="font-medium text-secondary">This plan is guidance, not a decision. </span>
        The existing tailoring engine and resume writer choose the final wording, and the
        deterministic validators decide whether the result may be delivered at all. Where this plan
        and a validator disagree, the validator wins.
        {plan.inventoryOnlyCount > 0 && (
          <>
            {" "}
            {plan.inventoryOnlyCount} skill{plan.inventoryOnlyCount === 1 ? " is" : "s are"} listed in the Skills
            Inventory with no employer attribution — they may be listed as capabilities, never presented as work
            performed at a named employer.
          </>
        )}
      </p>
    </motion.div>
  );
}
