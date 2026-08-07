import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { detectAtsFromUrl } from "@/lib/ats/detect";

const SCHEMA = z.object({ url: z.string().url() });

/** Preview-only: detects the ATS for a URL without creating a company. Used for live UI feedback. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const detection = await detectAtsFromUrl(parsed.data.url);
  return NextResponse.json({ detected: detection?.sourceType ?? null, token: detection?.atsBoardToken ?? null });
}
