import { NextResponse, type NextRequest } from "next/server";
import { UNLOCK_COOKIE, verifyUnlockToken } from "./candidatePin";
import { getOwnerId, getPinState, getUnlockSecret, isOwner } from "@/db/queries/candidatePinStore";
import { requireActiveCandidate, type CandidateRow } from "@/db/queries/candidates";

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

export type AdminOwnerAuthorization =
  | { ok: true; candidateId: number; candidate: CandidateRow }
  | { ok: false; response: AccessDenial };

/**
 * Canonical authorization boundary for global Admin HTTP routes.
 *
 * The candidate id is deliberately explicit. Global endpoints must never inherit the UI's active
 * candidate or silently fall back to candidate 1: the request names the profile whose unlocked
 * owner session is authorising the operation. Client-side `is_owner` checks remain useful product
 * affordances, but this is the security boundary.
 */
export function requireAdminOwner(req: NextRequest): AdminOwnerAuthorization {
  const raw = req.nextUrl.searchParams.get("candidateId");
  const candidateId = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "An explicit owner candidateId is required for Admin access.",
          reason: "admin_context_required",
          candidateId: 0,
        },
        { status: 400 }
      ) as AccessDenial,
    };
  }

  const candidate = requireActiveCandidate(candidateId);
  if (!candidate) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "The Admin candidate context is invalid or inactive.",
          reason: "admin_context_invalid",
          candidateId,
        },
        { status: 404 }
      ) as AccessDenial,
    };
  }

  if (candidate.is_owner !== 1) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Only the owner account can access system operations.",
          reason: "admin_owner_required",
          candidateId,
        },
        { status: 403 }
      ) as AccessDenial,
    };
  }

  // Owner status alone is never sufficient. This reuses the existing signed, expiring PIN unlock
  // contract, including its fail-closed behavior when the owner has no PIN or the token is stale.
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return { ok: false, response: accessDenial };
  if (!getPinState(candidateId)?.hasPin) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Set and unlock the owner PIN before using Admin operations.",
          reason: "admin_owner_pin_required",
          candidateId,
        },
        { status: 403 }
      ) as AccessDenial,
    };
  }

  return { ok: true, candidateId, candidate };
}

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

/**
 * ADMIN-SEC-1 — the guard for profile creation, which is neither an ordinary candidate mutation nor
 * an ordinary operator one.
 *
 * WHY IT CANNOT SIMPLY BE requireOwnerAuthorization. Owner is seeded from the lowest-numbered
 * EXISTING candidate (see runCandidatePinMigrations), so on a brand-new install there is no owner at
 * all. Requiring owner authorisation to create a profile would make the first profile impossible to
 * create and leave the product permanently unusable — the guard would be perfectly secure and
 * completely broken. First-run creation therefore has to be allowed.
 *
 * WHY IT IS NOT SIMPLY LEFT OPEN EITHER. Once an install is set up, an unauthenticated caller
 * creating unlimited profiles is real: it cannot read anyone's data, but it is an unauthenticated
 * write to shared state, and profile creation is the one mutation that has no owner to check against
 * afterwards.
 *
 * SO PROTECTION FOLLOWS THE INSTALL'S OWN CHOICE, exactly as requireCandidateAccess already does
 * one function above: a profile with no PIN is "unprotected by design" there, and an install whose
 * owner has set no PIN is unprotected by design here. Enforcing owner authorisation on a PIN-less
 * install would be stricter than every other candidate route in the same app and would break adding
 * a second profile for users who never opted into a PIN — inconsistency, not security.
 *
 *   no candidates yet        -> allow  (first-run bootstrap; nothing exists to authorise against)
 *   owner has no PIN         -> allow  (install is unprotected by design, same as every other route)
 *   owner has a PIN          -> require an unlocked owner session
 *
 * Deliberately NOT reused for destructive routes. Deleting a profile keeps the stricter
 * ownerHasPin + requireOwnerAuthorization pair, which refuses outright on a PIN-less install —
 * correct there, because that action is irreversible and creation is not.
 */
export function requireProfileCreationAuthorization(req: NextRequest): AccessDenial | null {
  const ownerId = getOwnerId();
  if (ownerId === null) return null;
  if (!ownerHasPin(ownerId)) return null;
  return requireOwnerAuthorization(req);
}
