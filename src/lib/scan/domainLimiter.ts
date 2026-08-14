import pLimit from "p-limit";

export interface DomainLimiterOptions {
  concurrency: number;
  baseDelayMs?: number;
}

export interface DomainLimiter {
  <T>(fn: () => Promise<T>): Promise<T>;
  readonly activeCount: number;
  readonly pendingCount: number;
}

/** Internal extended interface that includes the reset hook — never exported, only used by
 *  resetForTesting() within this module. Avoids `as any` casts that trip the lint rule. */
interface ResettableDomainLimiter extends DomainLimiter {
  _reset(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDomainLimiter(options: DomainLimiterOptions): ResettableDomainLimiter {
  let limit = pLimit(options.concurrency);

  const limiter: ResettableDomainLimiter = Object.assign(
    async <T>(fn: () => Promise<T>): Promise<T> => {
      return limit(async () => {
        try {
          return await fn();
        } finally {
          if (options.baseDelayMs && options.baseDelayMs > 0) {
            await sleep(options.baseDelayMs);
          }
        }
      });
    },
    {
      get activeCount() {
        return limit.activeCount;
      },
      get pendingCount() {
        return limit.pendingCount;
      },
      _reset() {
        limit.clearQueue();
        limit = pLimit(options.concurrency);
      },
    }
  );

  return limiter;
}

// Module-level singletons shared by every source scan within the same process — the whole point
// is that when the scan runner fires 6 Workday sources in parallel, they all queue through a
// single concurrency=2 gate instead of each opening 8+ connections to *.myworkdayjobs.com.
export const workdayDomainLimiter: DomainLimiter = createDomainLimiter({ concurrency: 2 });
export const adpWfnDomainLimiter: DomainLimiter = createDomainLimiter({ concurrency: 1, baseDelayMs: 200 });

/** Resets both singletons' internal p-limit queues. Test-only — never called in production. */
export function resetForTesting(): void {
  (workdayDomainLimiter as ResettableDomainLimiter)._reset();
  (adpWfnDomainLimiter as ResettableDomainLimiter)._reset();
}
