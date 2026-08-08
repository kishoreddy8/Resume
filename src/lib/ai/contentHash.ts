import crypto from "node:crypto";

/**
 * Stable content hashing for the AI cache key (see cache.ts). A separate, independent
 * implementation from src/lib/dedupe.ts's own sha256Hex — that one is scoped to job-identity
 * hashing and truncates its digest for a short dedupe_key string; this one hashes a task's
 * cache-key projection (see types.ts's AiTaskDefinition.toCacheKeyInput) and keeps the full digest,
 * a different, unrelated concern that happens to also use sha256.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic regardless of key insertion order — object keys are sorted recursively before
 *  stringifying, so two logically-identical inputs always hash identically. */
export function hashCacheKeyInput(value: unknown): string {
  const canonical = JSON.stringify(canonicalize(value));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
