import { NextRequest, NextResponse } from "next/server";
import { requireAdminOwner } from "@/lib/auth/guard";
import { getAdminOverview } from "@/lib/admin/overview";
import { adminActionCatalog, buildAdminOperationsView } from "@/lib/admin/operationsView";
import type { WindowKey } from "@/db/queries/operations";

const WINDOWS = new Set<WindowKey>(["24h", "7d", "30d"]);

export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  const rawWindow = req.nextUrl.searchParams.get("window") ?? "24h";
  if (!WINDOWS.has(rawWindow as WindowKey)) return NextResponse.json({ error: "window must be one of: 24h, 7d, 30d" }, { status: 400 });
  const window = rawWindow as WindowKey;

  /* ADMIN-OPS-5 — additive. Every legacy field getAdminOverview returns is preserved verbatim for
   * the pages already reading them (src/app/admin/*), and the finished operator view-model is added
   * alongside under `operations`. One request, so the eventual Admin UI does not have to stitch a
   * coherent picture out of several endpoints, and no existing consumer has to migrate first. */
  return NextResponse.json({
    ...getAdminOverview(window),
    operations: buildAdminOperationsView(window),
    actionCatalog: adminActionCatalog(),
  });
}
