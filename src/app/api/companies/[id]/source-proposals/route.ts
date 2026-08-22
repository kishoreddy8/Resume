import { NextRequest, NextResponse } from "next/server";
import { getCompany } from "@/db/queries/companies";
import { listProposalsForCompany } from "@/db/queries/atsSourceProposals";
import { requireAdminOwner } from "@/lib/auth/guard";

/** Discovery V2 Stage 3 — every proposal (any status) ever created for one company, newest first. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  const { id } = await params;
  const companyId = Number(id);
  if (!Number.isInteger(companyId)) {
    return NextResponse.json({ error: "Invalid company id" }, { status: 400 });
  }
  const company = getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  return NextResponse.json({ proposals: listProposalsForCompany(companyId) });
}
