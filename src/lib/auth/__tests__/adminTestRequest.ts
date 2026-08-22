import { NextRequest } from "next/server";

/** Build a real unlocked-owner request against the caller's already-configured isolated test DB. */
export async function adminTestRequest(
  pathname: string,
  init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {}
): Promise<NextRequest> {
  const { getOwnerId, getUnlockSecret, setPin } = await import("@/db/queries/candidatePinStore");
  const { signUnlockToken, UNLOCK_COOKIE } = await import("@/lib/auth/candidatePin");
  const ownerId = getOwnerId();
  if (ownerId === null) throw new Error("Admin route test database has no owner candidate");
  setPin(ownerId, "1739");
  const token = signUnlockToken({ ids: [ownerId], exp: Date.now() + 60_000 }, getUnlockSecret());
  const separator = pathname.includes("?") ? "&" : "?";
  const url = `http://localhost${pathname}${separator}candidateId=${ownerId}`;
  const headers = new Headers(init.headers);
  headers.set("cookie", `${UNLOCK_COOKIE}=${token}`);
  return new NextRequest(url, { ...init, headers });
}
