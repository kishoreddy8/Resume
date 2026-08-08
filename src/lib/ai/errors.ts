/**
 * AI-specific error taxonomy — a deliberately separate implementation from
 * src/lib/scan/errors.ts's ScanConnectorError/ErrorCategory, not a shared one. The retry semantics
 * genuinely differ (a schema_validation_failed category gets a one-shot "repair" re-prompt, not a
 * backoff retry) and the instruction is explicit that AI retries must never be coupled to ATS
 * connector retries.
 */
export type AiErrorCategory =
  | "timeout"
  | "rate_limited"
  | "provider_5xx"
  | "network"
  | "invalid_response"
  | "schema_validation_failed"
  | "invalid_config"
  | "missing_credentials"
  | "budget_exceeded"
  | "disabled"
  | "unknown";

export class AiProviderError extends Error {
  readonly category: AiErrorCategory;
  readonly retryCount: number;
  readonly statusCode?: number;

  constructor(message: string, category: AiErrorCategory, retryCount: number, statusCode?: number) {
    super(message);
    this.name = "AiProviderError";
    this.category = category;
    this.retryCount = retryCount;
    this.statusCode = statusCode;
  }
}

/** Retried with backoff — transient by nature. */
export const AI_RETRYABLE_CATEGORIES: ReadonlySet<AiErrorCategory> = new Set([
  "timeout",
  "rate_limited",
  "provider_5xx",
  "network",
]);

export function isRetryableAiCategory(category: AiErrorCategory): boolean {
  return AI_RETRYABLE_CATEGORIES.has(category);
}

/** Classifies an arbitrary thrown value from a provider adapter that didn't already throw a typed
 *  AiProviderError — mirrors src/lib/scan/errors.ts's categorizeThrownError in spirit, distinct in
 *  vocabulary. */
export function categorizeThrownAiError(err: unknown): AiErrorCategory {
  if (err instanceof AiProviderError) return err.category;
  if (err instanceof Error && err.name === "AbortError") return "timeout";
  return "unknown";
}
