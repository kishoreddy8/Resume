import { NextResponse } from "next/server";
import { getAppSettings } from "@/db/queries/settings";

/** Candidate-safe read projection used only to render job age labels. No global configuration. */
export async function GET() {
  return NextResponse.json({ lifecycle: getAppSettings().lifecycle });
}
