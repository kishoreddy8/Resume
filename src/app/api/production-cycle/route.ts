import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runProductionCycle } from "@/lib/production/orchestrator";
import { getProductionCycleLockStatus } from "@/lib/production/state";
import { requireAdminOwner } from "@/lib/auth/guard";

/**
 * ADMIN-OPS-5 — the accepted body, stated explicitly.
 *
 * The route used to assign the entire parsed JSON body to the orchestrator's options. That type also
 * carries test seams (recoveryRunner, builtInSearcher, discoverer, heartbeatIntervalMs) and an
 * `atsCompanies` list that REPLACES the scan target set. Functions cannot survive JSON, but
 * atsCompanies is plain data: a caller could have directed the server to fetch boards of their
 * choosing instead of the registry's. Scan targets must come from listScanReadyCompanies(), so the
 * field is simply not accepted here, and neither is anything else that is not an operational knob.
 *
 * .strict() so an unknown key is a 400 rather than something silently forwarded. Bounds mirror the
 * documented limits on the options type rather than inventing new ones.
 */
const BODY_SCHEMA = z
  .object({
    reliabilityLimit: z.number().int().min(1).max(25).optional(),
    discoveryV2Limit: z.number().int().min(1).max(25).optional(),
    builtInRoles: z.array(z.string().min(1).max(200)).max(50).optional(),
    builtInLimitPerRole: z.number().int().min(1).max(100).optional(),
    builtInMaxTotalUnique: z.number().int().min(1).max(1000).optional(),
    skipPhases: z
      .array(z.enum(["reliability", "atsScan", "builtIn", "crossSourceDedup", "discoveryV2"]))
      .max(5)
      .optional(),
  })
  .strict();

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

    const body = await req.json().catch(() => ({}));
    const parsed = BODY_SCHEMA.safeParse(body ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid production cycle options.", reason: "invalid_input", issues: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const summary = await runProductionCycle(parsed.data);
    return NextResponse.json({ summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("already running")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
