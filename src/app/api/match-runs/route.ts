import { NextRequest, NextResponse } from "next/server";
import { listMatchRuns } from "@/db/queries/matchRuns";
import { requireAdminOwner } from "@/lib/auth/guard";

/**
 * ADMIN-OPS-5 — operator-only.
 *
 * listMatchRuns() with no candidate id returns runs for EVERY candidate: their ids, how many jobs
 * each evaluation looked at, and an error summary. That is cross-candidate operational data, and the
 * route previously served it to anyone who could reach the port. Nothing in the app called it — the
 * only reference was a unit test — so guarding it breaks no consumer.
 *
 * requireAdminOwner rather than requireCandidateAccess because the data spans candidates; a
 * candidate-scoped view would need a candidateId and its own query, which no caller has asked for.
 */
export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req); if (!authorization.ok) return authorization.response;
  return NextResponse.json({ runs: listMatchRuns() });
}
