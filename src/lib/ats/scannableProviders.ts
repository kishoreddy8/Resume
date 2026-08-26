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
 * THE TWO HISTORICAL INCONSISTENCIES, NOW DECIDED (ADMIN-OPS-3.2).
 *
 * ADMIN-OPS-3 found this list hand-written in seven places with two disagreements, and deliberately
 * preserved both rather than resolving them without evidence. That evidence has now been gathered.
 *
 * RECRUITEE — stale tooling, fixed. Commit ee00a03 ("add Recruitee job discovery connector") added
 * recruitee to the scan allowlist in organizationRegistry.ts AND to the validation set in
 * pendingConnectorValidation.ts, but not to the list below. No comment anywhere justifies that gap,
 * and every one of its 35 peers is present, so the list below is now simply the scannable set.
 *
 * WHAT THE OMISSION DID AND DID NOT DO — measured, because the obvious guess is wrong. It did NOT
 * strand recruitee sources: the validation batch selects on VALIDATION_ELIGIBLE_PROVIDERS (see
 * pendingConnectorValidation.ts), which has included recruitee since ee00a03, so recruitee sources
 * were always validated and auto-approved like any other. The list below never reaches that query.
 * Its three real effects were narrow: `--provider recruitee` was rejected by the CLI as an invalid
 * argument, recruitee was missing from the continuous worker's approved/pending counts, and it was
 * absent from the scan_ready_sources export. Tooling and reporting only — no scan, approval or
 * fetch behaviour changes in either direction.
 *
 * PHENOM — kept unscannable, deliberately, and NOT for symmetry. Its connector is real and well
 * covered (14 passing tests in __tests__/phenom.test.ts), so "not production ready" is not the
 * reason. The reason is upstream: `src/lib/ats/detect.ts` contains no phenom detector at all, and
 * BOTH discovery paths — discovery.ts and discoveryV2.ts — identify a provider exclusively through
 * detectAtsFromUrlString. discoveryV2's own comment says its SUPPORTED_PROVIDERS set mirrors what
 * detectAtsFromUrlString "can currently produce", so phenom's presence there is unreachable rather
 * than active. No phenom source can therefore be DISCOVERED by any automated path.
 *
 * PRECISELY WHAT THAT DOES AND DOES NOT MEAN. It does NOT mean a phenom row is impossible:
 * job_sources.provider is a bare `TEXT NOT NULL` with no CHECK, enum or foreign key, so a manual
 * insert, an import, or an operator running promote-supported-ats-adapters could create one. (None
 * exist today — both job_sources and companies hold zero phenom rows.) What the omission means is
 * narrower and worth stating exactly: IF such a row existed and were verified and approved, both
 * scan queries in organizationRegistry.ts filter on `js.provider IN (SCANNABLE_PROVIDERS)`, so it
 * would sit approved and never be scanned by anything.
 *
 * That residual trap is why this stays a deliberate decision rather than a fix. Enabling scanning
 * would select zero additional rows today, so it buys nothing; the real blocker is the missing
 * detector, and it belongs to whoever writes one. Meanwhile the trap is no longer silent: the
 * connector-health projection reports phenom as CONNECTOR_NOT_SCANNED alongside its real configured
 * source count, so a phenom source that can never be scanned is visible instead of merely absent.
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
 * Providers the operator-facing tooling covers. Despite the name there are three consumers, and only
 * the first is a CLI: the `--provider` argument allowlist in scripts/validate-pending-connectors.ts,
 * the approved/pending counts in scripts/discover-organizations-continuous.ts, and the
 * scan_ready_sources query in scripts/export-ats-source-of-truth.ts. None of them selects the work a
 * scanner or validation batch performs — those read SCANNABLE_PROVIDERS and
 * VALIDATION_ELIGIBLE_PROVIDERS respectively.
 *
 * ADMIN-OPS-3.2 — exactly the scannable set, for a reason rather than by coincidence: reporting on
 * and hand-validating a source only matters if approving it would let the scanner fetch that source.
 * Phenom is excluded because it is not scannable (see above); recruitee is now included because its
 * absence was a list that was never updated when its connector landed.
 */
export const CLI_VALIDATION_PROVIDERS: readonly SourceType[] = SCANNABLE_PROVIDERS;

/** Renders a provider list as the quoted, comma-separated body of a SQL `IN (...)` clause. */
export function providerSqlList(providers: readonly SourceType[]): string {
  return providers.map((p) => `'${p}'`).join(", ");
}
