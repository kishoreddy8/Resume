import { NextResponse, type NextRequest } from "next/server";
import { deleteCandidate } from "@/db/queries/candidateAdmin";
import { getOwnerId } from "@/db/queries/candidatePinStore";
import { ownerHasPin, requireCandidateAccess, requireOwnerAuthorization } from "@/lib/auth/guard";
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

export async function GET(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await params;
  const candidateId = parseCandidateId(raw);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;
  const candidate = getCandidate(candidateId);
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  return NextResponse.json({ candidate });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await params;
  const candidateId = parseCandidateId(raw);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;
  if (!getCandidate(candidateId)) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const candidate = updateCandidateName(candidateId, parsed.data);
  return NextResponse.json({ ok: true, candidate });
}

/**
 * DELETE — permanently remove a profile. Owner-authorised.
 *
 * Three guards, in this order and for these reasons:
 *
 *  1. The owner must actually have a PIN. Without one, "owner authorisation" would be satisfied by
 *     nothing at all, and this endpoint would be open to anyone who can reach the port. Refusing is
 *     the only safe answer — an authorisation check that cannot fail is not a check.
 *  2. The owner must have unlocked their profile in THIS browser. Being the owner is a property of
 *     the account, not of whoever is sitting at the keyboard.
 *  3. deleteCandidate itself refuses to remove the owner or the last remaining profile, so those
 *     invariants hold even if this route is ever called from somewhere else.
 *
 * The response reports exactly what was removed rather than a bare ok, because this is
 * irreversible and the caller deserves to see the blast radius.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }

  const ownerId = getOwnerId();
  if (!ownerHasPin(ownerId)) {
    return NextResponse.json(
      {
        error:
          "Deleting a profile requires the owner account to have a PIN set. Set the owner PIN first.",
        reason: "owner_pin_not_set",
      },
      { status: 403 }
    );
  }

  const denial = requireOwnerAuthorization(req);
  if (denial) return denial;

  const result = deleteCandidate(candidateId);
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    const error =
      result.reason === "is_owner"
        ? "The owner account cannot be deleted."
        : result.reason === "last_candidate"
          ? "The last remaining profile cannot be deleted."
          : "Candidate not found";
    return NextResponse.json({ error, reason: result.reason }, { status });
  }

  return NextResponse.json({
    ok: true,
    candidateId,
    deletedRows: result.deletedRows,
    filesRemoved: result.filesRemoved,
  });
}
