import { NextResponse, type NextRequest } from "next/server";
import { getCandidate } from "@/db/queries/candidates";
import { attemptPin, getPinState, getUnlockSecret } from "@/db/queries/candidatePinStore";
import { UNLOCK_COOKIE, UNLOCK_TTL_MS, signUnlockToken, verifyUnlockToken } from "@/lib/auth/candidatePin";

/**
 * POST — exchange a correct PIN for a 30-minute unlock on this browser.
 *
 * The unlock is ADDITIVE: the new id is merged into whatever the cookie already held, so unlocking
 * a second profile does not lock you out of the first. The expiry is refreshed on each successful
 * unlock, which is the intended behaviour — the clock measures time since you last proved yourself,
 * not since the first time.
 *
 * The response never distinguishes "wrong PIN" from "no such profile" in a way that could be used
 * to enumerate accounts beyond the id the caller already supplied.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  if (!getCandidate(candidateId)) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as { pin?: unknown } | null;
  const pin = typeof body?.pin === "string" ? body.pin : "";

  const result = attemptPin(candidateId, pin);
  if (!result.ok) {
    if (result.reason === "locked") {
      return NextResponse.json(
        {
          error: "Too many incorrect attempts. This profile is temporarily locked.",
          reason: "locked",
          retryAfterMs: result.retryAfterMs,
        },
        { status: 429 }
      );
    }
    if (result.reason === "no_pin") {
      return NextResponse.json({ error: "This profile has no PIN set.", reason: "no_pin" }, { status: 400 });
    }
    if (result.reason === "wrong") {
      return NextResponse.json(
        { error: "Incorrect PIN.", reason: "wrong", attemptsRemaining: result.attemptsRemaining },
        { status: 401 }
      );
    }
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }

  const secret = getUnlockSecret();
  const existing = verifyUnlockToken(req.cookies.get(UNLOCK_COOKIE)?.value, secret);
  const ids = Array.from(new Set([...(existing?.ids ?? []), candidateId]));
  const exp = Date.now() + UNLOCK_TTL_MS;
  const token = signUnlockToken({ ids, exp }, secret);

  const res = NextResponse.json({ ok: true, unlockedIds: ids, expiresAt: new Date(exp).toISOString() });
  res.cookies.set(UNLOCK_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(UNLOCK_TTL_MS / 1000),
    // Not `secure`: this app is served over plain http on localhost and the LAN. Setting it would
    // make the cookie silently never send, which would look like "the PIN never works".
  });
  return res;
}

/** DELETE — lock everything again on this browser. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true, unlockedIds: [] });
  res.cookies.set(UNLOCK_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}

/** GET — what this browser currently has unlocked, for rendering the UI without guessing. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  const state = getPinState(candidateId);
  if (!state) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  const payload = verifyUnlockToken(req.cookies.get(UNLOCK_COOKIE)?.value, getUnlockSecret());
  return NextResponse.json({
    candidateId,
    hasPin: state.hasPin,
    isOwner: state.isOwner,
    unlocked: !state.hasPin || Boolean(payload?.ids.includes(candidateId)),
    lockedUntil: state.lockedUntil,
  });
}
