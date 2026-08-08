import { z } from "zod";
import { recordAiAuditEvent } from "@/db/queries/aiAudit";
import { recordAiUsage } from "@/db/queries/aiUsage";
import { estimateCostUsd, checkBudget, recordSessionCall } from "./budget";
import { lookupCache, writeCache } from "./cache";
import { buildConfidence } from "./confidence";
import { categorizeThrownAiError, type AiErrorCategory } from "./errors";
import { resolveProvider } from "./provider";
import { callProviderWithRetry } from "./retry";
// Side-effect imports: register every known task and every known (credentialed) provider adapter
// (see tasks/index.ts and providers/index.ts's own doc comments) before any call below can execute,
// regardless of which route/feature happens to import runAiTask first.
import "./tasks";
import "./providers";
import { getTask } from "./tasks/registry";
import type { AiConfidence, AiConfidenceBand, AiEntityRef, AiResult, AiUnavailableReason } from "./types";

const DEFAULT_TIMEOUT_MS = 20_000;

interface UsageLogFields {
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

function logUsage(fields: UsageLogFields): void {
  recordAiUsage(fields);
}

/**
 * The single entry point every future AI feature calls instead of hand-rolling provider calls,
 * caching, retries, budget checks, or logging. Never throws — every failure mode (disabled, missing
 * credentials, budget exceeded, timeout, provider error, malformed output) terminates in the same
 * `{ status: "unavailable", reason }` shape a caller already has to handle for the ordinary "AI is
 * off" case. This is what makes "AI failure must never affect scanning or deterministic Career-Ops
 * functionality" true by construction: there is no exception type for a caller to forget to catch,
 * because none is ever raised here.
 *
 * Flow: registry lookup -> resolve provider/model (pure config, no I/O) -> cache lookup (exact key
 * match on entity.type + entity.key + task + version + contentHash + provider + model — entity.key,
 * NEVER entity.id, per src/lib/ai/types.ts's AiEntityRef doc comment) -> budget check -> provider
 * call (bounded retry) -> Zod output validation (one repair retry on failure) -> immutable
 * persistence + usage + audit logging -> typed result.
 *
 * `taskId` unknown to the registry is a programming error, not a runtime "unavailable" outcome, and
 * throws immediately — every other failure mode below it is a normal, expected return value.
 */
export async function runAiTask<TOutput = unknown>(
  taskId: string,
  entity: AiEntityRef,
  input: unknown
): Promise<AiResult<TOutput>> {
  const task = getTask(taskId);
  if (!task) {
    throw new Error(`Unknown AI task id: "${taskId}" — register it in src/lib/ai/tasks/index.ts first`);
  }

  const resolution = resolveProvider();
  if (!resolution.provider) {
    logUsage({
      task: taskId,
      provider: null,
      modelId: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      cacheHit: false,
      success: false,
      errorCategory: resolution.reason,
      latencyMs: null,
    });
    return { status: "unavailable", reason: resolution.reason };
  }
  const provider = resolution.provider;

  const modelDescriptor = provider.describeModel(task.modelTier);
  if (!modelDescriptor) {
    logUsage({
      task: taskId,
      provider: provider.name,
      modelId: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      cacheHit: false,
      success: false,
      errorCategory: "missing_credentials",
      latencyMs: null,
    });
    return { status: "unavailable", reason: "missing_credentials" };
  }

  const cacheT0 = Date.now();
  const cacheKeyInput = task.toCacheKeyInput(input);
  const { contentHash, hit } = lookupCache({
    entityType: entity.type,
    entityKey: entity.key,
    task: taskId,
    taskVersion: task.version,
    cacheKeyInput,
    provider: provider.name,
    modelId: modelDescriptor.modelId,
  });

  if (hit) {
    logUsage({
      task: taskId,
      provider: provider.name,
      modelId: modelDescriptor.modelId,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      cacheHit: true,
      success: true,
      errorCategory: null,
      latencyMs: Date.now() - cacheT0,
    });
    const confidence: AiConfidence | undefined =
      hit.confidence_value !== null && hit.confidence_band !== null
        ? { value: hit.confidence_value, band: hit.confidence_band as AiConfidenceBand }
        : undefined;
    return { status: "ok", enrichmentId: hit.id, data: JSON.parse(hit.output_json) as TOutput, confidence, cached: true };
  }

  const budgetCheck = checkBudget(task.modelTier);
  if (!budgetCheck.allowed) {
    logUsage({
      task: taskId,
      provider: provider.name,
      modelId: modelDescriptor.modelId,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      cacheHit: false,
      success: false,
      errorCategory: "budget_exceeded",
      latencyMs: null,
    });
    return { status: "unavailable", reason: "budget_exceeded" };
  }

  const providerInput = task.toProviderInput(input);
  const prompt = task.buildPrompt(providerInput);
  // Built once via Zod v4's own native toJSONSchema — never a vendor-SDK Zod helper (e.g. OpenAI's
  // zodTextFormat, which is incompatible with Zod 4 as of this writing: it depends on the
  // unmaintained zod-to-json-schema package internally and mis-converts schemas under Zod 4). This
  // keeps the shared infra genuinely provider-neutral: any provider that supports schema-constrained
  // generation gets a real JSON Schema; one that doesn't simply ignores this field.
  const outputJsonSchema = { name: taskId, schema: z.toJSONSchema(task.outputSchema) };

  recordSessionCall();
  const callT0 = Date.now();

  const firstAttempt = await callProviderWithRetry(provider, {
    prompt,
    tier: task.modelTier,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outputJsonSchema,
  })
    .then((result) => ({ ok: true as const, result }))
    .catch((err: unknown) => ({ ok: false as const, err }));

  if (!firstAttempt.ok) {
    const category = categorizeThrownAiError(firstAttempt.err);
    logUsage({
      task: taskId,
      provider: provider.name,
      modelId: modelDescriptor.modelId,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      cacheHit: false,
      success: false,
      errorCategory: category,
      latencyMs: Date.now() - callT0,
    });
    const reason: AiUnavailableReason = category === "timeout" ? "timeout" : "provider_error";
    return { status: "unavailable", reason };
  }

  let generated = firstAttempt.result;
  let parsed = task.outputSchema.safeParse(generated.raw);

  if (!parsed.success) {
    // One repair retry: re-prompt with the validation error attached, never a second blind
    // backoff-retry loop — a malformed response is a different failure shape than a transient one.
    const repairPrompt = `${prompt}\n\nYour previous response did not match the required schema:\n${parsed.error.message}\n\nRespond again with corrected JSON only.`;

    const repairAttempt = await callProviderWithRetry(provider, {
      prompt: repairPrompt,
      tier: task.modelTier,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      outputJsonSchema,
    })
      .then((result) => ({ ok: true as const, result }))
      .catch((err: unknown) => ({ ok: false as const, err }));

    // Real tokens from the first attempt were already spent regardless of what happens next — a
    // schema failure (or a second failed call) still consumed real provider tokens and must be
    // logged with real cost, never null, so budget accounting (checkBudget) can't be fooled into
    // thinking a run of failures cost nothing.
    if (!repairAttempt.ok) {
      const cost = estimateCostUsd(task.modelTier, generated.usage.inputTokens, generated.usage.outputTokens);
      logUsage({
        task: taskId,
        provider: provider.name,
        modelId: modelDescriptor.modelId,
        inputTokens: generated.usage.inputTokens,
        outputTokens: generated.usage.outputTokens,
        estimatedCostUsd: cost,
        cacheHit: false,
        success: false,
        errorCategory: "schema_validation_failed",
        latencyMs: Date.now() - callT0,
      });
      return { status: "unavailable", reason: "invalid_response" };
    }

    const repaired = repairAttempt.result;
    const repairedParsed = task.outputSchema.safeParse(repaired.raw);
    const combinedInputTokens = generated.usage.inputTokens + repaired.usage.inputTokens;
    const combinedOutputTokens = generated.usage.outputTokens + repaired.usage.outputTokens;

    if (!repairedParsed.success) {
      const cost = estimateCostUsd(task.modelTier, combinedInputTokens, combinedOutputTokens);
      logUsage({
        task: taskId,
        provider: provider.name,
        modelId: modelDescriptor.modelId,
        inputTokens: combinedInputTokens,
        outputTokens: combinedOutputTokens,
        estimatedCostUsd: cost,
        cacheHit: false,
        success: false,
        errorCategory: "schema_validation_failed",
        latencyMs: Date.now() - callT0,
      });
      return { status: "unavailable", reason: "invalid_response" };
    }

    parsed = repairedParsed;
    generated = { ...repaired, usage: { inputTokens: combinedInputTokens, outputTokens: combinedOutputTokens } };
  }

  // Success — persist (immutable insert), log real usage, audit, return.
  const output = parsed.data as TOutput;
  const confidence: AiConfidence | undefined = task.deriveConfidence
    ? buildConfidence(task.deriveConfidence(output))
    : undefined;

  const row = writeCache({
    entityType: entity.type,
    entityKey: entity.key,
    entityId: entity.id,
    task: taskId,
    taskVersion: task.version,
    contentHash,
    provider: provider.name,
    modelId: modelDescriptor.modelId,
    outputJson: JSON.stringify(output),
    confidence,
  });

  const cost = estimateCostUsd(task.modelTier, generated.usage.inputTokens, generated.usage.outputTokens);
  logUsage({
    task: taskId,
    provider: provider.name,
    modelId: modelDescriptor.modelId,
    inputTokens: generated.usage.inputTokens,
    outputTokens: generated.usage.outputTokens,
    estimatedCostUsd: cost,
    cacheHit: false,
    success: true,
    errorCategory: null,
    latencyMs: Date.now() - callT0,
  });
  recordAiAuditEvent(row.id, "generated");

  return { status: "ok", enrichmentId: row.id, data: output, confidence, cached: false };
}
