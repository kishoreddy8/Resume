import { NextRequest, NextResponse } from "next/server";
import { requireAdminOwner } from "@/lib/auth/guard";
import {
  executeRepair,
  isRepairId,
  REPAIR_DESCRIPTORS,
  REPAIR_INPUT_SCHEMAS,
  type RepairId,
} from "@/lib/operations/repairRegistry";

/**
 * ADMIN-OPS-4 — executes ONE registered repair.
 *
 * The path segment is a key into a closed registry, not an instruction. An unknown id is a 404 and
 * never reaches a handler; the body is parsed by that repair's own strict zod schema, so unexpected
 * keys are rejected rather than forwarded. There is no command, function name, module path, URL or
 * SQL fragment anywhere in the accepted input, and no test seam is reachable from HTTP — the
 * fetcher override exists only in the server-side options type.
 *
 * The response reports what the action did and, separately, what fresh evidence proved. A 200 means
 * the request was handled; it never means the subsystem is fixed. Read `verificationStatus` for that,
 * and note it can say VERIFIED_STILL_FAILING on a perfectly successful 200.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ repairId: string }> }) {
  const authorization = requireAdminOwner(req); if (!authorization.ok) return authorization.response;

  const { repairId } = await context.params;
  if (!isRepairId(repairId)) {
    /* Deliberately does not echo the requested id — it is attacker-controlled text. */
    return NextResponse.json(
      { error: "Unknown repair.", reason: "unknown_repair", registeredActions: Object.keys(REPAIR_DESCRIPTORS) },
      { status: 404 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const parsed = REPAIR_INPUT_SCHEMAS[repairId as RepairId].safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid repair input.", reason: "invalid_input", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await executeRepair(repairId as RepairId, parsed.data as never);

  /* An ineligible repair is a refusal, not a server error: the request was well-formed and the
   * answer is that this repair may not run against this resource right now. */
  const status = result.actionStatus === "REJECTED_INELIGIBLE" ? 409 : 200;
  return NextResponse.json({ descriptor: REPAIR_DESCRIPTORS[repairId as RepairId], result }, { status });
}
