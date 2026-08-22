import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCompany, listActiveCompanies } from "@/db/queries/companies";
import { acquireScanLock, releaseScanLock } from "@/lib/scheduler/lock";
import { runScanWithIncrementalMatching } from "@/lib/scan/runScanWithMatching";
import { requireAdminOwner } from "@/lib/auth/guard";

const BODY_SCHEMA = z.object({ companyId: z.number().int().optional() });

export async function POST(req: NextRequest) {
  const authorization = requireAdminOwner(req);
  if (!authorization.ok) return authorization.response;
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
      affectedJobDedupeKeys: [],
      matching: null,
      notifications: null,
    });
  }

  // Shares the exact same lock primitive as the scheduler tick (src/lib/scheduler/lock.ts) — a
  // manual scan and a scheduled scan can never run concurrently against the same DB, and a manual
  // scan naturally recovers from an abandoned scheduled lock (and vice versa) via the same
  // stale-lock takeover, with no separate "explicit takeover" mechanism needed.
  const lockResult = acquireScanLock();
  if (!lockResult.acquired) {
    return NextResponse.json(
      {
        error: "SCAN_ALREADY_RUNNING",
        message: "A scan is already in progress. Try again once it completes.",
        heldSince: lockResult.heldSince,
      },
      { status: 409 }
    );
  }

  try {
    // A local dev/start process has no serverless request timeout, so running the scan
    // synchronously here (rather than a background job + polling) is fine for a personal tool.
    // Shares the exact same post-scan orchestration as the scheduler tick (Phase 4 Stages 2 & 4) —
    // see src/lib/scan/runScanWithMatching.ts. Scan fields stay flattened at the top level of the
    // JSON response (unchanged from before Stage 2) for backward compatibility with existing
    // consumers (src/app/jobs/page.tsx casts this response `as ScanSummary` and reads e.g.
    // `.jobsNew` at the top level) — `matching`/`notifications` are added as new sibling keys, not
    // nested inside a breaking wrapper.
    const { scan, matching, notifications } = await runScanWithIncrementalMatching(companies);
    return NextResponse.json({ ...scan, matching, notifications });
  } finally {
    releaseScanLock();
  }
}
