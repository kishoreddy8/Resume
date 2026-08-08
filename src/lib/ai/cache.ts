import {
  getAiEnrichment,
  insertAiEnrichment,
  markSuperseded,
  type AiEnrichmentRow,
  type InsertAiEnrichmentInput,
} from "@/db/queries/aiEnrichments";
import { hashCacheKeyInput } from "./contentHash";
import type { AiEntityType } from "./types";

export interface CacheLookupParams {
  entityType: AiEntityType;
  /** Stable identity snapshot — see src/lib/ai/types.ts's AiEntityRef doc comment. This, not a
   *  numeric row id, is what the lookup filters on. */
  entityKey: string;
  task: string;
  taskVersion: number;
  cacheKeyInput: unknown;
  provider: string;
  modelId: string;
}

export interface CacheLookupResult {
  contentHash: string;
  hit: AiEnrichmentRow | undefined;
}

/**
 * Computes the content hash and performs the exact-key lookup in one step. The hash is needed again
 * by the caller regardless of hit/miss (a miss still needs it to write the new row), so this returns
 * both instead of making the caller hash the input twice.
 */
export function lookupCache(params: CacheLookupParams): CacheLookupResult {
  const contentHash = hashCacheKeyInput(params.cacheKeyInput);
  const hit = getAiEnrichment({
    entityType: params.entityType,
    entityKey: params.entityKey,
    task: params.task,
    taskVersion: params.taskVersion,
    contentHash,
    provider: params.provider,
    modelId: params.modelId,
  });
  return { contentHash, hit };
}

/** Immutable insert (see src/db/queries/aiEnrichments.ts's insertAiEnrichment) plus best-effort
 *  supersede bookkeeping on older rows for the same entity_key+task — metadata only, see
 *  markSuperseded's own doc comment for why this never touches the new or old rows' substantive
 *  content. */
export function writeCache(input: InsertAiEnrichmentInput): AiEnrichmentRow {
  const row = insertAiEnrichment(input);
  markSuperseded(input.entityType, input.entityKey, input.task, row.id);
  return row;
}
