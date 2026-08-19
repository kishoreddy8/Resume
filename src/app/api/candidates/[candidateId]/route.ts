import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCandidate, updateCandidateName } from "@/db/queries/candidates";

/**
 * Stage 31.1 — correcting a candidate's stored name.
 *
 * Every generated document header, cover-letter signature and output filename is derived from the
 * candidates row, and there was previously no way to change it after creation. A name entered
 * wrongly once therefore propagated into every artifact the pipeline would ever produce.
 *
 * `displayName` is optional and, when given, is stored verbatim rather than rebuilt from the two
 * parts — see updateCandidateName's note on why joining first + last is what causes the drift.
 */
const PatchSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  displayName: z.string().trim().min(1).optional(),
});

function parseCandidateId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await params;
  const candidateId = parseCandidateId(raw);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  const candidate = getCandidate(candidateId);
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  return NextResponse.json({ candidate });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await params;
  const candidateId = parseCandidateId(raw);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!getCandidate(candidateId)) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const candidate = updateCandidateName(candidateId, parsed.data);
  return NextResponse.json({ ok: true, candidate });
}
