import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { categorizeHttpError, ScanConnectorError } from "../errors";
import { computeDelayMs, fetchWithRetry, parseJsonOrThrow } from "../retry";

/**
 * Retry/backoff/error-categorization tests for src/lib/scan/retry.ts — run against a real,
 * ephemeral local HTTP server (Node's built-in `http`, no mocking) scripted per-test to fail N
 * times then succeed, hang past a timeout, or always fail. Deterministic and fast (small
 * baseDelayMs/timeoutMs passed explicitly per call) without touching real ATS endpoints.
 *
 * Run with: npm test
 */

const servers: http.Server[] = [];

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, requestCount: number) => void) {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    handler(req, res, count);
  });
  servers.push(server);
  return new Promise<{ url: string; getCount: () => number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, getCount: () => count });
    });
  });
}

after(() => {
  for (const server of servers) server.close();
});

function jsonResponse(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

test("succeeds on the first attempt when the server returns 200", async () => {
  const { url, getCount } = await startServer((_req, res) => jsonResponse(res, 200, { ok: true }));
  const res = await fetchWithRetry(url, {}, { baseDelayMs: 1 });
  assert.equal(res.status, 200);
  assert.equal(getCount(), 1);
});

test("429 then 200: retries once and succeeds", async () => {
  const { url, getCount } = await startServer((_req, res, count) => {
    if (count === 1) return jsonResponse(res, 429, { error: "rate limited" });
    jsonResponse(res, 200, { ok: true });
  });
  let retries = 0;
  const res = await fetchWithRetry(url, {}, { baseDelayMs: 1, onRetry: () => retries++ });
  assert.equal(res.status, 200);
  assert.equal(getCount(), 2);
  assert.equal(retries, 1);
});

test("transient 500 then 200: retries once and succeeds", async () => {
  const { url, getCount } = await startServer((_req, res, count) => {
    if (count === 1) return jsonResponse(res, 500, { error: "boom" });
    jsonResponse(res, 200, { ok: true });
  });
  let retryCategory: string | undefined;
  const res = await fetchWithRetry(url, {}, { baseDelayMs: 1, onRetry: (_a, category) => (retryCategory = category) });
  assert.equal(res.status, 200);
  assert.equal(getCount(), 2);
  assert.equal(retryCategory, "provider_5xx");
});

test("permanent 400 (invalid_config) is never retried", async () => {
  const { url, getCount } = await startServer((_req, res) => jsonResponse(res, 400, { error: "bad request" }));
  await assert.rejects(
    () => fetchWithRetry(url, {}, { baseDelayMs: 1, maxAttempts: 3 }),
    (err: unknown) => {
      assert.ok(err instanceof ScanConnectorError);
      assert.equal(err.category, "invalid_config");
      assert.equal(err.retryCount, 0);
      return true;
    }
  );
  assert.equal(getCount(), 1, "a non-retryable category must not be retried");
});

test("retry exhaustion: a server that always fails throws after maxAttempts", async () => {
  const { url, getCount } = await startServer((_req, res) => jsonResponse(res, 503, { error: "unavailable" }));
  await assert.rejects(
    () => fetchWithRetry(url, {}, { baseDelayMs: 1, maxAttempts: 3 }),
    (err: unknown) => {
      assert.ok(err instanceof ScanConnectorError);
      assert.equal(err.category, "provider_5xx");
      assert.equal(err.retryCount, 2, "2 retries happened before giving up on a 3-attempt budget");
      return true;
    }
  );
  assert.equal(getCount(), 3);
});

test("timeout: a server that never responds is aborted and categorized as timeout", async () => {
  const { url } = await startServer(() => {
    // Never call res.end() — simulates a hung connection.
  });
  await assert.rejects(
    () => fetchWithRetry(url, {}, { baseDelayMs: 1, timeoutMs: 50, maxAttempts: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof ScanConnectorError);
      assert.equal(err.category, "timeout");
      return true;
    }
  );
});

test("network error: connection refused is categorized as network and retried", async () => {
  // A port nothing is listening on — fetch() rejects with a connection-refused TypeError.
  const { url, getCount } = await startServer((_req, res) => jsonResponse(res, 200, { ok: true }));
  const closedPortUrl = url.replace(/:\d+$/, ":1");
  let retries = 0;
  await assert.rejects(
    () => fetchWithRetry(closedPortUrl, {}, { baseDelayMs: 1, maxAttempts: 2, onRetry: () => retries++ }),
    (err: unknown) => {
      assert.ok(err instanceof ScanConnectorError);
      assert.equal(err.category, "network");
      return true;
    }
  );
  assert.equal(retries, 1, "network failures are retryable");
  assert.equal(getCount(), 0, "the real (unrelated) server on the other port was never hit");
});

// --- Shared 429 retry-budget expansion (src/lib/scan/retry.ts's rateLimitedMaxAttempts) ---------
// Regression coverage for the fix restoring this: previously the expansion only activated when the
// caller omitted maxAttempts entirely, but every real caller (scan.ts, connectorHealthCheck.ts,
// secLookup.ts, etc.) always passes one explicitly — silently making the expansion dead code in
// production. The fix drops that gate: rate_limited always gets max(configured, 5), every other
// category keeps exactly the caller's configured budget.

test("rate_limited: configured maxAttempts=3 is expanded to allow up to 5 attempts total", async () => {
  const { url, getCount } = await startServer((_req, res) => jsonResponse(res, 429, { error: "rate limited" }));
  await assert.rejects(
    () => fetchWithRetry(url, {}, { baseDelayMs: 1, maxAttempts: 3 }),
    (err: unknown) => {
      assert.ok(err instanceof ScanConnectorError);
      assert.equal(err.category, "rate_limited");
      assert.equal(err.retryCount, 4, "4 retries before the 5th and final attempt is exhausted");
      return true;
    }
  );
  assert.equal(getCount(), 5, "a caller-configured budget of 3 must still get the full 5-attempt rate-limit floor");
});

test("rate_limited: configured maxAttempts=5 (already at the floor) stays at exactly 5", async () => {
  const { url, getCount } = await startServer((_req, res) => jsonResponse(res, 429, { error: "rate limited" }));
  await assert.rejects(
    () => fetchWithRetry(url, {}, { baseDelayMs: 1, maxAttempts: 5 }),
    (err: unknown) => {
      assert.ok(err instanceof ScanConnectorError);
      assert.equal(err.retryCount, 4);
      return true;
    }
  );
  assert.equal(getCount(), 5);
});

test("rate_limited: configured maxAttempts=7 (above the floor) is preserved, never clamped down to 5", async () => {
  const { url, getCount } = await startServer((_req, res) => jsonResponse(res, 429, { error: "rate limited" }));
  await assert.rejects(
    () => fetchWithRetry(url, {}, { baseDelayMs: 1, maxAttempts: 7 }),
    (err: unknown) => {
      assert.ok(err instanceof ScanConnectorError);
      assert.equal(err.retryCount, 6, "the expansion only ever raises the floor to 5, never lowers a larger configured budget");
      return true;
    }
  );
  assert.equal(getCount(), 7);
});

test("provider_5xx with configured maxAttempts=3 is NOT expanded — stays at exactly 3 (only rate_limited gets the floor)", async () => {
  const { url, getCount } = await startServer((_req, res) => jsonResponse(res, 503, { error: "unavailable" }));
  await assert.rejects(
    () => fetchWithRetry(url, {}, { baseDelayMs: 1, maxAttempts: 3 }),
    (err: unknown) => {
      assert.ok(err instanceof ScanConnectorError);
      assert.equal(err.category, "provider_5xx");
      assert.equal(err.retryCount, 2, "a non-rate-limited transient category keeps the caller's exact configured budget");
      return true;
    }
  );
  assert.equal(getCount(), 3);
});

test("404 (invalid_config) remains non-retryable even with the rate-limit floor in place", async () => {
  const { url, getCount } = await startServer((_req, res) => jsonResponse(res, 404, { error: "not found" }));
  await assert.rejects(
    () => fetchWithRetry(url, {}, { baseDelayMs: 1, maxAttempts: 3 }),
    (err: unknown) => {
      assert.ok(err instanceof ScanConnectorError);
      assert.equal(err.category, "invalid_config");
      assert.equal(err.retryCount, 0);
      return true;
    }
  );
  assert.equal(getCount(), 1, "a non-retryable category must never be retried, regardless of the rate-limit floor");
});

test("rate_limited: a successful response before the expanded budget is exhausted exits early, not at the floor", async () => {
  const { url, getCount } = await startServer((_req, res, count) => {
    if (count <= 3) return jsonResponse(res, 429, { error: "rate limited" });
    jsonResponse(res, 200, { ok: true });
  });
  const res = await fetchWithRetry(url, {}, { baseDelayMs: 1, maxAttempts: 3 });
  assert.equal(res.status, 200);
  assert.equal(getCount(), 4, "succeeds on the 4th attempt, within the expanded 5-attempt floor, without needing the 5th");
});

test("rate_limited: Retry-After's hard 60s cap is still enforced under the expanded budget", () => {
  // A real 60s+ wait isn't practical in a fast unit test, and mocking global setTimeout conflicts
  // with fetch()'s own internal timer usage in this real-local-server integration style — so this
  // exercises computeDelayMs directly (a pure function, unaffected by the rate-limit-floor fix).
  const oneHourMs = 60 * 60 * 1000;
  const delay = computeDelayMs(1, 1, 5000, oneHourMs);
  assert.ok(delay <= 60_000, `Retry-After of 1 hour must still be capped at 60s, got ${delay}ms`);
  assert.ok(delay >= 60_000, `the cap is a floor for a Retry-After this large, not a smaller backoff value, got ${delay}ms`);
});

test("Retry-After header on 429 is honored (waits at least as long as it says)", async () => {
  const { url } = await startServer((_req, res, count) => {
    if (count === 1) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      return res.end(JSON.stringify({ error: "slow down" }));
    }
    jsonResponse(res, 200, { ok: true });
  });
  const start = Date.now();
  const res = await fetchWithRetry(url, {}, { baseDelayMs: 1, maxDelayMs: 5000 });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 200);
  assert.ok(elapsed >= 900, `expected to wait ~1s per Retry-After, only waited ${elapsed}ms`);
});

test("parseJsonOrThrow categorizes a malformed body as parse_error", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("not json");
  });
  const res = await fetchWithRetry(url, {}, { baseDelayMs: 1 });
  await assert.rejects(
    () => parseJsonOrThrow(res, url),
    (err: unknown) => {
      assert.ok(err instanceof ScanConnectorError);
      assert.equal(err.category, "parse_error");
      return true;
    }
  );
});

// --- categorizeHttpError: pure classification, no server needed -----------------------------

test("categorizeHttpError classifies status codes correctly", () => {
  const mk = (status: number) => ({ status } as Response);
  assert.equal(categorizeHttpError(mk(429), undefined), "rate_limited");
  assert.equal(categorizeHttpError(mk(403), undefined), "blocked");
  assert.equal(categorizeHttpError(mk(500), undefined), "provider_5xx");
  assert.equal(categorizeHttpError(mk(502), undefined), "provider_5xx");
  assert.equal(categorizeHttpError(mk(404), undefined), "invalid_config");
  assert.equal(categorizeHttpError(undefined, new TypeError("fetch failed")), "network");
  assert.equal(categorizeHttpError(undefined, Object.assign(new Error("aborted"), { name: "AbortError" })), "timeout");
  assert.equal(categorizeHttpError(undefined, undefined, { isParseError: true }), "parse_error");
});
