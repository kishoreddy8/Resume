import { NextRequest, NextResponse } from "next/server";
import { getMorningReadinessSummary } from "@/lib/production/readiness";
import { getProductionCycleLockStatus } from "@/lib/production/state";
import { requireAdminOwner } from "@/lib/auth/guard";

export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
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
