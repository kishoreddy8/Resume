import { NextResponse, type NextRequest } from "next/server";
import { UNLOCK_COOKIE, verifyUnlockToken } from "./candidatePin";
import { getPinState, getUnlockSecret, isOwner } from "@/db/queries/candidatePinStore";

/**
 * The single authorisation check for candidate-scoped API routes.
 *
 * WHY THIS IS A HELPER AND NOT MIDDLEWARE. Deciding whether a request is allowed requires knowing
 * whether that profile has a PIN at all, which is a database read — and Next middleware runs on the
 * edge runtime, where better-sqlite3 cannot load. A middleware that only inspected the cookie would
 * have to either gate every profile (locking out the unprotected ones) or gate none.
 *
 * The risk with a helper is that a future route forgets to call it. That is covered by a test which
 * walks every route file under src/app/api, finds the ones that read a candidateId, and fails if
 * one does not call requireCandidateAccess — so completeness is enforced by CI, not by memory.
 */

export type AccessDenial = NextResponse<{ error: string; reason: string; candidateId: number }>;

/**
 * Returns null when the request may proceed, or a response to return immediately.
 *
 * A profile with no PIN is open — see the migration note. Access is granted when the browser holds
 * a valid, unexpired, HMAC-signed unlock token listing this candidate id.
 */
export function requireCandidateAccess(req: NextRequest, candidateId: number): AccessDenial | null {
  const state = getPinState(candidateId);
  if (!state) return null; // Unknown id: let the route's own 404 handling answer, not this.
  if (!state.hasPin) return null; // Unprotected by design.

  const token = req.cookies.get(UNLOCK_COOKIE)?.value;
  const payload = verifyUnlockToken(token, getUnlockSecret());
  if (payload && payload.ids.includes(candidateId)) return null;

  return NextResponse.json(
    {
      error: "This profile is locked. Enter its PIN to continue.",
      reason: "profile_locked",
      candidateId,
    },
    { status: 401 }
  ) as AccessDenial;
}

/**
 * Authorisation for destructive operations. Only the owner may authorise them, and the owner must
 * have unlocked their own profile in this browser — being the owner is not enough on its own, or
 * anyone at the keyboard could delete a profile simply because the owner exists.
 */
export function requireOwnerAuthorization(req: NextRequest): AccessDenial | null {
  const token = req.cookies.get(UNLOCK_COOKIE)?.value;
  const payload = verifyUnlockToken(token, getUnlockSecret());
  const unlocked = payload?.ids ?? [];
  const ownerUnlocked = unlocked.some((id) => isOwner(id));
  if (ownerUnlocked) return null;

  return NextResponse.json(
    {
      error: "Only the owner account can authorise this. Unlock the owner profile and try again.",
      reason: "owner_authorization_required",
      candidateId: 0,
    },
    { status: 403 }
  ) as AccessDenial;
}

/**
 * The owner with no PIN set is a real hole: requireOwnerAuthorization would then be satisfied by
 * nothing at all. Callers of destructive routes use this to refuse rather than silently allow.
 */
export function ownerHasPin(ownerId: number | null): boolean {
  if (ownerId === null) return false;
  return getPinState(ownerId)?.hasPin ?? false;
}
