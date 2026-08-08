import { AI_RETRYABLE_CATEGORIES, AiProviderError, categorizeThrownAiError, type AiErrorCategory } from "./errors";
import type { AiGenerateRequest, AiGenerateResult, AiProvider } from "./provider";

export interface AiRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, category: AiErrorCategory) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_MAX_DELAY_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = Math.random() * Math.min(100, backoff);
  return backoff + jitter;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiProviderError(`AI call timed out after ${timeoutMs}ms`, "timeout", 0)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Bounded retry/backoff for AI provider calls — same shape as src/lib/scan/retry.ts's
 * fetchWithRetry (per-attempt timeout, exponential backoff with jitter, categorized errors) but a
 * genuinely separate implementation, per the explicit instruction that AI retries must never be
 * coupled to ATS connector retries. Only retries AI_RETRYABLE_CATEGORIES; anything else (config,
 * credentials, budget, a schema failure — handled separately by runAiTask's own one-shot repair
 * logic, not this loop) throws immediately on the first attempt.
 */
export async function callProviderWithRetry(
  provider: AiProvider,
  req: AiGenerateRequest,
  options: AiRetryOptions = {}
): Promise<AiGenerateResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withTimeout(provider.generate(req), req.timeoutMs);
    } catch (err) {
      const category = categorizeThrownAiError(err);
      const isLastAttempt = attempt === maxAttempts;
      if (!AI_RETRYABLE_CATEGORIES.has(category) || isLastAttempt) {
        if (err instanceof AiProviderError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new AiProviderError(message, category, attempt - 1);
      }
      options.onRetry?.(attempt, category);
      await sleep(computeDelayMs(attempt, baseDelayMs, maxDelayMs));
    }
  }

  // Unreachable — every loop iteration either returns or throws — kept for TS's control-flow
  // analysis, same convention as src/lib/scan/retry.ts's own trailing throw.
  throw new AiProviderError("AI provider call failed", "unknown", maxAttempts - 1);
}
