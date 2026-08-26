import { HEALTH_PROBE_PROVIDERS, providerSqlList } from "./scannableProviders";

/**
 * UI-ADMIN-1.1 — the single definition of "a source the connector probe may touch".
 *
 * WHY THIS EXISTS. The same predicate had been written out by hand three times: the scheduled
 * checker's candidate query (connectorHealthCheck.ts), the repair controller's single-source lookup
 * (repairRegistry.ts), and the console's "is there anything here to check" lookup
 * (discoveryConnectorHealth.ts). Each was copied deliberately and each carried a comment promising
 * it matched the others — which is exactly what the seven-way provider-list drift said before it
 * turned out to be false in two places.
 *
 * The consequences of drift here are not cosmetic. If the console's copy is looser than the repair's,
 * Admin offers a button that answers 409. If it is tighter, a source that could be checked is
 * silently unoffered. If either drifts from the checker's, the repair reaches a source the scheduled
 * probe would refuse to touch — the boundary ADMIN-OPS-4 wrote its eligibility predicate to enforce.
 *
 * Expressed as a SQL fragment rather than a helper because the three callers need it in different
 * shapes — one row by id, one row per provider, and a windowed batch with its own cooldown clause —
 * and they already share the `js` (job_sources) and `c` (companies) aliases.
 */
export const PROBE_ELIGIBLE_SOURCE_SQL = `js.is_active = 1 AND js.is_authoritative = 1
          AND js.resolution_status = 'VERIFIED' AND js.review_status = 'APPROVED'
          AND js.provider IN (${providerSqlList(HEALTH_PROBE_PROVIDERS)})
          AND c.is_active = 1`;
