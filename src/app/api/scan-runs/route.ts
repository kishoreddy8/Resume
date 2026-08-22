import { NextRequest, NextResponse } from "next/server";
import { getLatestScanRunPerCompany, listRecentScanRuns, listScanRunsForCompany } from "@/db/queries/scanRuns";
import { requireAdminOwner } from "@/lib/auth/guard";

/**
 * GET /api/scan-runs — Scanner dashboard data (src/app/scanner/page.tsx).
 *   ?companyId=<id>  -> that company's scan history (most recent first)
 *   ?latestPerCompany=1 -> one row per company, its most recent scan attempt
 *   (neither)        -> the N most recent scan_runs across every company
 * Company-level health fields (consecutive_failures, connector_health, etc.) live on the Company
 * row itself and are already returned by the existing GET /api/companies — no change needed there.
 */
export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  const params = req.nextUrl.searchParams;
  const companyId = params.get("companyId");
  const latestPerCompany = params.get("latestPerCompany");
  const requestedLimit = Number(params.get("limit") ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.trunc(requestedLimit))) : 50;

  if (companyId) {
    const id = Number(companyId);
    if (!Number.isInteger(id)) {
      return NextResponse.json({ error: "companyId must be an integer" }, { status: 400 });
    }
    return NextResponse.json({ scanRuns: listScanRunsForCompany(id, limit) });
  }

  if (latestPerCompany) {
    return NextResponse.json({ scanRuns: getLatestScanRunPerCompany() });
  }

  return NextResponse.json({ scanRuns: listRecentScanRuns(limit) });
}
