import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ProposalApprovalError, rejectProposal } from "@/db/queries/atsSourceProposals";

const BODY_SCHEMA = z.object({ reviewNote: z.string().optional() });

/** Discovery V2 Stage 3 — marks a proposal REJECTED. Never touches the company's active source. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; proposalId: string }> }
) {
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
    const proposal = rejectProposal(companyId, proposalId, parsed.data.reviewNote);
    return NextResponse.json({ proposal });
  } catch (err) {
    if (err instanceof ProposalApprovalError) {
      const status = err.code === "NOT_FOUND" ? 404 : 409;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
