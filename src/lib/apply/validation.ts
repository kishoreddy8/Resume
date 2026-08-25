import { unresolvedRequired } from "./agent/planFields";
import type { FieldPlan, BlockingCondition } from "./agent/types";
import type { AuthOutcome } from "./auth";

/**
 * PHASE 9D — the deterministic readiness gate, as a pure inspection layer over what the engine has
 * already decided.
 *
 * THIS DOES NOT DECIDE ANYTHING NEW. `executeRun` already computes exactly this readiness inline
 * (a set of "ask" plans means WAITING_FOR_ANSWER; none means READY_FOR_REVIEW) — this module gives
 * that same computation a typed, inspectable shape so it can be reported to a caller (an API route,
 * a future dashboard) without duplicating the executor's own control flow, and without becoming a
 * second place that could disagree with it.
 *
 * VALIDATION IS NOT SUBMISSION AUTHORIZATION. `readyForReview` answers "is there anything left to
 * ask the user before this can be reviewed", never "may this be submitted" — that remains the
 * separate, explicit `WAITING_FOR_SUBMIT_APPROVAL` → `SUBMITTING` boundary in `runState.ts`.
 */

export interface ApplicationValidationReport {
  requiredFieldCount: number;
  filledCount: number;
  userAnsweredCount: number;
  unresolvedRequired: { question: string; reason: string }[];
  unresolvedOptional: { question: string; reason: string }[];
  /** "ask" plans whose reason names an incompatible saved/current-option mismatch — the exact
   *  option-guard and vault-staleness messages planFields already produces. */
  incompatibleSavedAnswers: { question: string; reason: string }[];
  documentReady: boolean;
  authReady: boolean;
  blockingCondition: BlockingCondition | null;
  /** 1-based, present only for a multi-page run — mirrors `ExecutionCheckpoint.page`. */
  page: number | undefined;
  /** True only when nothing required is unresolved, no document is missing, auth is settled, and
   *  no blocking condition is active. This is READY_FOR_REVIEW's own criterion, not a new one. */
  readyForReview: boolean;
}

const INCOMPATIBLE_REASON_MARKERS = [
  "not one of the options",
  "no longer one of the options",
  "no longer an exact option",
  "does not map unambiguously",
];

function isIncompatibleAnswerReason(reason: string): boolean {
  return INCOMPATIBLE_REASON_MARKERS.some((marker) => reason.includes(marker));
}

export function buildValidationReport(input: {
  plans: FieldPlan[];
  documentReady: boolean;
  /** Present only while auth is mid-flow; absent (or a proceeding outcome) means auth is settled. */
  authOutcome?: AuthOutcome;
  blockingCondition?: BlockingCondition | null;
  page?: number;
}): ApplicationValidationReport {
  const { plans } = input;

  const requiredFieldCount = plans.filter((p) => p.field.required).length;
  const filledCount = plans.filter((p) => p.action === "fill" && p.source !== "USER_INTERVENTION").length;
  const userAnsweredCount = plans.filter((p) => p.action === "fill" && p.source === "USER_INTERVENTION").length;

  const asks = plans.filter((p): p is Extract<FieldPlan, { action: "ask" }> => p.action === "ask");
  const toEntry = (p: Extract<FieldPlan, { action: "ask" }>) => ({ question: p.question, reason: p.reason });

  const unresolvedReq = unresolvedRequired(plans)
    .filter((p): p is Extract<FieldPlan, { action: "ask" }> => p.action === "ask")
    .map(toEntry);
  const unresolvedOpt = asks.filter((p) => !p.field.required).map(toEntry);
  const incompatible = asks.filter((p) => isIncompatibleAnswerReason(p.reason)).map(toEntry);

  const authReady = input.authOutcome === undefined || input.authOutcome === "AUTHENTICATED" || input.authOutcome === "ACCOUNT_CREATED" || input.authOutcome === "NO_AUTH_REQUIRED";
  const blockingCondition = input.blockingCondition ?? null;

  const readyForReview = unresolvedReq.length === 0 && input.documentReady && authReady && blockingCondition === null;

  return {
    requiredFieldCount,
    filledCount,
    userAnsweredCount,
    unresolvedRequired: unresolvedReq,
    unresolvedOptional: unresolvedOpt,
    incompatibleSavedAnswers: incompatible,
    documentReady: input.documentReady,
    authReady,
    blockingCondition,
    page: input.page,
    readyForReview,
  };
}
