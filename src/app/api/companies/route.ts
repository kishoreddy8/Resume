import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createCompany, listCompanies, updateCompanyH1bConfidence } from "@/db/queries/companies";
import { detectAtsFromUrl } from "@/lib/ats/detect";
import { matchCompanyToSponsor, scoreCompanyConfidence } from "@/lib/h1b/fuzzyMatch";
import type { Company, SourceType } from "@/types";

const EXPLICIT_SCHEMA = z
  .object({
    name: z.string().min(1),
    source_type: z.enum(["greenhouse", "ashby", "lever", "workday", "career_link"]),
    ats_board_token: z.string().min(1).optional(),
    career_page_url: z.string().url().optional(),
    notes: z.string().optional(),
  })
  .refine(
    (data) =>
      data.source_type === "career_link" ? !!data.career_page_url : !!data.ats_board_token,
    { message: "ats_board_token is required for ATS companies, career_page_url for career_link" }
  );

// The primary flow: paste a company name + any careers URL, let the server figure out the rest.
const AUTO_DETECT_SCHEMA = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  notes: z.string().optional(),
});

function finalizeCompany(company: Company) {
  // Run the H1B match inline so the company shows a confidence immediately, not just after the
  // next `npm run match-h1b`. Always writes (even a plain "Unknown" with its evidence) so the
  // company profile is never left with stale defaults.
  const match = matchCompanyToSponsor(company.name);
  const { confidence, evidence } = scoreCompanyConfidence(match);
  updateCompanyH1bConfidence(company.id, {
    confidence,
    matchEmployerName: match?.sponsor.employer_name_raw ?? null,
    matchNormalized: match?.matchedNormalized ?? null,
    matchTier: match?.tier ?? null,
    matchScore: match?.score ?? null,
    lcaCount: match?.sponsor.total_lca_certified ?? 0,
    latestFiscalYear: match?.sponsor.most_recent_fiscal_year ?? null,
    evidence,
  });
}

export async function GET() {
  return NextResponse.json({ companies: listCompanies() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  // Try the auto-detect shape first ({name, url}) — it's the primary flow now.
  const autoDetect = AUTO_DETECT_SCHEMA.safeParse(body);
  if (autoDetect.success) {
    const detection = await detectAtsFromUrl(autoDetect.data.url);
    const company = createCompany({
      name: autoDetect.data.name,
      source_type: (detection?.sourceType ?? "career_link") as SourceType,
      ats_board_token: detection?.atsBoardToken ?? null,
      career_page_url: autoDetect.data.url,
      notes: autoDetect.data.notes ?? null,
    });
    finalizeCompany(company);
    return NextResponse.json(
      { company, detected: detection?.sourceType ?? null },
      { status: 201 }
    );
  }

  // Fall back to the explicit shape (source_type + token/url given directly) for programmatic
  // use or manual override when auto-detection isn't what the user wants.
  const explicit = EXPLICIT_SCHEMA.safeParse(body);
  if (!explicit.success) {
    return NextResponse.json(
      { error: autoDetect.error.flatten(), explicitShapeError: explicit.error.flatten() },
      { status: 400 }
    );
  }

  const company = createCompany({
    name: explicit.data.name,
    source_type: explicit.data.source_type,
    ats_board_token: explicit.data.ats_board_token ?? null,
    career_page_url: explicit.data.career_page_url ?? null,
    notes: explicit.data.notes ?? null,
  });
  finalizeCompany(company);
  return NextResponse.json({ company }, { status: 201 });
}
