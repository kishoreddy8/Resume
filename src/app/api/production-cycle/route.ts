import { NextRequest, NextResponse } from "next/server";
import { runProductionCycle } from "@/lib/production/orchestrator";
import { getProductionCycleLockStatus } from "@/lib/production/state";
import { requireAdminOwner } from "@/lib/auth/guard";

export async function POST(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  try {
    const lockStatus = getProductionCycleLockStatus();
    if (lockStatus.held) {
      return NextResponse.json(
        { error: `Production cycle is already running (locked since ${lockStatus.acquiredAt})` },
        { status: 409 }
      );
    }

    let options = {};
    try {
      const body = await req.json();
      if (typeof body === "object" && body !== null) {
        options = body;
      }
    } catch {
      // Empty body is fine
    }

    const summary = await runProductionCycle(options);
    return NextResponse.json({ summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("already running")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
