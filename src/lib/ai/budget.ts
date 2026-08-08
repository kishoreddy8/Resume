import { getAiUsageSummary, toSqliteUtcTimestamp } from "@/db/queries/aiUsage";
import type { ModelTier } from "./types";

/**
 * Deliberately hardcoded constants for this phase, not a Settings field — same reasoning as
 * confidence.ts's thresholds: settings.ts's closed, fixed-group schema design isn't a good fit for
 * an open-ended per-task concern. Promote to Settings later only if a real UI need appears.
 *
 * Three independently-enforced limit types (see checkBudget below):
 *  - call-count (session): exact.
 *  - dollar (daily/monthly): conservative, via a pre-call reservation — see below.
 *  - token limits: NOT enforced in this phase. A real per-call token count, like real dollar cost,
 *    is only known after a response returns; enforcing a token budget pre-call would need the exact
 *    same reservation approach as the dollar caps below (a rough pre-call token estimate from prompt
 *    length compared to a remaining-token budget). Deferred until a concrete need for it exists.
 */
export const BUDGET_LIMITS = {
  perSessionCalls: 50,
  dailyUsd: 1.0,
  monthlyUsd: 15.0,
} as const;

/**
 * Deliberately pessimistic ceiling for a single call at each tier — the "reservation" checked
 * against the dollar caps BEFORE a call is made. Set high enough that a real call is expected to
 * cost meaningfully less, so a configured hard cap is enforced conservatively (blocking a little
 * early) rather than being exceeded by an unbounded amount. Real spend already logged always takes
 * precedence for the NEXT call's check — this reservation is a pre-call arithmetic guard only, never
 * persisted as separate "pending spend" state.
 */
export const TIER_MAX_COST_RESERVATION_USD: Record<ModelTier, number> = {
  lightweight: 0.01,
  standard: 0.1,
};

/**
 * Per-tier OpenAI pricing (USD per 1K tokens), standard short-context rate — GPT-5.6 family.
 *
 * SOURCE: OpenAI official API docs (developers.openai.com/api/docs/pricing and the dedicated
 *   /api/docs/models/gpt-5.6-luna and /api/docs/models/gpt-5.6-terra model pages — platform.openai.com
 *   redirects to developers.openai.com as of this writing).
 * DATE VERIFIED: 2026-08-08.
 * These are OPERATIONAL CONFIGURATION, not architecture — OpenAI can change them at any time.
 * Re-verify against the official docs before trusting budget enforcement long-term.
 *
 * Cached-input pricing exists (Luna $0.02/1M, Terra $0.20/1M) but is deliberately NOT modeled in
 * V1 — every input token is charged at the full (non-cached) rate below, per the standing V1
 * decision to conservatively overestimate spend rather than track the cached/uncached split.
 *
 * Both models also carry a long-context multiplier (2x input / 1.5x output) above 272K input
 * tokens per request, per the same official pages — also NOT modeled here. Enrich-with-AI requests
 * (a bounded JD + summary, well under that threshold by design — see
 * src/lib/ai/tasks/jobDetailEnrichment.ts's PROVIDER_INPUT_CHAR_BUDGET) never approach it, so using
 * the standard rate unconditionally is correct for this feature; a future task with much larger
 * inputs would need its own accounting, not silently inherit this estimate.
 *
 * V1 also intentionally uses only STANDARD API processing — Fast/Priority/Regional processing
 * tiers (if OpenAI offers them) are never opted into, so no alternate pricing tier applies here.
 */
const TIER_PRICING_USD_PER_1K_TOKENS: Record<ModelTier, { input: number; output: number }> = {
  lightweight: { input: 0.0002, output: 0.0012 }, // Luna: $0.20/1M in, $1.20/1M out
  standard: { input: 0.002, output: 0.012 }, // Terra: $2.00/1M in, $12.00/1M out
};

export function estimateCostUsd(tier: ModelTier, inputTokens: number, outputTokens: number): number {
  const pricing = TIER_PRICING_USD_PER_1K_TOKENS[tier];
  return (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;
}

// In-process only — resets on restart, by design (a "session" is this process's lifetime, not a
// calendar window; daily/monthly limits below are the calendar-window checks and are DB-backed).
let sessionCallCount = 0;

/** Counts only real provider-call ATTEMPTS (calls that pass every pre-check and reach the provider)
 *  — a cache hit costs nothing and is the whole point of caching, so it never counts against a
 *  call-count budget. Called by runAiTask.ts immediately before calling the provider. */
export function recordSessionCall(): void {
  sessionCallCount += 1;
}

/** Test-only reset. Real app code never calls this. */
export function resetSessionCallCountForTests(): void {
  sessionCallCount = 0;
}

export function getSessionCallCountForTests(): number {
  return sessionCallCount;
}

export type BudgetCheckResult = { allowed: true } | { allowed: false };

// Exported (pure date math, nothing sensitive) so tests can compute "room already used in the
// current window" the same way checkBudget does, rather than assuming a clean-slate DB — see
// src/lib/ai/__tests__/budget.test.ts. Both return SQLite-comparable strings (via
// toSqliteUtcTimestamp), NOT raw ISO strings — see that function's doc comment for why a plain
// Date.toISOString() would silently miscompare against created_at.
export function startOfDayIso(now: Date): string {
  return toSqliteUtcTimestamp(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
}

export function startOfMonthIso(now: Date): string {
  return toSqliteUtcTimestamp(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
}

/**
 * Checked before every provider call (see runAiTask.ts). Nothing here makes a network call or
 * depends on one — it's arithmetic over BUDGET_LIMITS and real spend already logged in
 * ai_usage_log (see src/db/queries/aiUsage.ts's getAiUsageSummary, which sums real cost from every
 * outcome including schema-validation failures — a failed call still consumed real tokens).
 */
export function checkBudget(tier: ModelTier, now: Date = new Date()): BudgetCheckResult {
  if (sessionCallCount >= BUDGET_LIMITS.perSessionCalls) return { allowed: false };

  const reservation = TIER_MAX_COST_RESERVATION_USD[tier];

  const daily = getAiUsageSummary(startOfDayIso(now));
  if (daily.totalCostUsd + reservation > BUDGET_LIMITS.dailyUsd) return { allowed: false };

  const monthly = getAiUsageSummary(startOfMonthIso(now));
  if (monthly.totalCostUsd + reservation > BUDGET_LIMITS.monthlyUsd) return { allowed: false };

  return { allowed: true };
}
