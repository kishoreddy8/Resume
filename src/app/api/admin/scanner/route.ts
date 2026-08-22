import { NextRequest, NextResponse } from "next/server";
import { requireAdminOwner } from "@/lib/auth/guard";
import { getAdminScannerProjection } from "@/lib/admin/scanner";

export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req); if (!authorization.ok) return authorization.response;
  const limit = Math.min(100, Math.max(10, Number(req.nextUrl.searchParams.get("limit") ?? 25) || 25));
  return NextResponse.json(getAdminScannerProjection(limit));
}
