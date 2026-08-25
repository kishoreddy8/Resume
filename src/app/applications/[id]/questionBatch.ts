/**
 * UI-0 DEFECT 4 — Human Question Center batch submission logic.
 *
 * THE BUG THIS REPLACES. `allAnswered` gated "Save Answers & Continue" on EVERY question having a
 * non-empty value, ignoring `q.required` entirely. On a real Workday run (Run 20: 2 required + 4
 * optional questions) this made the button impossible to enable without typing something into
 * Address Line 2, County and Phone Extension — inventing values for fields the employer marked
 * optional, which is exactly the fabrication Career-Ops exists to refuse.
 *
 * THE SECOND, LESS VISIBLE BUG. `onSave` built one `{ id, answer, reuseForEquivalentQuestions }`
 * entry per question, including `answer: ""` for every unanswered optional one. The server's own
 * `BatchAnswer` zod schema requires `answer: z.string().trim().min(1)`, so even after fixing the
 * button's gating alone, submitting would still 400 on the first optional question left blank. The
 * fix is therefore not "allow blanks through" — it is "never send a blank in the first place":
 * skipped optional questions are omitted from the submission entirely, so nothing blank is ever
 * transmitted, validated, or reachable by `saveAnswer` as a reusable vault entry.
 *
 * PURE ON PURPOSE. No jsdom/component-rendering harness exists in this repository (see
 * questionUiControls.test.ts) — this logic is extracted so it can be proven correct with plain
 * node:test assertions instead of only by reading the JSX.
 */

export interface BatchQuestionLike {
  id: string;
  required: boolean;
}

export interface BatchAnswerSubmission {
  id: string;
  answer: string;
  reuseForEquivalentQuestions: boolean;
}

/** Trimmed, non-empty — the same notion of "answered" the form control itself uses. */
function isAnswered(answers: Record<string, string>, questionId: string): boolean {
  return (answers[questionId]?.trim() ?? "").length > 0;
}

/**
 * Does this batch satisfy everything it MUST before saving? Required questions must be answered.
 * Optional ones may be left blank — the employer itself did not require them, and Career-Ops must
 * not require more than the employer does.
 */
export function requiredQuestionsSatisfied(questions: readonly BatchQuestionLike[], answers: Record<string, string>): boolean {
  return questions.filter((q) => q.required).every((q) => isAnswered(answers, q.id));
}

/**
 * What actually gets sent to the server. Only questions with a real, non-empty answer are
 * included — a skipped optional question is simply absent, never sent as `""`, never fabricated,
 * and therefore never at risk of being persisted as a reusable answer.
 */
export function buildAnswerSubmission(
  questions: readonly BatchQuestionLike[],
  answers: Record<string, string>,
  reuse: Record<string, boolean>
): BatchAnswerSubmission[] {
  return questions
    .filter((q) => isAnswered(answers, q.id))
    .map((q) => ({
      id: q.id,
      answer: answers[q.id]!.trim(),
      reuseForEquivalentQuestions: reuse[q.id] ?? false,
    }));
}
