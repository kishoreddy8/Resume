import { getDb } from "@/db";
import type { AiErrorCategory } from "@/lib/ai/errors";

export interface RecordAiUsageInput {
  task: string;
  provider: string | null;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  cacheHit: boolean;
  success: boolean;
  errorCategory: AiErrorCategory | null;
  latencyMs: number | null;
}

/** Append-only — one row per orchestration attempt, every outcome (see src/lib/ai/runAiTask.ts's
 *  doc comment for exactly what each outcome logs). Never updated, never deleted. */
export function recordAiUsage(input: RecordAiUsageInput): void {
  getDb()
    .prepare(
      `INSERT INTO ai_usage_log
        (task, provider, model_id, input_tokens, output_tokens, estimated_cost_usd,
         cache_hit, success, error_category, latency_ms)
       VALUES
        (@task, @provider, @modelId, @inputTokens, @outputTokens, @estimatedCostUsd,
         @cacheHit, @success, @errorCategory, @latencyMs)`
    )
    .run({
      task: input.task,
      provider: input.provider,
      modelId: input.modelId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      estimatedCostUsd: input.estimatedCostUsd,
      cacheHit: input.cacheHit ? 1 : 0,
      success: input.success ? 1 : 0,
      errorCategory: input.errorCategory,
      latencyMs: input.latencyMs,
    });
}

export interface AiUsageSummary {
  totalCostUsd: number;
  callCount: number;
  failureCount: number;
}

/**
 * Converts a JS Date to the exact string shape SQLite's own `datetime('now')` produces
 * ("YYYY-MM-DD HH:MM:SS", space-separated UTC, no milliseconds, no trailing 'Z'). Callers building a
 * `sinceUtc` bound for getAiUsageSummary below MUST use this, never `Date.prototype.toISOString()`
 * directly — plain string comparison against `created_at` (stored in SQLite's own format) is
 * otherwise silently wrong: 'T' (0x54) sorts after ' ' (0x20), so an ISO-with-T threshold can exclude
 * same-day rows it should include. Same underlying SQLite datetime-format quirk
 * src/lib/settings.ts's parseSqliteUtc already documents for the reverse (stored-string -> Date)
 * direction.
 */
export function toSqliteUtcTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Real spend since `sinceUtc` (see toSqliteUtcTimestamp above — must be in SQLite's own datetime
 *  format, not a raw ISO string), used by src/lib/ai/budget.ts's daily/monthly checks. Deliberately
 *  sums estimated_cost_usd for every logged row regardless of success — a schema-validation failure
 *  still consumed real provider tokens and must count against budget (see runAiTask.ts); only rows
 *  with a NULL cost (the pre-call short-circuits: disabled/missing_credentials/budget_exceeded, plus
 *  cache hits which are a real zero, not a null) are excluded by COALESCE, i.e. contribute 0. */
export function getAiUsageSummary(sinceUtc: string, task?: string): AiUsageSummary {
  const db = getDb();
  const row = task
    ? (db
        .prepare(
          `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS totalCostUsd, COUNT(*) AS callCount,
                  SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failureCount
           FROM ai_usage_log WHERE created_at >= ? AND task = ?`
        )
        .get(sinceUtc, task) as AiUsageSummary)
    : (db
        .prepare(
          `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS totalCostUsd, COUNT(*) AS callCount,
                  SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failureCount
           FROM ai_usage_log WHERE created_at >= ?`
        )
        .get(sinceUtc) as AiUsageSummary);
  return {
    totalCostUsd: row.totalCostUsd ?? 0,
    callCount: row.callCount ?? 0,
    failureCount: row.failureCount ?? 0,
  };
}
