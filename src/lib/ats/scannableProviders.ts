import type { SourceType } from "@/types";

/**
 * ADMIN-OPS-3 — the single list of providers whose sources the job scanner will actually fetch.
 *
 * WHY THIS EXISTS. This set was written out by hand as a SQL `IN (...)` literal in three separate
 * places, and the copies had already drifted: the two scan queries in
 * src/db/queries/organizationRegistry.ts listed 36 providers, while the validation sweep in
 * src/lib/ats/pendingConnectorValidation.ts listed 37 — it also included `phenom`. The consequence
 * is silent: a phenom source can be discovered, validated and approved, and then never scanned by
 * anything, because the query that selects work does not recognise the provider. Nothing fails; the
 * source simply sits there looking ready.
 *
 * WHAT THIS IS NOT. Being on this list means the scanner is WILLING to fetch a provider's sources.
 * It says nothing about whether any source of that provider is registered, whether the last fetch
 * succeeded, or whether Career-Ops can APPLY to that platform — application automation is an
 * entirely separate capability with its own registry (src/lib/apply/agent/selectAdapter.ts) and a
 * far shorter list. Conflating the two is the specific mistake src/lib/operations/atsCapability.ts
 * exists to prevent.
 *
 * ORDER MATCHES THE ORIGINAL SQL so the extraction is reviewable as a pure de-duplication.
 */
export const SCANNABLE_PROVIDERS: readonly SourceType[] = [
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "smartrecruiters",
  "adp_wfn",
  "adp_rm",
  "eightfold",
  "cornerstone",
  "avature",
  "paylocity",
  "icims",
  "ukg_pro",
  "bamboohr",
  "oracle_recruiting_cloud",
  "workable",
  "rippling",
  "paycom",
  "jazzhr",
  "jobvite",
  "breezy",
  "teamtailor",
  "applicantpro",
  "pinpoint",
  "clearcompany",
  "personio",
  "recruitee",
  "applicantstack",
  "comeet",
  "cats",
  "gohire",
  "newton",
  "silkroad",
  "jobdiva",
  "taleo",
  "successfactors",
] as const;

/**
 * THE DRIFT, STATED EXPLICITLY. The same list was hand-written in five places and no two of them
 * agreed. Each constant below preserves its call site's CURRENT membership exactly — nothing here
 * changes what any query selects — but the differences are now expressed as deltas from one baseline
 * instead of hiding inside five SQL literals nobody diffs.
 *
 *   scan (×2, organizationRegistry)      36   baseline
 *   pending-connector validation         37   + phenom
 *   connector health probe               37   + phenom
 *   validate-pending-connectors script   35   − phenom, − recruitee
 *
 * Two independent inconsistencies fall out of that:
 *
 *   `phenom` has a real discovery connector (fetchPhenomJobs, dispatched by src/lib/normalize.ts)
 *   and is both validated and health-probed — but is absent from the scan allowlist, so a phenom
 *   source can be discovered, validated, approved and probed, and then never scanned by anything.
 *
 *   `recruitee` is fully scannable but is missing from the CLI validator's list, so its pending
 *   sources are never picked up by that script.
 *
 * Both are preserved rather than resolved: adding phenom to the scan set would change what the
 * scanner fetches, and removing it from validation would change what gets validated. Those are
 * behaviour changes that belong to a phase that can verify them, not to this extraction.
 */

/**
 * Every ATS platform with a real job-fetch implementation dispatched by fetchJobsForCompany.
 *
 * ADMIN-OPS-3.1 — the "+ phenom" delta is stated exactly ONCE, here. It had been restated in three
 * separate places (the validation set, the health-probe set, and atsCapability's own connector set),
 * which is a smaller version of the seven-way drift this extraction exists to remove: adding a
 * second connector-not-scanned platform would have required editing all three in lockstep.
 *
 * `career_link` is deliberately absent — it is the generic career-page scrape path, not an ATS
 * platform, and every ATS-platform count in the product excludes it.
 *
 * ASSERTED, not derived: the dispatch it mirrors is a `switch` in src/lib/normalize.ts and cannot be
 * enumerated at runtime without parsing source. The agreement is enforced by test instead — see
 * OPS3-SOURCE-02 and OPS3.1-DISPATCH-01, which fail if this set and the dispatch diverge.
 */
export const DISCOVERY_CONNECTOR_PROVIDERS: readonly SourceType[] = [...SCANNABLE_PROVIDERS, "phenom"];

/** Providers the pending-connector validation sweep considers. */
export const VALIDATION_ELIGIBLE_PROVIDERS: readonly SourceType[] = DISCOVERY_CONNECTOR_PROVIDERS;

/** Providers the read-only connector health probe covers. Same membership as validation. */
export const HEALTH_PROBE_PROVIDERS: readonly SourceType[] = DISCOVERY_CONNECTOR_PROVIDERS;

/**
 * Providers the `validate-pending-connectors` CLI passes to the batch. Narrower than both of the
 * above: it omits phenom AND recruitee. The recruitee omission looks unintentional — it is scannable
 * and validation-eligible everywhere else — but correcting it would change which sources the script
 * validates, so it is recorded here for review rather than silently fixed.
 */
export const CLI_VALIDATION_PROVIDERS: readonly SourceType[] = SCANNABLE_PROVIDERS.filter(
  (p) => p !== "recruitee"
);

/** Renders a provider list as the quoted, comma-separated body of a SQL `IN (...)` clause. */
export function providerSqlList(providers: readonly SourceType[]): string {
  return providers.map((p) => `'${p}'`).join(", ");
}
