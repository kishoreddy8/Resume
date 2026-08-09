import { NextResponse } from "next/server";
import { listMatchRuns } from "@/db/queries/matchRuns";

export async function GET() {
  return NextResponse.json({ runs: listMatchRuns() });
}
