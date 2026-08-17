import { NextResponse } from "next/server";
import { getMorningReadinessSummary } from "@/lib/production/readiness";
import { getProductionCycleLockStatus } from "@/lib/production/state";

export async function GET() {
  try {
    const readiness = getMorningReadinessSummary();
    const lock = getProductionCycleLockStatus();

    return NextResponse.json({
      readiness,
      lock,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error }, { status: 500 });
  }
}
