import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteCompany, getCompany, updateCompany } from "@/db/queries/companies";
import { requireAdminOwner } from "@/lib/auth/guard";

const PATCH_SCHEMA = z.object({
  name: z.string().min(1).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  ats_board_token: z.string().nullable().optional(),
  career_page_url: z.string().url().nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  const { id } = await params;
  const companyId = Number(id);
  if (!Number.isInteger(companyId)) {
    return NextResponse.json({ error: "Invalid company id" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = PATCH_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const company = updateCompany(companyId, {
    ...parsed.data,
    is_active:
      parsed.data.is_active === undefined ? undefined : parsed.data.is_active ? 1 : 0,
  });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  return NextResponse.json({ company });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  const { id } = await params;
  const companyId = Number(id);
  if (!Number.isInteger(companyId)) {
    return NextResponse.json({ error: "Invalid company id" }, { status: 400 });
  }
  const existing = getCompany(companyId);
  if (!existing) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  deleteCompany(companyId);
  return NextResponse.json({ ok: true });
}
