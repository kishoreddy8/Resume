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

/** Placeholder per-tier pricing (USD per 1K tokens) — deliberately approximate, replace with real
 *  provider pricing once a vendor is chosen. Used only to compute estimated_cost_usd for usage
 *  logging after a call actually completes; the pre-call budget check below uses the fixed
 *  reservation ceiling above instead, since real per-token pricing is provider-specific and unknown
 *  until a vendor is chosen. */
const TIER_PRICING_USD_PER_1K_TOKENS: Record<ModelTier, { input: number; output: number }> = {
  lightweight: { input: 0.0002, output: 0.0006 },
  standard: { input: 0.003, output: 0.015 },
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
