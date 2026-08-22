import { NextRequest, NextResponse } from "next/server";
import { getAtsCoverageSummary } from "@/db/queries/atsCoverage";
import { requireAdminOwner } from "@/lib/auth/guard";

/**
 * Derived-only source-observability endpoint (see the approved pre-Phase-3 hardening plan).
 * Everything here is computed at read time from companies/jobs — no new table, no cached counters.
 */
export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  return NextResponse.json(getAtsCoverageSummary());
}
