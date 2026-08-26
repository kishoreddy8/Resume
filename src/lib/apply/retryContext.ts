import { getMostRecentFailedRun } from "@/db/queries/applicationRuns";
import { DEFAULT_POLICY, type QuestionType } from "./questionTypes";
import type { RunApprovedAnswer } from "./agent/types";
import type { ExecutionCheckpoint } from "./engine/executor";

/**
 * PHASE 9E RETRY HARDENING — carrying a user's already-approved answers forward from a terminally
 * FAILED run into a fresh retry of the SAME application, without reviving the FAILED run itself.
 *
 * WHY THIS IS NOT THE ANSWER VAULT. The persistent Answer Vault (applicationVault.ts) exists to
 * reuse a canonical answer ACROSS different applications, gated by `auto_fill_allowed` and the
 * candidate's own approval. RETRY_CONTEXT is narrower and stays entirely within one application: it
 * only ever looks at the immediately-prior FAILED attempt at THIS EXACT (candidate, job) pair, and
 * only to save the user from re-answering questions they answered minutes or hours ago for THIS
 * SAME FORM. Nothing here is written to `application_answers`, nothing is promoted to global reuse,
 * and nothing here changes what "ask-each-time" means for any OTHER application.
 *
 * WHY THIS NEEDS NO NEW REVALIDATION LOGIC. Carried-forward answers are seeded into the new run's
 * `checkpoint.runAnswers` — the exact same field `findRunApprovedAnswer` (planFields.ts) already
 * consults for a same-run answer, and that function already refuses to apply an answer whose value
 * is no longer among the field's current options, falling back to `ask` instead (see
 * "Saved answer is no longer one of the options offered by this form"). Seeding through the same
 * field means every existing option/control revalidation applies automatically and is proven by the
 * existing RUNANS-EXEC-01/02 tests — this module only decides WHICH answers are eligible to seed.
 *
 * WHY FAILED STAYS FAILED. This module never writes to the FAILED run. It only reads it.
 */

export interface RetryCarryForward {
  priorRunId: number;
  /** Every USER_INTERVENTION answer found in the prior run's checkpoint. */
  eligibleCount: number;
  /** How many passed policy and were actually seeded into the new run. */
  carriedCount: number;
  /** eligibleCount - carriedCount — excluded by never_auto/protected policy or secret-shaped label. */
  excludedForPolicyCount: number;
  /** Ready to seed directly into a fresh ExecutionCheckpoint's `runAnswers`. */
  answers: Record<string, RunApprovedAnswer>;
}

/**
 * Defence in depth only. No password, OTP, or session-token value can structurally reach
 * `checkpoint.runAnswers` in the first place — password inputs are excluded from field discovery
 * (see fieldDiscovery.ts), and nothing else in this codebase ever writes a secret into a
 * RunApprovedAnswer. This keyword check exists so that fact remains true even if a future adapter
 * or question ever slipped past that exclusion — it is a second, independent gate, not the only one.
 */
const SECRET_SHAPED_LABEL = /\b(password|passcode|pin\s*code|one[\s-]?time\s*(code|password)|\botp\b|verification\s*code|security\s*code|cvv|ssn|social\s*security)\b/i;

/**
 * Does existing policy permit this answer to be replayed even within the SAME application's retry?
 *
 * ONLY `never_auto` (today, exactly `voluntary_demographic`) is excluded. `ask_each_time` questions
 * (salary, experience, availability, open-ended text, "other") are NOT excluded here: that policy
 * governs reuse ACROSS different applications ("do not silently copy this answer onto a different
 * job"), which is a different question from "may the user's answer to THIS form, approved minutes
 * ago, survive a technical retry of THIS SAME form". Sensitivity is checked independently of
 * reusePolicy as a second, explicit gate — today the two always agree (protected implies
 * never_auto), but that must not be assumed to hold forever without being asked directly.
 */
export function isRetryEligible(answer: RunApprovedAnswer): boolean {
  if (SECRET_SHAPED_LABEL.test(answer.label)) return false;
  const policy = DEFAULT_POLICY[(answer.questionType ?? "other") as QuestionType] ?? DEFAULT_POLICY.other;
  if (policy.reusePolicy === "never_auto") return false;
  if (policy.sensitivity === "protected") return false;
  return true;
}

/**
 * Pure filter over an already-fetched checkpoint — no database access, so this is directly
 * unit-testable. `priorRunAnswersForRetry` below is the only caller that touches the database.
 */
export function carryForwardApprovedRunAnswers(
  priorRunId: number,
  checkpoint: ExecutionCheckpoint | null
): RetryCarryForward {
  const all = Object.values(checkpoint?.runAnswers ?? {});
  /* runAnswers stores the SAME RunApprovedAnswer object under up to three keys (id, selector,
   * label) — see the batch-answer route. De-duplicate by questionId before counting or seeding,
   * or "6 answers" would be reported and carried forward as 18. */
  const byQuestionId = new Map<string, RunApprovedAnswer>();
  for (const answer of all) byQuestionId.set(answer.questionId, answer);
  const unique = [...byQuestionId.values()];

  const answers: Record<string, RunApprovedAnswer> = {};
  let carriedCount = 0;
  for (const answer of unique) {
    if (!isRetryEligible(answer)) continue;
    answers[answer.questionId] = answer;
    answers[answer.selector] = answer;
    answers[answer.label] = answer;
    carriedCount++;
  }

  return {
    priorRunId,
    eligibleCount: unique.length,
    carriedCount,
    excludedForPolicyCount: unique.length - carriedCount,
    answers,
  };
}

/**
 * The one function the start-run route calls. Looks up the most recent FAILED run for this exact
 * (candidate, job) pair and returns what may safely be carried forward — or null if there is no
 * prior FAILED run to retry from, which is the ordinary case for a first attempt at any job.
 */
export function priorRunAnswersForRetry(candidateId: number, dedupeKey: string): RetryCarryForward | null {
  const prior = getMostRecentFailedRun(candidateId, dedupeKey);
  if (!prior) return null;

  let checkpoint: ExecutionCheckpoint | null = null;
  try {
    checkpoint = prior.checkpoint_json ? (JSON.parse(prior.checkpoint_json) as ExecutionCheckpoint) : null;
  } catch {
    checkpoint = null;
  }

  const result = carryForwardApprovedRunAnswers(prior.id, checkpoint);
  if (result.eligibleCount === 0) return null;
  return result;
}
