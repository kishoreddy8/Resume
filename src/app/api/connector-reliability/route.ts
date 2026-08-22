import { NextRequest, NextResponse } from "next/server";
import { getConnectorReliabilitySummary, getProviderHealthSummary } from "@/db/queries/reliability";
import { requireAdminOwner } from "@/lib/auth/guard";

/**
 * Connector Reliability Control Plane V1 — Phase 11 observability endpoint. Derived-only, same
 * convention as GET /api/ats-coverage: no new table, everything computed at read time.
 */
export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  return NextResponse.json({
    summary: getConnectorReliabilitySummary(),
    providers: getProviderHealthSummary(),
  });
}
