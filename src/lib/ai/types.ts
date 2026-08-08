import type { ZodType } from "zod";

/**
 * Shared AI Infrastructure (see AGENTS.md's AI Architecture Review / Shared AI Infrastructure task).
 *
 * This module tree is a reusable, provider-neutral foundation for future AI-assisted Career-Ops
 * features. It is deliberately generic across future tasks (job-intel enrichment, H1B alias
 * suggestion, sponsorship-language fallback, match scoring, etc.) rather than one bespoke module per
 * feature — see AiTaskDefinition below.
 *
 * SAFETY: nothing in Phase 1's deterministic pipeline (scan -> normalize -> dedupe -> lifecycle ->
 * suppression -> H1B -> jobIntel) calls into this module, and this module never calls into Phase 1's
 * write paths. AI output is always additive, nullable, versioned, and namespaced away from
 * authoritative data — see src/db/schema.sql's ai_enrichments table comment.
 */

/** What an AI result is about. Open-ended on purpose (see src/db/schema.sql's ai_enrichments comment
 *  for why there's no CHECK enum) — new entity types can be added without a migration. */
export type AiEntityType = "job" | "company";

/**
 * References one specific entity for AI purposes.
 *
 * `key` is a STABLE IDENTITY SNAPSHOT, not a derived value — the caller (a future feature, never
 * this module) is responsible for supplying it, copied verbatim from whatever Phase 1 already treats
 * as that entity's own authoritative, stable identity:
 *   - job:     jobs.dedupe_key (see src/lib/dedupe.ts) — never recompute or reconstruct it here.
 *   - company: no single column plays dedupe_key's role for companies today. Build the key from
 *              companies' own existing unique identity instead — `source_type`+`ats_board_token`
 *              when set, else `career_page_url` (these are exactly the two conditions
 *              idx_companies_ats/idx_companies_career_url already enforce as unique in
 *              src/db/schema.sql) — e.g. "company:{source_type}:{ats_board_token}" or
 *              "company:career_link:{career_page_url}", mirroring dedupeKeyForAts/
 *              dedupeKeyForCareerLink's naming convention without importing dedupe.ts itself.
 *
 * `id` is the entity's current numeric row id — kept ONLY as convenience metadata (e.g. joining
 * back to the row's current title for display). jobs.id/companies.id are plain SQLite
 * INTEGER PRIMARY KEY columns without AUTOINCREMENT, so a numeric id CAN be reused by a later,
 * unrelated row once the original is deleted (Not Interested / aged out). `id` is therefore NEVER
 * used for cache lookup or uniqueness — only `key` is (see src/lib/ai/cache.ts and
 * src/db/schema.sql's ai_enrichments table comment). This module never reaches into dedupe/job/
 * company internals to manufacture `key` itself — it only ever receives and stores what's passed in,
 * keeping the AI infrastructure generic and Phase 1's identity logic exclusively Phase 1's.
 */
export interface AiEntityRef {
  type: AiEntityType;
  key: string;
  id: number;
}

export type AiConfidenceBand = "low" | "review" | "high";

/**
 * Generic AI-output confidence: a 0..1 score plus a derived band. Deliberately NOT named
 * "Confidence" or reusing that word bare — src/types/index.ts already owns H1bCompanyConfidence /
 * H1bJobConfidence, a closed, domain-specific enum ("Very High"/"High"/.../"Not Sponsoring") that
 * means something completely different. Keeping these named distinctly (AiConfidence vs.
 * H1b*Confidence) prevents the two unrelated concepts from ever being confused in code.
 */
export interface AiConfidence {
  value: number; // 0..1
  band: AiConfidenceBand;
}

/**
 * Every non-throwing failure mode runAiTask can return. Deliberately small and fixed — every caller
 * is expected to handle all six by simply showing "AI suggestion unavailable," never by branching
 * into feature-specific recovery logic.
 */
export type AiUnavailableReason =
  | "disabled"
  | "missing_credentials"
  | "budget_exceeded"
  | "timeout"
  | "provider_error"
  | "invalid_response";

/** runAiTask's return shape. There is no third, exceptional path — see runAiTask.ts's doc comment. */
export type AiResult<T> =
  | { status: "ok"; data: T; confidence?: AiConfidence; cached: boolean }
  | { status: "unavailable"; reason: AiUnavailableReason };

/** Cost/latency tier a task requests, resolved to a concrete model by the active provider — see
 *  provider.ts. Keeps every task file provider- and model-agnostic: swapping providers or
 *  re-mapping which concrete model backs a tier never requires touching a task definition. */
export type ModelTier = "lightweight" | "standard";

/**
 * The unit every future AI feature adds: one task definition, registered once in
 * tasks/registry.ts. No task definitions are registered yet in this infrastructure-only phase.
 *
 * Four independently-declared concerns, on purpose (see the AI Architecture corrections this
 * implements): an input type is not automatically what's sent to the provider, and what's sent to
 * the provider is not automatically what's hashed for the cache key. `toProviderInput` is the sole
 * privacy boundary — buildPrompt only ever sees its return value, never the raw TInput — and
 * `toCacheKeyInput` is independent, so a task can cache-invalidate on a field it doesn't send, or
 * send a field that shouldn't force a cache miss, without those two decisions coupling to each other.
 */
export interface AiTaskDefinition<TInput, TOutput> {
  /** Stable identifier, e.g. "job_intel_enrichment". The only thing feature code and the registry
   *  reference by string — never construct one dynamically. */
  id: string;
  /** Bumping this invalidates this task's cache only (see cache.ts) and, by convention, MUST be
   *  bumped whenever outputSchema's shape changes — task_version doubles as the output-schema
   *  version, so there is never a stored row whose output_json shape doesn't match what the current
   *  code expects for that exact (task, task_version) pair. */
  version: number;
  entityType: AiEntityType;
  modelTier: ModelTier;
  /** Every AI output for this task must satisfy this schema before it is ever persisted. */
  outputSchema: ZodType<TOutput>;
  /** The privacy boundary: an explicit allowlist projection of TInput. buildPrompt only ever
   *  receives this function's return value, never TInput itself — see privacy note above. */
  toProviderInput: (input: TInput) => Record<string, unknown>;
  /** Builds the actual prompt string, from the already-projected provider input only. */
  buildPrompt: (providerInput: Record<string, unknown>) => string;
  /** Independent allowlist projection used only for the cache-key content hash — see cache.ts. */
  toCacheKeyInput: (input: TInput) => unknown;
  /** Optional: derives a 0..1 confidence score from a validated output. Absent by default — a task
   *  only needs this if its output schema is the kind of thing that has a meaningful confidence
   *  score at all. See confidence.ts for the resulting AiConfidence shape. */
  deriveConfidence?: (output: TOutput) => number;
}
