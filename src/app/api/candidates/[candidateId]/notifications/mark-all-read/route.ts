import { NextResponse, type NextRequest } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { markAllNotificationsRead } from "@/db/queries/notifications";

/** Mark every currently-unread notification read for exactly this candidate. Candidate-scoped by
 *  construction (markAllNotificationsRead's WHERE clause includes candidate_id). */

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: candidateIdParam } = await params;

  const candidateId = parsePositiveInt(candidateIdParam);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const markedCount = markAllNotificationsRead(candidateId);
  return NextResponse.json({ markedCount });
}
