import type { ConnectorHealth } from "@/types";

/**
 * Rollup label from a company's consecutive_failures streak (see
 * src/db/queries/companies.ts's recordScanFailure, the only writer of this on the failure path —
 * recordScanSuccess always sets 'healthy' directly, recordScanPartial always sets 'degraded'
 * directly, neither goes through this function). Thresholds are a reasonable default, not tuned
 * from real data — a single blip is 'degraded', not 'down', to avoid crying wolf on this dashboard.
 */
export function computeConnectorHealth(consecutiveFailures: number): ConnectorHealth {
  if (consecutiveFailures <= 0) return "healthy";
  if (consecutiveFailures <= 2) return "degraded";
  return "down";
}
