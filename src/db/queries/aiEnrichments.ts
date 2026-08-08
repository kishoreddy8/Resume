import { getDb } from "@/db";
import type { AiConfidence, AiEntityType } from "@/lib/ai/types";

export interface AiEnrichmentRow {
  id: number;
  entity_type: AiEntityType;
  /** Stable identity snapshot — see src/db/schema.sql's ai_enrichments IDENTITY SAFETY comment.
   *  This, not entity_id, is what every lookup/uniqueness check uses. */
  entity_key: string;
  /** Convenience metadata only — the numeric row id at write time. NEVER safe to use for lookup or
   *  uniqueness (see the schema comment): a job/company id can be reused by an unrelated later row
   *  once the original is deleted. */
  entity_id: number;
  task: string;
  task_version: number;
  content_hash: string;
  provider: string;
  model_id: string;
  output_json: string;
  confidence_value: number | null;
  confidence_band: string | null;
  status: "active" | "superseded" | "expired";
  created_at: string;
  updated_at: string;
}

/** The identity used for lookup/uniqueness — entity_key, not entity_id. See
 *  src/db/schema.sql's ai_enrichments IDENTITY SAFETY comment and src/lib/ai/types.ts's AiEntityRef
 *  doc comment for why. */
export interface AiEnrichmentKey {
  entityType: AiEntityType;
  entityKey: string;
  task: string;
  taskVersion: number;
  contentHash: string;
  provider: string;
  modelId: string;
}

/** Exact-key lookup — this IS the cache lookup (see src/lib/ai/cache.ts). Filters on entity_key,
 *  never entity_id — a job/company row's numeric id can be reused after deletion, so entity_id alone
 *  could otherwise match a stale AI result to a brand-new, unrelated entity. Also ignores `status`
 *  on purpose: an 'active' vs. 'superseded' row for the exact same key is still the exact same
 *  immutable result — status is bookkeeping metadata, never a filter on correctness. */
export function getAiEnrichment(key: AiEnrichmentKey): AiEnrichmentRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM ai_enrichments
       WHERE entity_type = @entityType AND entity_key = @entityKey AND task = @task
         AND task_version = @taskVersion AND content_hash = @contentHash
         AND provider = @provider AND model_id = @modelId`
    )
    .get(key) as AiEnrichmentRow | undefined;
}

export function getAiEnrichmentById(id: number): AiEnrichmentRow | undefined {
  return getDb().prepare("SELECT * FROM ai_enrichments WHERE id = ?").get(id) as AiEnrichmentRow | undefined;
}

export interface InsertAiEnrichmentInput extends AiEnrichmentKey {
  /** Convenience metadata only — see AiEnrichmentRow.entity_id's doc comment. Stored, but never
   *  part of the lookup/uniqueness key. */
  entityId: number;
  outputJson: string;
  confidence?: AiConfidence;
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

/**
 * Immutable insert: once a row exists for this exact key, it is NEVER updated — see
 * src/db/schema.sql's ai_enrichments comment. A call for a key that already exists (the normal
 * "identical input, identical task version, identical provider/model" case) simply returns the
 * existing row unchanged, exactly like a cache hit.
 *
 * Race safety: two concurrent misses attempting to insert the same key is largely theoretical here
 * (better-sqlite3/SQLite serializes writers), but is still handled correctly — the unique index
 * (idx_ai_enrichments_key, on entity_key not entity_id) makes the losing INSERT fail with
 * SQLITE_CONSTRAINT_UNIQUE, which is caught and treated as "someone else just wrote it": the
 * existing row is re-read and returned rather than the write being retried or the error propagating.
 * Neither writer's row is ever overwritten by the other.
 */
export function insertAiEnrichment(input: InsertAiEnrichmentInput): AiEnrichmentRow {
  const existing = getAiEnrichment(input);
  if (existing) return existing;

  const db = getDb();
  try {
    db.prepare(
      `INSERT INTO ai_enrichments
        (entity_type, entity_key, entity_id, task, task_version, content_hash, provider, model_id,
         output_json, confidence_value, confidence_band)
       VALUES
        (@entityType, @entityKey, @entityId, @task, @taskVersion, @contentHash, @provider, @modelId,
         @outputJson, @confidenceValue, @confidenceBand)`
    ).run({
      entityType: input.entityType,
      entityKey: input.entityKey,
      entityId: input.entityId,
      task: input.task,
      taskVersion: input.taskVersion,
      contentHash: input.contentHash,
      provider: input.provider,
      modelId: input.modelId,
      outputJson: input.outputJson,
      confidenceValue: input.confidence?.value ?? null,
      confidenceBand: input.confidence?.band ?? null,
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const raceWinner = getAiEnrichment(input);
      if (raceWinner) return raceWinner;
    }
    throw err;
  }

  return getAiEnrichment(input)!;
}

/**
 * Metadata-only bookkeeping: marks other, older rows for the same (entity_key, task) as superseded
 * once a new active result exists for that entity+task under a different key. Touches ONLY `status`
 * and `updated_at` — never output_json/confidence_value/confidence_band/provider/model_id on any
 * row, including the ones being marked. Keyed on entity_key, not entity_id, for the same reuse-safety
 * reason as getAiEnrichment above. Best-effort housekeeping for a future "current vs. history" view;
 * its absence never affects correctness, since exact-key lookup already ignores status entirely.
 */
export function markSuperseded(entityType: AiEntityType, entityKey: string, task: string, excludeId: number): void {
  getDb()
    .prepare(
      `UPDATE ai_enrichments
       SET status = 'superseded', updated_at = datetime('now')
       WHERE entity_type = @entityType AND entity_key = @entityKey AND task = @task
         AND id != @excludeId AND status = 'active'`
    )
    .run({ entityType, entityKey, task, excludeId });
}

/** Full AI history for one entity, keyed by entity_key — the same reuse-safety reasoning as
 *  getAiEnrichment applies here too: listing by entity_id could otherwise mix history from two
 *  different real-world entities that happened to share a numeric id at different points in time. */
export function listAiEnrichmentsForEntity(entityType: AiEntityType, entityKey: string, task?: string): AiEnrichmentRow[] {
  const db = getDb();
  if (task) {
    return db
      .prepare("SELECT * FROM ai_enrichments WHERE entity_type = ? AND entity_key = ? AND task = ? ORDER BY id DESC")
      .all(entityType, entityKey, task) as AiEnrichmentRow[];
  }
  return db
    .prepare("SELECT * FROM ai_enrichments WHERE entity_type = ? AND entity_key = ? ORDER BY id DESC")
    .all(entityType, entityKey) as AiEnrichmentRow[];
}
