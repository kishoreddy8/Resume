import { NextRequest, NextResponse } from "next/server";
import { getCompany, recordDiscoveryResult } from "@/db/queries/companies";
import { discoverCompanySource } from "@/lib/ats/discovery";
import { requireAdminOwner } from "@/lib/auth/guard";

/**
 * "Retry Discovery" — re-runs the bounded discovery chain (src/lib/ats/discovery.ts) for an existing
 * company, keyed off career_page_url, which recordDiscoveryResult always preserves as the original
 * seed URL regardless of resolution outcome (see its own doc comment). User-triggered only (the
 * Companies page's Retry Discovery button) — normal scans reuse the stored resolution and never
 * rediscover automatically (see AGENTS.md §14).
 *
 * Rate-limited: unlike the batch discovery priority query (src/lib/discovery/priority.ts), which
 * already cooldown-gates FAILED_TEMPORARY retries, this manual endpoint previously had NO cooldown
 * at all — a script could hammer it against the same company with zero server-side throttling. A
 * shorter cooldown than the batch's 24h is deliberate: this is a single, user-initiated action on
 * one company, not an unattended bulk process, so a tighter window is appropriate.
 */
const MANUAL_RETRY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
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

  if (company.discovery_attempted_at) {
    const elapsedMs = Date.now() - new Date(company.discovery_attempted_at).getTime();
    if (elapsedMs < MANUAL_RETRY_COOLDOWN_MS) {
      const retryAfterMs = MANUAL_RETRY_COOLDOWN_MS - elapsedMs;
      return NextResponse.json(
        {
          error: `Discovery was already attempted recently for this company. Try again in ${Math.ceil(retryAfterMs / 60000)}m.`,
          retryAfterMs,
        },
        { status: 429 }
      );
    }
  }

  const discovery = await discoverCompanySource(company.career_page_url);
  const updated = recordDiscoveryResult(companyId, discovery);

  return NextResponse.json({ company: updated, resolutionStatus: discovery.status, reason: discovery.reason });
}
