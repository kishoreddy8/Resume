import { AiProviderError } from "./errors";
import type { ModelTier } from "./types";

/**
 * Provider-neutral interface. Feature code and every other file in src/lib/ai/ import ONLY this
 * interface — never a vendor SDK directly. A real adapter (e.g. for a specific vendor) would live in
 * src/lib/ai/providers/<vendor>.ts, implement AiProvider, and register itself via registerProvider()
 * below. No such adapter exists yet in this infrastructure-only phase — see README/AGENTS.md's scope
 * note. Swapping or adding a vendor later means writing one new providers/*.ts file; nothing in
 * runAiTask.ts, cache.ts, budget.ts, or any task definition changes.
 */
export interface AiGenerateRequest {
  prompt: string;
  tier: ModelTier;
  timeoutMs: number;
  /**
   * Optional JSON-Schema description of the expected output, for providers that support
   * constraining generation to a schema (e.g. OpenAI Structured Outputs). Generic and provider-
   * agnostic on purpose — a provider that doesn't support this may ignore it and rely on prompt
   * instructions alone. `schema` is a plain JSON-Schema object (built via Zod v4's native
   * z.toJSONSchema() in runAiTask.ts, never a vendor-SDK-specific helper — see runAiTask.ts's doc
   * comment for why). Zod validation of the actual response in runAiTask remains the sole authority
   * regardless of whether a provider honors this or how well.
   */
  outputJsonSchema?: { name: string; schema: unknown };
}

export interface AiGenerateResult {
  /** Parsed JSON, not yet validated against the task's own output schema — runAiTask does that. */
  raw: unknown;
  modelId: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AiProvider {
  readonly name: string;
  /**
   * Pure, synchronous, no I/O: "what model would service this tier right now," or null if this
   * provider can't currently service that tier at all. Resolved BEFORE any cache lookup or provider
   * call, purely so the cache key (entity+task+version+hash+provider+model) can be computed without
   * ever making a network call just to find out what model would have answered.
   */
  describeModel(tier: ModelTier): { modelId: string } | null;
  generate(req: AiGenerateRequest): Promise<AiGenerateResult>;
}

/** The only implementation that exists in this phase. Always unavailable — describeModel always
 *  returns null (so runAiTask never even reaches generate()), and generate() throws defensively if
 *  ever called directly. This lets every other module in src/lib/ai/ be built and fully tested
 *  without any real vendor SDK or API key. */
class NullAiProvider implements AiProvider {
  readonly name = "none";
  describeModel(): { modelId: string } | null {
    return null;
  }
  async generate(): Promise<AiGenerateResult> {
    throw new AiProviderError("No AI provider is configured", "missing_credentials", 0);
  }
}

const registry = new Map<string, AiProvider>();

/** Real provider adapters call this once, at module load, only after confirming their own required
 *  credentials are present — so "registered" already implies "has credentials." No adapter does this
 *  yet in this phase. Exported for provider adapters AND for tests (a FakeProvider registers itself
 *  the same way a real adapter eventually would). */
export function registerProvider(provider: AiProvider): void {
  registry.set(provider.name, provider);
}

/** Test-only escape hatch: clears every registered provider so tests don't leak a FakeProvider
 *  registration across files/cases. Real app code never calls this. */
export function clearProviders(): void {
  registry.clear();
}

function isAiEnabled(): boolean {
  return process.env.CAREER_OPS_AI_ENABLED === "true";
}

export type ProviderResolution =
  | { provider: AiProvider }
  | { provider: null; reason: "disabled" | "missing_credentials" };

/**
 * Enablement + credentials live in process environment configuration ONLY — never in SQLite, never
 * logged. CAREER_OPS_AI_ENABLED gates everything off by default (the single safe default); when
 * enabled, CAREER_OPS_AI_PROVIDER names which registered provider to use. A provider adapter is
 * responsible for its own credential check before ever calling registerProvider(), so "registered"
 * already means "usable" — there's no separate credential-presence check here.
 *
 * Provider/model *selection* (this function) is provider-neutral configuration and, later, could
 * move into Settings once a real provider exists and a UI need appears — deliberately not done now.
 */
export function resolveProvider(): ProviderResolution {
  if (!isAiEnabled()) return { provider: null, reason: "disabled" };

  const providerName = process.env.CAREER_OPS_AI_PROVIDER;
  if (!providerName) return { provider: null, reason: "missing_credentials" };

  const provider = registry.get(providerName);
  if (!provider) return { provider: null, reason: "missing_credentials" };

  return { provider };
}

/** Convenience wrapper most callers want: the active provider, or null if unavailable for any
 *  reason. Use resolveProvider() directly when the specific reason matters. */
export function getActiveProvider(): AiProvider | null {
  const resolution = resolveProvider();
  return resolution.provider;
}

// Ensures the always-available fallback exists in the registry under a name nothing will ever
// select via CAREER_OPS_AI_PROVIDER, purely so callers that want to exercise "a provider that always
// reports unavailable" (as opposed to "no provider configured at all") have one without a test
// needing to hand-roll it.
registerProvider(new NullAiProvider());
