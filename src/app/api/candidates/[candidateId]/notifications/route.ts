import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getJobIdByDedupeKey } from "@/db/queries/jobs";
import { getUnreadNotificationCount, listNotificationsForCandidate, type NotificationRow } from "@/db/queries/notifications";

/**
 * Phase 4 Stage 4 — candidate-scoped notification list + unread count (combined in one response;
 * a single small route serves both, per the "lightweight route only if architecture clearly favors
 * it" guidance — it doesn't here, the badge and the panel both need the candidate's notifications
 * loaded together). Never exposes another candidate's notifications: candidateId is validated via
 * requireActiveCandidate, and every query below is candidate-scoped by construction (see
 * src/db/queries/notifications.ts).
 */

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export interface NotificationResponseEntry {
  id: number;
  dedupeKey: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  /** Resolved at read time from dedupe_key — null if the job was since deleted (suppressed_jobs /
   *  age-swept). The notification row itself is never deleted just because its job disappeared;
   *  see schema.sql's notifications table comment. */
  jobId: number | null;
}

function toResponseEntry(row: NotificationRow): NotificationResponseEntry {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    type: row.type,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at,
    jobId: getJobIdByDedupeKey(row.dedupe_key) ?? null,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: candidateIdParam } = await params;
  const candidateId = parsePositiveInt(candidateIdParam);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const searchParams = req.nextUrl.searchParams;
  const unreadOnly = searchParams.get("unreadOnly") === "true";
  const requestedLimit = Number(searchParams.get("limit"));
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : undefined;

  const rows = listNotificationsForCandidate(candidateId, { unreadOnly, limit });
  const unreadCount = getUnreadNotificationCount(candidateId);

  return NextResponse.json({
    candidateId,
    unreadCount,
    notifications: rows.map(toResponseEntry),
  });
}
