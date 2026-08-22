import { NextRequest, NextResponse } from "next/server";
import { resetAppSettings } from "@/db/queries/settings";
import { requireAdminOwner } from "@/lib/auth/guard";

export async function POST(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  const settings = resetAppSettings();
  return NextResponse.json({ settings });
}
