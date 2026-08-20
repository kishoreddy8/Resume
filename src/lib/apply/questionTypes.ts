/**
 * The vocabulary of application questions, and the policy attached to each kind.
 *
 * Policy lives with the type rather than being decided at fill time, so "may this be typed into a
 * form unattended" has exactly one answer per kind of question and cannot drift between callers.
 */

export type QuestionType =
  | "identity"
  | "contact"
  | "work_authorization"
  | "sponsorship"
  | "relocation"
  | "salary"
  | "education"
  | "experience"
  | "availability"
  | "employment_history"
  | "open_ended"
  | "voluntary_demographic"
  | "security_clearance"
  | "other";

/**
 * `normal` — an ordinary factual field.
 * `sensitive` — salary and similar: stable enough to store, consequential enough to confirm.
 * `protected` — voluntary demographic questions. Never inferred, never derived, never drafted.
 */
export type Sensitivity = "normal" | "sensitive" | "protected";

/**
 * `auto_after_approval` — once the user approves it, it may be filled unattended.
 * `ask_each_time`      — a stored answer is offered as a suggestion; the user confirms every use.
 * `never_auto`         — only an explicit saved response is ever used, and only if one exists.
 */
export type ReusePolicy = "auto_after_approval" | "ask_each_time" | "never_auto";

export interface QuestionPolicy {
  type: QuestionType;
  sensitivity: Sensitivity;
  reusePolicy: ReusePolicy;
}

/**
 * The default policy for each type.
 *
 * Open-ended answers are `ask_each_time` because reusing prose written for another company is how
 * a tailored application quietly becomes a generic one — the text is not wrong, it is just no
 * longer about this job.
 *
 * Voluntary demographic questions are `never_auto` AND `protected`. Nothing in this system may
 * derive a protected characteristic from a resume or profile; only an answer the user typed
 * themselves is ever available, and its absence is a perfectly good outcome.
 */
export const DEFAULT_POLICY: Record<QuestionType, QuestionPolicy> = {
  identity: { type: "identity", sensitivity: "normal", reusePolicy: "auto_after_approval" },
  contact: { type: "contact", sensitivity: "normal", reusePolicy: "auto_after_approval" },
  work_authorization: { type: "work_authorization", sensitivity: "normal", reusePolicy: "auto_after_approval" },
  sponsorship: { type: "sponsorship", sensitivity: "normal", reusePolicy: "auto_after_approval" },
  relocation: { type: "relocation", sensitivity: "normal", reusePolicy: "auto_after_approval" },
  salary: { type: "salary", sensitivity: "sensitive", reusePolicy: "ask_each_time" },
  education: { type: "education", sensitivity: "normal", reusePolicy: "auto_after_approval" },
  experience: { type: "experience", sensitivity: "normal", reusePolicy: "ask_each_time" },
  availability: { type: "availability", sensitivity: "normal", reusePolicy: "ask_each_time" },
  employment_history: { type: "employment_history", sensitivity: "normal", reusePolicy: "auto_after_approval" },
  open_ended: { type: "open_ended", sensitivity: "normal", reusePolicy: "ask_each_time" },
  voluntary_demographic: { type: "voluntary_demographic", sensitivity: "protected", reusePolicy: "never_auto" },
  security_clearance: { type: "security_clearance", sensitivity: "sensitive", reusePolicy: "ask_each_time" },
  other: { type: "other", sensitivity: "normal", reusePolicy: "ask_each_time" },
};

/**
 * Where a value came from. A field may only be filled when its source is one of these — an unknown
 * provenance is not a value, it is a question for the user.
 */
export type AnswerSource =
  | "PROFILE"
  | "MASTER_RESUME"
  | "MSI"
  | "VALIDATED_CANDIDATE_PROFILE"
  | "APPLICATION_ANSWER_VAULT"
  | "USER_INTERVENTION"
  | "APPROVED_CLAUDE_DRAFT";

export const FILLABLE_SOURCES: readonly AnswerSource[] = [
  "PROFILE",
  "MASTER_RESUME",
  "MSI",
  "VALIDATED_CANDIDATE_PROFILE",
  "APPLICATION_ANSWER_VAULT",
  "USER_INTERVENTION",
  "APPROVED_CLAUDE_DRAFT",
];
