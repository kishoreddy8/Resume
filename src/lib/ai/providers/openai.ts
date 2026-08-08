import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
} from "openai";
import { AiProviderError, type AiErrorCategory } from "../errors";
import { registerProvider } from "../provider";
import type { AiGenerateRequest, AiGenerateResult, AiProvider } from "../provider";
import type { ModelTier } from "../types";

/**
 * OpenAI adapter — GPT-5.6 family. lightweight -> Luna, standard -> Terra, confirmed against the
 * installed openai@7.4.0 SDK's own ResponsesModel type union (both literals are present in it).
 * Sol is deliberately absent from V1 (see AI Architecture plan) — promoting standard to Sol later
 * is a one-line change to this map, nothing else.
 */
export const MODEL_BY_TIER: Record<ModelTier, string> = {
  lightweight: "gpt-5.6-luna",
  standard: "gpt-5.6-terra",
};

/**
 * Minimal structural interface for the piece of the OpenAI SDK this adapter actually calls —
 * deliberately narrower than the full `OpenAI` class so tests can inject a lightweight stub object
 * without constructing a real client or touching the network. A real `OpenAI` instance already
 * satisfies this shape.
 */
export interface OpenAiResponsesClient {
  responses: {
    create(
      params: {
        model: string;
        input: string;
        text?: { format: { type: "json_schema"; name: string; schema: Record<string, unknown>; strict: true } };
      },
      options?: { signal?: AbortSignal }
    ): Promise<{
      output_text: string;
      usage?: { input_tokens: number; output_tokens: number };
    }>;
  };
}

/**
 * Categorizes an error thrown by the openai SDK into this project's own AiErrorCategory taxonomy —
 * exact class names confirmed against the installed openai@7.4.0 SDK's error.d.ts. Deliberately a
 * separate mapping from src/lib/scan/errors.ts's HTTP-status categorization; this one is vendor-SDK-
 * exception-shaped, not raw-fetch-response-shaped.
 */
export function categorizeOpenAiError(err: unknown): AiErrorCategory {
  if (err instanceof APIUserAbortError) return "timeout";
  if (err instanceof APIConnectionTimeoutError) return "timeout";
  if (err instanceof RateLimitError) return "rate_limited";
  if (err instanceof AuthenticationError) return "missing_credentials";
  if (err instanceof APIConnectionError) return "network";
  if (err instanceof APIError) {
    const status = err.status;
    if (typeof status === "number" && status >= 500) return "provider_5xx";
    if (typeof status === "number" && status === 429) return "rate_limited";
    if (typeof status === "number" && status >= 400) return "invalid_config";
  }
  return "unknown";
}

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";

  constructor(private readonly client: OpenAiResponsesClient) {}

  describeModel(tier: ModelTier): { modelId: string } | null {
    const modelId = MODEL_BY_TIER[tier];
    return modelId ? { modelId } : null;
  }

  async generate(req: AiGenerateRequest): Promise<AiGenerateResult> {
    const modelId = MODEL_BY_TIER[req.tier];
    if (!modelId) {
      throw new AiProviderError(`No OpenAI model mapped for tier "${req.tier}"`, "invalid_config", 0);
    }

    // Structured Outputs (see AI Architecture plan) — a plain JSON-Schema object built by
    // runAiTask.ts via Zod v4's native z.toJSONSchema(), never the SDK's own zodTextFormat helper
    // (incompatible with Zod 4 as of this writing — see runAiTask.ts's doc comment). Current official
    // shape confirmed against both OpenAI's docs and the installed SDK's own
    // ResponseFormatTextJSONSchemaConfig type: `text.format = {type, name, schema, strict}`, not the
    // older Chat Completions `response_format` convention.
    const text = req.outputJsonSchema
      ? {
          format: {
            type: "json_schema" as const,
            name: req.outputJsonSchema.name,
            schema: req.outputJsonSchema.schema as Record<string, unknown>,
            strict: true as const,
          },
        }
      : undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const response = await this.client.responses.create(
        { model: modelId, input: req.prompt, ...(text ? { text } : {}) },
        { signal: controller.signal }
      );

      let raw: unknown;
      try {
        raw = JSON.parse(response.output_text);
      } catch {
        // A real response was received but wasn't parseable JSON — this is genuinely
        // invalid_response, not a Zod schema mismatch (runAiTask's safeParse never even runs on it).
        throw new AiProviderError("OpenAI response was not valid JSON", "invalid_response", 0);
      }

      return {
        raw,
        modelId,
        usage: {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      throw new AiProviderError(err instanceof Error ? err.message : String(err), categorizeOpenAiError(err), 0);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Exported so tests can check the credential gate in isolation without relying on module-load
 *  timing (self-registration below only happens once, at import time). */
export function hasOpenAiCredentials(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

// Self-registers only when OPENAI_API_KEY is present — "registered" continues to imply "usable,"
// per provider.ts's documented convention. The key is read once, here, to construct the SDK client;
// it is never logged, never stored anywhere else (not in SQLite, not in any usage/audit row — those
// only ever record task/provider/model/tokens/cost, never request content or credentials).
if (hasOpenAiCredentials()) {
  registerProvider(new OpenAiProvider(new OpenAI({ apiKey: process.env.OPENAI_API_KEY })));
}
