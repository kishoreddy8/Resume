import { NextRequest, NextResponse } from "next/server";
import { getCompany, recordDiscoveryResult } from "@/db/queries/companies";
import { discoverCompanySource } from "@/lib/ats/discovery";

/**
 * "Retry Discovery" — re-runs the bounded discovery chain (src/lib/ats/discovery.ts) for an existing
 * company, keyed off career_page_url, which recordDiscoveryResult always preserves as the original
 * seed URL regardless of resolution outcome (see its own doc comment). User-triggered only (the
 * Companies page's Retry Discovery button) — normal scans reuse the stored resolution and never
 * rediscover automatically (see AGENTS.md §14).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const companyId = Number(id);
  if (!Number.isInteger(companyId)) {
    return NextResponse.json({ error: "Invalid company id" }, { status: 400 });
  }

  const company = getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  if (!company.career_page_url) {
    return NextResponse.json(
      { error: "This company has no source URL on file to retry discovery against (added as a direct ATS board with no career page URL)." },
      { status: 400 }
    );
  }

  const discovery = await discoverCompanySource(company.career_page_url);
  const updated = recordDiscoveryResult(companyId, discovery);

  return NextResponse.json({ company: updated, resolutionStatus: discovery.status, reason: discovery.reason });
}
