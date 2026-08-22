import { NextRequest, NextResponse } from "next/server";
import { requireAdminOwner } from "@/lib/auth/guard";
import { listAdminCompanies, type AdminCompanySort } from "@/lib/admin/companies";

export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req); if (!authorization.ok) return authorization.response;
  const q = req.nextUrl.searchParams;
  const page = Math.max(1, Number(q.get("page") ?? 1) || 1);
  const limit = Math.min(100, Math.max(10, Number(q.get("limit") ?? 25) || 25));
  const sortRaw = q.get("sort") ?? "name";
  const sort: AdminCompanySort = sortRaw === "last_scan" || sortRaw === "failures" ? sortRaw : "name";
  return NextResponse.json(listAdminCompanies({ page, limit, search: (q.get("search") ?? "").trim().slice(0, 120), active: q.get("active") ?? "", source: (q.get("source") ?? "").slice(0, 64), health: (q.get("health") ?? "").slice(0, 32), sort }));
}
