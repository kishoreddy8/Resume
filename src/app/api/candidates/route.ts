import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createCandidate, listCandidates } from "@/db/queries/candidates";
import { requireProfileCreationAuthorization } from "@/lib/auth/guard";

const CREATE_SCHEMA = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
});

export async function GET() {
  return NextResponse.json({ candidates: listCandidates() });
}

/**
 * ADMIN-SEC-1 — profile creation, guarded without breaking first-run onboarding.
 *
 * This is a real candidate-facing mutation (/candidates/new calls it), and it is also the one
 * mutation with no existing resource to authorise against. Requiring owner authorisation
 * unconditionally would deadlock a fresh install, where no owner exists yet and therefore no owner
 * can ever be unlocked. See requireProfileCreationAuthorization for the full reasoning: creation is
 * open until the install has opted into protection by giving the owner a PIN, after which it needs
 * an unlocked owner session.
 */
export async function POST(req: NextRequest) {
  const denial = requireProfileCreationAuthorization(req);
  if (denial) return denial;

  const body = await req.json().catch(() => null);
  const parsed = CREATE_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const candidate = createCandidate(parsed.data);
  return NextResponse.json({ candidate }, { status: 201 });
}
