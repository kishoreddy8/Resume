import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { discoverCompanySource } from "@/lib/ats/discovery";

const SCHEMA = z.object({ url: z.string().url() });

/** Preview-only: runs the bounded discovery chain for a URL without creating a company. Used for
 *  live UI feedback before the user submits the "Add company" form. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const discovery = await discoverCompanySource(parsed.data.url);
  return NextResponse.json({
    detected: discovery.sourceType,
    token: discovery.atsBoardToken,
    resolutionStatus: discovery.status,
    discoveredJobsUrl: discovery.discoveredJobsUrl,
    reason: discovery.reason,
    suspectedAts: discovery.suspectedAts,
  });
}
