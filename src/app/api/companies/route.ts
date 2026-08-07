import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createCompany, listCompanies, updateCompanyH1bSignal } from "@/db/queries/companies";
import { matchCompanyToSponsor } from "@/lib/h1b/fuzzyMatch";

const CREATE_SCHEMA = z
  .object({
    name: z.string().min(1),
    source_type: z.enum(["greenhouse", "ashby", "lever", "career_link"]),
    ats_board_token: z.string().min(1).optional(),
    career_page_url: z.string().url().optional(),
    notes: z.string().optional(),
  })
  .refine(
    (data) =>
      data.source_type === "career_link" ? !!data.career_page_url : !!data.ats_board_token,
    { message: "ats_board_token is required for ATS companies, career_page_url for career_link" }
  );

export async function GET() {
  return NextResponse.json({ companies: listCompanies() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = CREATE_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const company = createCompany({
    name: parsed.data.name,
    source_type: parsed.data.source_type,
    ats_board_token: parsed.data.ats_board_token ?? null,
    career_page_url: parsed.data.career_page_url ?? null,
    notes: parsed.data.notes ?? null,
  });

  // Run the H1B match inline so the company shows a signal immediately, not just after next scan.
  const match = matchCompanyToSponsor(company.name);
  if (match) {
    updateCompanyH1bSignal(
      company.id,
      match.signal,
      match.sponsor.employer_name_raw,
      match.score,
      match.sponsor.total_lca_certified
    );
  }

  return NextResponse.json({ company }, { status: 201 });
}
