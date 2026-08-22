import { NextRequest, NextResponse } from "next/server";
import { getAppSettings, updateAppSettings } from "@/db/queries/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { requireAdminOwner } from "@/lib/auth/guard";

export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  return NextResponse.json({ settings: getAppSettings(), defaults: DEFAULT_SETTINGS });
}

/** Deep-partial update — any subset of lifecycle/suppression/scanner fields. Validated (shape,
 *  per-field bounds, then cross-field ordering against the merged result) inside updateAppSettings;
 *  an invalid patch is rejected with 400 and leaves stored settings untouched. */
export async function PATCH(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  const body = await req.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = updateAppSettings(body);
  if (!result.ok) {
    return NextResponse.json({ error: "Invalid settings", details: result.errors }, { status: 400 });
  }

  return NextResponse.json({ settings: result.settings });
}
