import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
} from "openai";
import { estimateCostUsd } from "../../budget";
import { AiProviderError } from "../../errors";
import { categorizeOpenAiError, hasOpenAiCredentials, MODEL_BY_TIER, OpenAiProvider, type OpenAiResponsesClient } from "../openai";

/**
 * OpenAI adapter: request construction, response mapping, error categorization, and credential
 * gating — all against a stubbed client, no real network call, no real API key. Run with: npm test
 */

const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
});

test("describeModel maps lightweight -> gpt-5.6-luna and standard -> gpt-5.6-terra", () => {
  const provider = new OpenAiProvider({ responses: { create: async () => ({ output_text: "{}" }) } });
  assert.deepEqual(provider.describeModel("lightweight"), { modelId: "gpt-5.6-luna" });
  assert.deepEqual(provider.describeModel("standard"), { modelId: "gpt-5.6-terra" });
  assert.deepEqual(MODEL_BY_TIER, { lightweight: "gpt-5.6-luna", standard: "gpt-5.6-terra" });
});

test("hasOpenAiCredentials reflects OPENAI_API_KEY presence", () => {
  assert.equal(hasOpenAiCredentials(), false);
  process.env.OPENAI_API_KEY = "sk-test-key";
  assert.equal(hasOpenAiCredentials(), true);
});

test("generate: builds the correct request shape (model, input, text.format) and maps a valid response", async () => {
  let capturedParams: unknown;
  let capturedOptions: unknown;
  const client: OpenAiResponsesClient = {
    responses: {
      create: async (params, options) => {
        capturedParams = params;
        capturedOptions = options;
        return { output_text: JSON.stringify({ summary: "ok" }), usage: { input_tokens: 120, output_tokens: 40 } };
      },
    },
  };
  const provider = new OpenAiProvider(client);

  const result = await provider.generate({
    prompt: "summarize this",
    tier: "standard",
    timeoutMs: 5000,
    outputJsonSchema: { name: "job_detail_enrichment", schema: { type: "object" } },
  });

  assert.deepEqual(capturedParams, {
    model: "gpt-5.6-terra",
    input: "summarize this",
    text: { format: { type: "json_schema", name: "job_detail_enrichment", schema: { type: "object" }, strict: true } },
  });
  assert.ok((capturedOptions as { signal?: AbortSignal })?.signal instanceof AbortSignal, "must pass an AbortSignal through to the SDK call");

  assert.deepEqual(result.raw, { summary: "ok" });
  assert.equal(result.modelId, "gpt-5.6-terra");
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 40 });
});

test("generate: omitting outputJsonSchema omits text.format entirely (prompt-only path still functions)", async () => {
  let capturedParams: unknown;
  const client: OpenAiResponsesClient = {
    responses: {
      create: async (params) => {
        capturedParams = params;
        return { output_text: JSON.stringify({ summary: "ok" }) };
      },
    },
  };
  const provider = new OpenAiProvider(client);
  await provider.generate({ prompt: "summarize this", tier: "lightweight", timeoutMs: 5000 });

  assert.deepEqual(capturedParams, { model: "gpt-5.6-luna", input: "summarize this" });
});

test("generate: missing usage on the response defaults token counts to 0 rather than throwing", async () => {
  const client: OpenAiResponsesClient = {
    responses: { create: async () => ({ output_text: JSON.stringify({ ok: true }) }) },
  };
  const provider = new OpenAiProvider(client);
  const result = await provider.generate({ prompt: "p", tier: "lightweight", timeoutMs: 5000 });
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
});

test("generate: a non-JSON output_text is categorized as invalid_response, not left to crash", async () => {
  const client: OpenAiResponsesClient = {
    responses: { create: async () => ({ output_text: "not valid json{{{" }) },
  };
  const provider = new OpenAiProvider(client);
  await assert.rejects(
    () => provider.generate({ prompt: "p", tier: "lightweight", timeoutMs: 5000 }),
    (err: unknown) => err instanceof AiProviderError && err.category === "invalid_response"
  );
});

test("generate: SDK errors are mapped to the correct AiErrorCategory", async () => {
  const cases: [Error, string][] = [
    [new RateLimitError(429, {}, "rate limited", new Headers()), "rate_limited"],
    [new AuthenticationError(401, {}, "invalid api key", new Headers()), "missing_credentials"],
    [new InternalServerError(500, {}, "server error", new Headers()), "provider_5xx"],
    [new APIConnectionError({ message: "connection failed" }), "network"],
    [new APIConnectionTimeoutError(), "timeout"],
    [new APIUserAbortError(), "timeout"],
  ];

  for (const [thrown, expectedCategory] of cases) {
    const client: OpenAiResponsesClient = {
      responses: {
        create: async () => {
          throw thrown;
        },
      },
    };
    const provider = new OpenAiProvider(client);
    await assert.rejects(
      () => provider.generate({ prompt: "p", tier: "lightweight", timeoutMs: 5000 }),
      (err: unknown) => err instanceof AiProviderError && err.category === expectedCategory,
      `expected ${thrown.constructor.name} to map to "${expectedCategory}"`
    );
  }
});

test("categorizeOpenAiError: an arbitrary unrecognized error falls back to unknown", () => {
  assert.equal(categorizeOpenAiError(new Error("something else")), "unknown");
});

test("pricing: estimateCostUsd matches the verified official per-1K constants exactly", () => {
  // Luna (lightweight): $0.20/1M in, $1.20/1M out -> $0.0002/1K in, $0.0012/1K out
  assert.ok(Math.abs(estimateCostUsd("lightweight", 1000, 1000) - (0.0002 + 0.0012)) < 1e-9);
  // Terra (standard): $2.00/1M in, $12.00/1M out -> $0.002/1K in, $0.012/1K out
  assert.ok(Math.abs(estimateCostUsd("standard", 1000, 1000) - (0.002 + 0.012)) < 1e-9);
});
