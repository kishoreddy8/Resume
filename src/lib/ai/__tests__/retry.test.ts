import assert from "node:assert/strict";
import { test } from "node:test";
import { AiProviderError } from "../errors";
import { callProviderWithRetry } from "../retry";
import { FakeProvider, HangingProvider } from "./testHelpers";

/**
 * AI provider retry/timeout/error-categorization — a genuinely separate implementation from
 * src/lib/scan/retry.ts's fetchWithRetry, tested independently. Run with: npm test
 */

test("retryable failures: retries transient errors and succeeds within maxAttempts", async () => {
  const provider = new FakeProvider({
    steps: [{ error: "provider_5xx" }, { error: "provider_5xx" }, { raw: { ok: true } }],
  });
  let retries = 0;
  const result = await callProviderWithRetry(
    provider,
    { prompt: "p", tier: "lightweight", timeoutMs: 1000 },
    { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20, onRetry: () => retries++ }
  );
  assert.deepEqual(result.raw, { ok: true });
  assert.equal(provider.callCount, 3, "must have made exactly 3 attempts");
  assert.equal(retries, 2, "onRetry must fire once per retried attempt, not on the final success");
});

test("non-retryable failure: short-circuits on the first attempt, no retry loop entered", async () => {
  const provider = new FakeProvider({ steps: [{ error: "invalid_config" }, { raw: { ok: true } }] });
  let retries = 0;
  await assert.rejects(
    () =>
      callProviderWithRetry(
        provider,
        { prompt: "p", tier: "lightweight", timeoutMs: 1000 },
        { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20, onRetry: () => retries++ }
      ),
    (err: unknown) => err instanceof AiProviderError && err.category === "invalid_config"
  );
  assert.equal(provider.callCount, 1, "a non-retryable category must never be retried");
  assert.equal(retries, 0);
});

test("retry exhaustion: a persistently failing retryable error still gives up after maxAttempts", async () => {
  const provider = new FakeProvider({ steps: [{ error: "rate_limited" }] }); // repeats forever
  await assert.rejects(
    () =>
      callProviderWithRetry(
        provider,
        { prompt: "p", tier: "lightweight", timeoutMs: 1000 },
        { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20 }
      ),
    (err: unknown) => err instanceof AiProviderError && err.category === "rate_limited"
  );
  assert.equal(provider.callCount, 2, "must attempt exactly maxAttempts times, no more");
});

test("timeout: a hanging provider call is aborted at timeoutMs and categorized as timeout", async () => {
  const provider = new HangingProvider();
  const start = Date.now();
  await assert.rejects(
    () => callProviderWithRetry(provider, { prompt: "p", tier: "lightweight", timeoutMs: 50 }, { maxAttempts: 1 }),
    (err: unknown) => err instanceof AiProviderError && err.category === "timeout"
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `must not wait anywhere near a full retry cycle past the timeout (took ${elapsed}ms)`);
});

test("timeout is retried like other transient categories when maxAttempts > 1", async () => {
  const provider = new FakeProvider({ steps: [{ error: "timeout" }, { raw: { ok: true } }] });
  const result = await callProviderWithRetry(
    provider,
    { prompt: "p", tier: "lightweight", timeoutMs: 1000 },
    { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20 }
  );
  assert.deepEqual(result.raw, { ok: true });
  assert.equal(provider.callCount, 2);
});
