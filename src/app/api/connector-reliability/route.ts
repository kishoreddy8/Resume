import { NextResponse } from "next/server";
import { getConnectorReliabilitySummary, getProviderHealthSummary } from "@/db/queries/reliability";

/**
 * Connector Reliability Control Plane V1 — Phase 11 observability endpoint. Derived-only, same
 * convention as GET /api/ats-coverage: no new table, everything computed at read time.
 */
export async function GET() {
  return NextResponse.json({
    summary: getConnectorReliabilitySummary(),
    providers: getProviderHealthSummary(),
  });
}
