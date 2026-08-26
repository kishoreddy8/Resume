import { NextRequest, NextResponse } from "next/server";
import { requireAdminOwner } from "@/lib/auth/guard";
import { getDiscoveryConnectorHealth } from "@/lib/operations/discoveryConnectorHealth";
import { REPAIR_DESCRIPTORS, repairabilityFor } from "@/lib/operations/repairRegistry";

/**
 * ADMIN-OPS-3.2 — JOB DISCOVERY connector health.
 *
 * Named for discovery specifically, not "atsHealth": Career-Ops has two distinct ATS integrations —
 * fetching jobs (this route, ~37 platforms) and submitting applications (3 adapters, reported
 * elsewhere) — and a route named for "ATS" in general would be read as covering both.
 *
 * Additive. It replaces nothing and no existing consumer changes.
 */
export async function GET(req: NextRequest) {
  const authorization = requireAdminOwner(req); if (!authorization.ok) return authorization.response;

  const params = req.nextUrl.searchParams;
  const clamp = (raw: string | null, fallback: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Number(raw ?? fallback) || fallback));

  /* ADMIN-OPS-4 — repairability is attached here rather than inside the projection, so the health
   * module stays a pure reading of evidence with no knowledge of what anyone might do about it. */
  const connectors = getDiscoveryConnectorHealth({
    probeWindowHours: clamp(params.get("probeWindowHours"), 168, 1, 720),
    scanWindowHours: clamp(params.get("scanWindowHours"), 24, 1, 168),
  }).map((row) => ({ ...row, ...repairabilityFor(row) }));

  /* Counts are derived here rather than written down, and providers with no evidence are counted as
   * exactly that — never folded into a healthy total to make coverage look complete. */
  const tally = (pick: (c: (typeof connectors)[number]) => string) =>
    connectors.reduce<Record<string, number>>((acc, c) => {
      const k = pick(c);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});

  return NextResponse.json({
    scope: "JOB_DISCOVERY",
    connectors,
    totals: {
      connectors: connectors.length,
      scannable: connectors.filter((c) => c.capability === "SCANNABLE").length,
      configuredSources: connectors.reduce((n, c) => n + (c.configuredSourceCount ?? 0), 0),
      byPrimaryEvidence: tally((c) => c.primaryEvidence),
      byProductionStatus: tally((c) => c.production.status),
      byProbeStatus: tally((c) => c.probe.status),
      byRepairability: tally((c) => c.repairability),
    },
    /* The closed set of repairs that exist at all, so a future UI never has to guess. Descriptors
     * only — no handler names, no input plumbing, no internals. */
    repairCatalog: Object.values(REPAIR_DESCRIPTORS),
  });
}
