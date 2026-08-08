import { getDb } from "@/db";

export type AiAuditEvent = "generated" | "shown" | "accepted" | "rejected" | "superseded" | "expired";

export interface AiAuditLogRow {
  id: number;
  ai_enrichment_id: number;
  event: AiAuditEvent;
  note: string | null;
  created_at: string;
}

/** Append-only suggestion lifecycle trail — see src/db/schema.sql's ai_audit_log comment for why
 *  this is kept structurally separate from job_status_history, and why every event requires a real,
 *  already-generated ai_enrichments row (failed generation attempts are captured by
 *  src/db/queries/aiUsage.ts's recordAiUsage instead, which has full task/provider/error context on
 *  its own without needing a row to reference). */
export function recordAiAuditEvent(enrichmentId: number, event: AiAuditEvent, note?: string): void {
  getDb()
    .prepare("INSERT INTO ai_audit_log (ai_enrichment_id, event, note) VALUES (?, ?, ?)")
    .run(enrichmentId, event, note ?? null);
}

/** Ordered by `id`, not `created_at`: SQLite's `datetime('now')` has only whole-second resolution,
 *  so several events recorded in rapid succession (e.g. 'generated' immediately followed by 'shown')
 *  can share an identical timestamp — `id` (autoincrement) is the reliable insertion-order proxy. */
export function getAuditTrail(enrichmentId: number): AiAuditLogRow[] {
  return getDb().prepare("SELECT * FROM ai_audit_log WHERE ai_enrichment_id = ? ORDER BY id ASC").all(enrichmentId) as AiAuditLogRow[];
}
