/**
 * PHASE 6.5 — DYNAMIC NAMED-TECHNOLOGY BUDGET.
 *
 * Extracted into its own zero-dependency module (rather than living in presentationContract.ts,
 * where it originated) specifically so professionalIdentity.ts can use the SAME ceiling the reviewer
 * enforces without creating a circular import: presentationContract.ts already imports
 * normalizeRoleTitle from professionalIdentity.ts, so professionalIdentity.ts importing back from
 * presentationContract.ts would cycle. Both modules import from here instead.
 *
 * Replaces a flat SUMMARY_MAX_TECHNOLOGIES=7 ceiling with one scaled to how JD-rich the target role
 * actually is, measured by the count of significant SUPPORTED canonical requirements (technologies
 * AND capabilities) after Phase 6.2 reconciliation — not raw JD length, not every requirement
 * regardless of support. A CEILING, never a target: the writer should use fewer whenever a natural
 * summary doesn't need the full allowance, and this function only ever caps, never requires, a count.
 */

/** Legacy fallback only — used when no significantSupportedTechnologyCount is supplied (a caller with
 *  no canonical reconciliation available). Every canonical-reconciliation-aware caller should prefer
 *  dynamicSummaryTechnologyCeiling below instead of this fixed number. */
export const SUMMARY_MAX_TECHNOLOGIES = 7;

/**
 *   1-5 significant supported requirements  -> ceiling 2
 *   6-10                                    -> ceiling 4
 *   11+                                     -> ceiling 6
 *   0 (no canonical data available)         -> ceiling 2 (most conservative — never blindly permissive)
 */
export function dynamicSummaryTechnologyCeiling(significantSupportedTechnologyCount: number): number {
  if (significantSupportedTechnologyCount <= 0) return 2;
  if (significantSupportedTechnologyCount <= 5) return 2;
  if (significantSupportedTechnologyCount <= 10) return 4;
  return 6;
}
