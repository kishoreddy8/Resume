import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { approveProposal, ProposalApprovalError } from "@/db/queries/atsSourceProposals";
import { requireAdminOwner } from "@/lib/auth/guard";

const BODY_SCHEMA = z.object({ reviewNote: z.string().optional() });

/**
 * Discovery V2 Stage 3 — the ONLY endpoint in this whole feature that can ever change a company's
 * active ATS source. Explicit, human-triggered, one proposal at a time — there is deliberately no
 * bulk/auto-approve endpoint anywhere in this codebase. See approveProposal's own doc comment
 * (atsSourceProposals.ts) for the full precondition list this enforces atomically.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; proposalId: string }> }
) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  const { id, proposalId: proposalIdParam } = await params;
  const companyId = Number(id);
  const proposalId = Number(proposalIdParam);
  if (!Number.isInteger(companyId) || !Number.isInteger(proposalId)) {
    return NextResponse.json({ error: "Invalid company id or proposal id" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const proposal = approveProposal(companyId, proposalId, parsed.data.reviewNote);
    return NextResponse.json({ proposal });
  } catch (err) {
    if (err instanceof ProposalApprovalError) {
      const status = err.code === "NOT_FOUND" || err.code === "COMPANY_NOT_FOUND" ? 404 : 409;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
