import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCompany, listActiveCompanies } from "@/db/queries/companies";
import { runScan } from "@/lib/scan";

const BODY_SCHEMA = z.object({ companyId: z.number().int().optional() });

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  let companies;
  if (parsed.data.companyId) {
    const company = getCompany(parsed.data.companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    companies = [company];
  } else {
    companies = listActiveCompanies();
  }

  if (companies.length === 0) {
    return NextResponse.json({
      results: [],
      jobsNew: 0,
      jobsUpdated: 0,
      jobsClosed: 0,
      errors: 0,
    });
  }

  // A local dev/start process has no serverless request timeout, so running the scan
  // synchronously here (rather than a background job + polling) is fine for a personal tool.
  const summary = await runScan(companies);
  return NextResponse.json(summary);
}
