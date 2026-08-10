import { NextResponse } from "next/server";
import { getAtsCoverageSummary } from "@/db/queries/atsCoverage";

/**
 * Derived-only source-observability endpoint (see the approved pre-Phase-3 hardening plan).
 * Everything here is computed at read time from companies/jobs — no new table, no cached counters.
 */
export async function GET() {
  return NextResponse.json(getAtsCoverageSummary());
}
