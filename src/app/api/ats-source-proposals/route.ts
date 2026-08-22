import { NextRequest, NextResponse } from "next/server";
import { listPendingProposals } from "@/db/queries/atsSourceProposals";
import { requireAdminOwner } from "@/lib/auth/guard";

/**
 * Discovery V2 Stage 3 — global pending-proposal queue (across all companies), for the ATS
 * Coverage "Source Recovery Proposals" review surface. Read-only, no approval/rejection here (see
 * the company-scoped POST endpoints for that).
 */
export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  return NextResponse.json({ proposals: listPendingProposals(100) });
}
