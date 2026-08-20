import { NextResponse, type NextRequest } from "next/server";
import { getCandidate } from "@/db/queries/candidates";
import { attemptPin, clearPin, getPinState, setPin } from "@/db/queries/candidatePinStore";
import { isValidPinFormat } from "@/lib/auth/candidatePin";
import { requireOwnerAuthorization } from "@/lib/auth/guard";

/**
 * Set, change or remove a profile PIN.
 *
 * WHO MAY DO IT. Setting the FIRST PIN on an open profile needs no proof — the profile is already
 * open to anyone, so demanding a secret nobody has would make protection impossible to adopt.
 * Changing or removing an EXISTING PIN requires either the current PIN or an unlocked owner
 * session, so someone who wanders up to an unlocked browser cannot quietly re-key a profile, and a
 * person who genuinely forgets theirs is not permanently locked out — the owner can reset it.
 *
 * The PIN is validated as exactly four digits, hashed with scrypt, and never echoed back.
 */
async function readBody(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { pin?: unknown; currentPin?: unknown }
    | null;
  return {
    pin: typeof body?.pin === "string" ? body.pin : "",
    currentPin: typeof body?.currentPin === "string" ? body.currentPin : "",
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  if (!getCandidate(candidateId)) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const { pin, currentPin } = await readBody(req);
  if (!isValidPinFormat(pin)) {
    return NextResponse.json({ error: "PIN must be exactly 4 digits." }, { status: 400 });
  }

  const state = getPinState(candidateId);
  if (state?.hasPin) {
    const ownerDenial = requireOwnerAuthorization(req);
    const currentOk = currentPin ? attemptPin(candidateId, currentPin).ok : false;
    if (!currentOk && ownerDenial) {
      return NextResponse.json(
        {
          error: "Enter the current PIN, or unlock the owner profile to reset it.",
          reason: "current_pin_or_owner_required",
        },
        { status: 403 }
      );
    }
  }

  setPin(candidateId, pin);
  return NextResponse.json({ ok: true, candidateId, hasPin: true });
}

/** DELETE — remove protection. Same authorisation as changing it. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  const state = getPinState(candidateId);
  if (!state) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  if (!state.hasPin) return NextResponse.json({ ok: true, candidateId, hasPin: false });

  const { currentPin } = await readBody(req);
  const ownerDenial = requireOwnerAuthorization(req);
  const currentOk = currentPin ? attemptPin(candidateId, currentPin).ok : false;
  if (!currentOk && ownerDenial) {
    return NextResponse.json(
      { error: "Enter the current PIN, or unlock the owner profile to remove it.", reason: "current_pin_or_owner_required" },
      { status: 403 }
    );
  }

  clearPin(candidateId);
  return NextResponse.json({ ok: true, candidateId, hasPin: false });
}
