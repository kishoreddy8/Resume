import { DEFAULT_POLICY, type AnswerSource, type QuestionType } from "./questionTypes";

/**
 * Whether a stored answer may be used for a field right now, and how.
 *
 * THREE OUTCOMES, AND ONLY THREE. Fill it, suggest it and wait, or ask the user. There is no
 * "probably fine" — a field this system is unsure about is a field a human looks at, because the
 * output is a real application sent under the user's name.
 */

export type Resolution =
  /** Safe to type without further confirmation. */
  | { action: "fill"; value: string; source: AnswerSource }
  /** A stored value exists but this kind of question is confirmed every time. */
  | { action: "suggest"; value: string; source: AnswerSource; reason: string }
  /** Nothing usable. The run pauses and the user is asked. */
  | { action: "ask"; reason: string };

export interface StoredAnswer {
  answer_value: string;
  answer_source: AnswerSource;
  approved_by_user: 0 | 1;
  auto_fill_allowed: 0 | 1;
}

/**
 * Precedence, highest first:
 *   1. an explicit answer the user approved
 *   2. an older stored answer, offered as a suggestion
 *   3. nothing — ask
 *
 * A model draft never outranks anything the user typed, and never fills unattended: an
 * APPROVED_CLAUDE_DRAFT is only ever "approved" because a human read it and said so, and even then
 * only for the question it was written for.
 */
export function resolveAnswer(questionType: QuestionType, stored: StoredAnswer | undefined): Resolution {
  const policy = DEFAULT_POLICY[questionType];

  if (!stored) {
    return {
      action: "ask",
      reason:
        policy.sensitivity === "protected"
          ? "This is a voluntary demographic question. Career-Ops never infers an answer — supply one or leave it blank."
          : "No saved answer for this question.",
    };
  }

  if (policy.reusePolicy === "never_auto") {
    /* Protected questions: an explicitly saved response may be offered, never typed unattended, and
     * never derived from anything in the profile. */
    return {
      action: "suggest",
      value: stored.answer_value,
      source: stored.answer_source,
      reason: "Voluntary question — your saved response is offered, never filled automatically.",
    };
  }

  if (!stored.approved_by_user) {
    return {
      action: "suggest",
      value: stored.answer_value,
      source: stored.answer_source,
      reason: "This answer has not been approved yet.",
    };
  }

  if (policy.reusePolicy === "ask_each_time" || !stored.auto_fill_allowed) {
    return {
      action: "suggest",
      value: stored.answer_value,
      source: stored.answer_source,
      reason:
        policy.reusePolicy === "ask_each_time"
          ? "This kind of answer is confirmed each time it is used."
          : "Approved, but not marked for unattended reuse.",
    };
  }

  return { action: "fill", value: stored.answer_value, source: stored.answer_source };
}

/**
 * The last gate before anything is typed.
 *
 * A field may only be filled when its provenance is one this system recognises. An unknown source
 * is not a value to be salvaged — it is a question for the user.
 */
export function mayFill(source: AnswerSource | null | undefined): boolean {
  if (!source) return false;
  return (
    source === "PROFILE" ||
    source === "MASTER_RESUME" ||
    source === "MSI" ||
    source === "VALIDATED_CANDIDATE_PROFILE" ||
    source === "APPLICATION_ANSWER_VAULT" ||
    source === "USER_INTERVENTION" ||
    source === "APPROVED_CLAUDE_DRAFT"
  );
}
