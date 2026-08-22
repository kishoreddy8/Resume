import { NextRequest, NextResponse } from "next/server";
import { requireAdminOwner } from "@/lib/auth/guard";
import { getAdminOverview } from "@/lib/admin/overview";
import type { WindowKey } from "@/db/queries/operations";

const WINDOWS = new Set<WindowKey>(["24h", "7d", "30d"]);

export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  const rawWindow = req.nextUrl.searchParams.get("window") ?? "24h";
  if (!WINDOWS.has(rawWindow as WindowKey)) return NextResponse.json({ error: "window must be one of: 24h, 7d, 30d" }, { status: 400 });
  return NextResponse.json(getAdminOverview(rawWindow as WindowKey));
}
