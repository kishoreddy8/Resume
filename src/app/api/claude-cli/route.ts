import { NextResponse } from "next/server";
import { getCliStatus } from "@/lib/candidateProfileBuild/cliStatus";

/**
 * GET — whether the local Claude CLI is installed and runnable.
 *
 * Not candidate-scoped and carries nothing about any profile, so it needs no candidate guard. The
 * only thing it discloses is whether a CLI exists on this machine, which the person running the
 * server already knows.
 */
export async function GET() {
  return NextResponse.json(await getCliStatus());
}
