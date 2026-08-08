import { AiProviderError, type AiErrorCategory } from "../errors";
import type { AiGenerateRequest, AiGenerateResult, AiProvider } from "../provider";
import type { ModelTier } from "../types";

/**
 * Test double for AiProvider, used across src/lib/ai/__tests__/*.test.ts instead of any real vendor
 * SDK/API key — not a *.test.ts file itself, so it's never picked up by npm test's glob directly,
 * only imported by files that are.
 *
 * Scripted with a queue of responses so a single test can exact-script a sequence (e.g. "fail twice
 * with provider_5xx, then succeed" for a retry test, or "return malformed JSON once, valid on the
 * next call" for a repair-retry test). The last queued entry repeats once exhausted.
 */
export type FakeProviderStep =
  | { raw: unknown; usage?: { inputTokens: number; outputTokens: number } }
  | { error: AiErrorCategory };

export class FakeProvider implements AiProvider {
  readonly name: string;
  private steps: FakeProviderStep[];
  private modelByTier: Partial<Record<ModelTier, string | null>>;
  callCount = 0;

  constructor(opts: { name?: string; steps: FakeProviderStep[]; modelByTier?: Partial<Record<ModelTier, string | null>> }) {
    this.name = opts.name ?? "fake";
    this.steps = opts.steps;
    this.modelByTier = opts.modelByTier ?? {};
  }

  describeModel(tier: ModelTier): { modelId: string } | null {
    if (tier in this.modelByTier) {
      const modelId = this.modelByTier[tier];
      return modelId ? { modelId } : null;
    }
    return { modelId: `${this.name}-${tier}` };
  }

  async generate(req: AiGenerateRequest): Promise<AiGenerateResult> {
    const step = this.steps[Math.min(this.callCount, this.steps.length - 1)];
    this.callCount++;
    if ("error" in step) {
      throw new AiProviderError(`fake provider failure: ${step.error}`, step.error, 0);
    }
    const model = this.describeModel(req.tier);
    return {
      raw: step.raw,
      modelId: model?.modelId ?? `${this.name}-${req.tier}`,
      usage: step.usage ?? { inputTokens: 100, outputTokens: 50 },
    };
  }
}

/** A provider whose generate() hangs until manually resolved — used to exercise the retry wrapper's
 *  own timeout, distinct from a provider that throws an AiProviderError("timeout") itself. */
export class HangingProvider implements AiProvider {
  readonly name = "hanging";
  describeModel(tier: ModelTier): { modelId: string } | null {
    return { modelId: `hanging-${tier}` };
  }
  generate(): Promise<AiGenerateResult> {
    return new Promise(() => {
      /* never resolves */
    });
  }
}
