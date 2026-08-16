import { NextResponse } from "next/server";
import { listPendingProposals } from "@/db/queries/atsSourceProposals";

/**
 * Discovery V2 Stage 3 — global pending-proposal queue (across all companies), for the ATS
 * Coverage "Source Recovery Proposals" review surface. Read-only, no approval/rejection here (see
 * the company-scoped POST endpoints for that).
 */
export async function GET() {
  return NextResponse.json({ proposals: listPendingProposals(100) });
}
