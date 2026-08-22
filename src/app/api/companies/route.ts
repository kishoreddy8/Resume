import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createCompany, listCompanies, recordDiscoveryResult, updateCompanyH1bConfidence } from "@/db/queries/companies";
import { discoverCompanySource } from "@/lib/ats/discovery";
import { matchCompanyToSponsor, scoreCompanyConfidence } from "@/lib/h1b/fuzzyMatch";
import { isUrlSafeForNavigation } from "@/lib/net/safeFetch";
import type { Company } from "@/types";
import { requireAdminOwner } from "@/lib/auth/guard";

const EXPLICIT_SCHEMA = z
  .object({
    name: z.string().min(1),
    source_type: z.enum(["greenhouse", "ashby", "lever", "workday", "smartrecruiters", "adp_wfn", "adp_rm", "eightfold", "cornerstone", "avature", "paylocity", "icims", "ukg_pro", "bamboohr", "oracle_recruiting_cloud", "workable", "rippling", "paycom", "jazzhr", "jobvite", "breezy", "teamtailor", "applicantpro", "pinpoint", "clearcompany", "personio", "applicantstack", "comeet", "cats", "gohire", "newton", "silkroad", "jobdiva", "taleo", "successfactors", "career_link"]),
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

/**
 * Field sets a caller may ask for, smallest first.
 *
 * OPT-IN, NEVER SUBTRACTIVE. Omitting `fields` returns every column exactly as before, so no
 * existing caller can be broken by this. Each named set was derived by reading what that caller
 * actually touches — see the measurements in the commit that introduced this.
 */
const FIELD_SETS: Record<string, readonly string[]> = {
  /** A name-and-id dropdown. The jobs filter panel renders nothing else. */
  minimal: ["id", "name"],
  /** Connector health tables: identity, source, and why a connector is unhappy. */
  scan: ["id", "name", "source_type", "connector_health", "consecutive_failures", "last_error_category", "last_error_message"],
};

export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("fields");
  // The candidate Jobs page needs only id/name for a filter. Every operational projection and the
  // full registry are Admin data and require an explicitly unlocked owner context.
  if (requested !== "minimal") {
    const authorization = requireAdminOwner(req);
    if (!authorization.ok) return authorization.response;
  }

  const companies = listCompanies();
  const projection = requested ? FIELD_SETS[requested] : undefined;
  if (!projection) {
    /* Unknown or absent value returns the full row rather than erroring: a caller that guesses a
     * field-set name gets correct-but-large data, never a broken page. */
    return NextResponse.json({ companies });
  }

  const projected = companies.map((company) => {
    const row: Record<string, unknown> = {};
    for (const key of projection) row[key] = (company as unknown as Record<string, unknown>)[key];
    return row;
  });
  return NextResponse.json({ companies: projected, fields: requested });
}

export async function POST(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
  const body = await req.json().catch(() => null);

  // Try the auto-detect shape first ({name, url}) — it's the primary flow now. Uses the bounded
  // discovery chain (src/lib/ats/discovery.ts), not the old single-hop detectAtsFromUrl — see
  // AGENTS.md §9-14. The company is always created, regardless of discovery outcome: an unresolved
  // source stays in the registry with its diagnostic fields set, never silently dropped.
  const autoDetect = AUTO_DETECT_SCHEMA.safeParse(body);
  if (autoDetect.success) {
    const company = createCompany({
      name: autoDetect.data.name,
      source_type: "career_link",
      career_page_url: autoDetect.data.url,
      notes: autoDetect.data.notes ?? null,
    });
    const discovery = await discoverCompanySource(autoDetect.data.url);
    const updated = recordDiscoveryResult(company.id, discovery) ?? company;
    finalizeCompany(updated);
    return NextResponse.json(
      { company: updated, detected: discovery.sourceType, resolutionStatus: discovery.status },
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

  // Defense-in-depth: career_page_url is later navigated to by a real headless browser on every
  // scan (src/lib/ats/genericPlaywright.ts, which independently re-checks every navigation/redirect
  // itself). Rejecting an unsafe URL here just avoids silently storing one in the first place — the
  // scan-time check is the one that actually closes the SSRF gap, this is a second, cheap gate.
  if (explicit.data.career_page_url && !(await isUrlSafeForNavigation(explicit.data.career_page_url))) {
    return NextResponse.json(
      { error: { message: "career_page_url resolves to a disallowed (private/loopback/link-local) address" } },
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
  // Not run through discoverCompanySource (the user supplied the exact token/URL directly), but
  // still recorded as resolved — otherwise it would default to resolution_status='UNRESOLVED' and
  // wrongly show up in the Companies page's Unresolved Sources section despite working fine.
  const updated =
    recordDiscoveryResult(company.id, {
      status: explicit.data.source_type === "career_link" ? "GENERIC_SUPPORTED" : "VERIFIED",
      sourceType: explicit.data.source_type === "career_link" ? null : explicit.data.source_type,
      atsBoardToken: explicit.data.source_type === "career_link" ? null : explicit.data.ats_board_token ?? null,
      discoveredJobsUrl: explicit.data.career_page_url ?? null,
      reason: "Manually added with an explicit board token/URL — discovery was not run.",
      suspectedAts: null,
    }) ?? company;
  finalizeCompany(updated);
  return NextResponse.json({ company: updated }, { status: 201 });
}
