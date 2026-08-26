import type { ReusePolicy } from "@/lib/apply/questionTypes";

/**
 * How a remembered answer's reuse behavior is presented, and whether the candidate has any real
 * control over it.
 *
 * THE REAL MODEL, NOT A WISHED-FOR ONE. `ReusePolicy` (questionTypes.ts) has exactly three values,
 * fixed per QUESTION TYPE — not a per-answer, candidate-selectable scope. There is no "use for this
 * company only" or "use for this job only" anywhere in the engine: `saveAnswer`/`resolveAnswer` know
 * nothing about company or job at all, only candidate + canonical question. Presenting scope choices
 * that do not exist would be exactly the fabricated-functionality this phase was told to refuse.
 *
 * WHAT THE CANDIDATE CAN ACTUALLY CHANGE. Only one thing, and only for one policy: for an
 * `auto_after_approval` question, the stored `autoFillAllowed` flag decides whether Career-Ops may
 * type the saved value in without asking again. For `ask_each_time` and `never_auto`, the type's own
 * policy already decided the answer and no toggle changes it — resolveAnswer.ts never even reads
 * `auto_fill_allowed` unless the type is `auto_after_approval` in the first place.
 */

export interface ReusePolicyPresentation {
  /** The word shown next to the answer. Never the raw enum. */
  label: string;
  /** One sentence explaining the real consequence. */
  explanation: string;
  /** True only for auto_after_approval — the one policy the candidate's own toggle affects. */
  editable: boolean;
}

export function presentReusePolicy(policy: ReusePolicy, autoFillAllowed: boolean): ReusePolicyPresentation {
  if (policy === "auto_after_approval") {
    return autoFillAllowed
      ? {
          label: "Used automatically",
          explanation: "Career-Ops can use this answer without asking you again when this exact question appears.",
          editable: true,
        }
      : {
          label: "Ask me first",
          explanation: "Career-Ops can suggest this answer, but you decide before it is used.",
          editable: true,
        };
  }
  if (policy === "ask_each_time") {
    return {
      label: "Confirmed every time",
      explanation: "This kind of answer is offered as a suggestion and confirmed by you each time it could apply.",
      editable: false,
    };
  }
  /* never_auto — voluntary/demographic questions, and any other protected type. */
  return {
    label: "Always asked",
    explanation: "This is a voluntary question. Career-Ops never fills it in automatically — you decide each time.",
    editable: false,
  };
}
