import { NextResponse } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { markNotificationRead } from "@/db/queries/notifications";

/** Mark exactly one notification read. Candidate-scoped by construction — markNotificationRead's
 *  own WHERE clause includes candidate_id, so a notificationId belonging to a different candidate
 *  reads back as "not_found" here, never a silent cross-candidate success (see
 *  src/db/queries/notifications.ts). */

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(
  _req: Request,
  { params }: { params: Promise<{ candidateId: string; notificationId: string }> }
) {
  const { candidateId: candidateIdParam, notificationId: notificationIdParam } = await params;

  const candidateId = parsePositiveInt(candidateIdParam);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const notificationId = parsePositiveInt(notificationIdParam);
  if (notificationId === null) return NextResponse.json({ error: "Invalid notification id" }, { status: 400 });

  const result = markNotificationRead(candidateId, notificationId);
  if (result === "not_found") {
    return NextResponse.json({ error: "Notification not found for this candidate" }, { status: 404 });
  }

  return NextResponse.json({ status: result });
}
