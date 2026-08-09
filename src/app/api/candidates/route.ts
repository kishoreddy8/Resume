import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createCandidate, listCandidates } from "@/db/queries/candidates";

const CREATE_SCHEMA = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
});

export async function GET() {
  return NextResponse.json({ candidates: listCandidates() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = CREATE_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const candidate = createCandidate(parsed.data);
  return NextResponse.json({ candidate }, { status: 201 });
}
