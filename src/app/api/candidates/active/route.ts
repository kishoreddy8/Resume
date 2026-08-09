import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveCandidateId, requireActiveCandidate, setActiveCandidateId } from "@/db/queries/candidates";

/**
 * The "current candidate" UX default — see CAREER_OPS_HANDOFF.md's Phase 2.5 design record §8/9.
 * This is a convenience default for which candidateId a fresh page load's selector starts on, NOT a
 * source of truth any candidate-scoped write endpoint relies on internally. GET is safe to call from
 * any page on mount; POST is what the candidate selector calls when the user switches.
 */

export async function GET() {
  return NextResponse.json({ candidateId: getActiveCandidateId() });
}

const SET_SCHEMA = z.object({ candidateId: z.number().int().positive() });

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = SET_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  if (!requireActiveCandidate(parsed.data.candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  setActiveCandidateId(parsed.data.candidateId);
  return NextResponse.json({ candidateId: parsed.data.candidateId });
}
