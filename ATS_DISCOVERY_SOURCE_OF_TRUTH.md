# CareerOps ATS Discovery Source of Truth

## Purpose

This document defines the durable handoff package for company identity, ATS discovery, and safe job
loading. It lets Claude, Codex, or another agent continue without reconstructing the 67K-company
registry from conversation history.

The live SQLite database is authoritative for mutations. The generated CSV/manifest package is a
portable, auditable snapshot for inspection, ranking, analysis, and handoff. Never edit a CSV and
assume the database changed; implement reviewed changes through the query layer, then regenerate the
package.

## Generate the package

From `codex/ats-job-discovery-50k`:

```bash
npm run migrate
npm run export-ats-source
npm run verify-ats-source
```

`npm run migrate` creates a backup before applying additive schema changes. The export is read-only
and writes to:

```text
data/exports/ats-source-of-truth/
```

The directory is intentionally under gitignored `data/`; it contains a snapshot of the local
CareerOps database and must not be committed.

## Files and authority

| File | Grain | Purpose |
|---|---|---|
| `manifest.json` | One package | Schema version, counts, source URLs, integrity status, file hashes and columns |
| `company_names.csv` | One row per organization | Compact full list of company names and current discovery state |
| `organizations.csv` | One row per organization | Authoritative canonical company list and aggregate discovery coverage |
| `employer_provenance.csv` | One row per source record | Exact H1B/PERM-to-organization provenance; aliases are not companies |
| `domains.csv` | One row per domain assertion | Domain status, method, confidence and evidence |
| `job_sources.csv` | One row per source | ATS board or generic careers source; organizations may have several |
| `ats_discovery_queue.csv` | One row per active organization | Priority fields, current state and next safe action |
| `organization_discovery_state.csv` | One row per searched organization | Durable registry-wide outcome/checkpoint, including PERM-only organizations |
| `browser_source_discovery_attempts.csv` | One row per rendered attempt | Append-only verified-domain Tier-3 audit trail |
| `scan_ready_sources.csv` | One row per verified structured source | The only sources authorized for `scan-ats-ready` |
| `generic_additive_ready_sources.csv` | One row per validated generic source | May add/update U.S. jobs; never close missing jobs |
| `job_source_validation_runs.csv` | One row per validation attempt | Connector version, outcome and production capability flags |
| `job_source_validation_samples.csv` | Up to three rows per validation run | Evidence-only jobs; never production-board rows |
| `ats_adapter_profile_runs.csv` | One row per bounded unsupported-ATS probe | Endpoint shapes and protocol clues; never scan authorization |
| `connector_health_check_runs.csv` | One row per approved-connector health probe | Reachability, empty-board status, latency and errors; never job mutations |
| `current_jobs.csv` | One row per normalized job | Job snapshot without descriptions or candidate-specific state |

## Locked meanings

- Company count = rows in `organizations.csv`. Never count aliases or provenance rows.
- Registry membership does not mean the company has a verified domain.
- A verified domain does not mean an ATS board has been found.
- A generic careers page is never authoritative. After bounded validation it may become
  additive-ready for U.S.-only add/update operations; it still cannot close missing jobs.
- Validation samples stay in `job_source_validation_samples`, never in `jobs`.
- Scan-ready means the active job source is `VERIFIED`, independently review-approved, and uses a
  provider listed by `getApprovedAtsCompanies`; the current set includes the original connectors
  through ADP Recruiting Management/MyJobs. Automated structured findings default to `PENDING`.
- Only a successful structured ATS scan may close missing jobs. Generic, partial, and failed scans
  never close or archive jobs.

## Discovery queue usage

`ats_discovery_queue.csv` is deterministic by `organization_id`. Agents should sort or query using:

1. `priority_tier` ascending.
2. `h1b_recent_year` descending.
3. `total_lca_certified` descending.
4. `perm_certified` descending.
5. `canonical_name`, then `organization_id`.

`discovery_state` and `next_action` are operational instructions:

| State | Allowed action |
|---|---|
| `NEEDS_DOMAIN_DISCOVERY` | Resolve and verify the public domain; do not guess |
| `NEEDS_ATS_DISCOVERY` | Search the already verified domain for ATS/careers sources |
| `REVIEW_EXISTING_SOURCE` | Inspect the matching rows in `job_sources.csv` |
| `READY_TO_SCAN` | Load jobs with the structured connector |

## Safe job loading

### Pending connector validation (no job ingestion)

Validate newly discovered supported sources before allowing them into `scan_ready_sources.csv`:

```bash
npm run validate-pending-connectors -- --batch-size 100 --sample-size 3 --concurrency 3
npm run export-ats-source
npm run verify-ats-source
```

This validator calls the structured ATS endpoints read-only and does **not** insert sample jobs. It
requires the verified domain, organization/company link, provider, source key, and ATS URL identity
to agree, then validates up to three jobs carrying explicit U.S. location evidence. If none exist,
it reads and saves up to three global samples in validation evidence only; those samples never enter
the production jobs table, whose loading scope remains U.S.-only. Successful sources become
`APPROVED`. Deterministic invalid configurations become `REJECTED`. Empty boards, rate limits, and
temporary failures remain `PENDING` with
structured `careerops.connector-validation.v1` evidence and can be retried. Reports are written to
`data/connector-validation-reports/`.

The continuous discovery worker invokes this validator automatically after every 2,000-company
cohort and once when the campaign completes. Newly discovered sources are eligible immediately;
previous `PENDING` validation outcomes observe a 24-hour retry cooldown.
Use `--retry-pending-now` only for an intentional immediate retry after validation logic changes.

Validate generic pages independently, with evidence-only U.S. samples:

```bash
npm run validate-generic-sources -- --batch-size 25 --sample-size 3 --concurrency 1
npm run export-ats-source
npm run verify-ats-source
```

`READY_ADDITIVE` means `can_ingest=1` and `can_close_missing=0`; it is not proof of pagination or
completeness. SmartRecruiters is the first newly added structured adapter and uses its official
public Posting API with offset pagination, stable IDs, detail retrieval and U.S. filtering.
ADP Workforce Now uses the browser-facing public career-center list/detail feed with one-based
pagination, stable requisition IDs, connector-level deduplication, full descriptions, and the same
U.S.-only persistence gate. It does not use ADP's authenticated customer Job Requisitions API.
Legacy `recruiting.adp.com` Recruiting Management pages are a different system from Workforce Now;
they are now resolved to identity-pinned ADP MyJobs sources by the separate `adp_rm` adapter.
Paylocity uses the complete `window.pageData` listing on each public recruiting board, applies the
U.S. gate before detail requests, and reads full descriptions from each selected job's JobPosting
JSON-LD. Public requests are process-wide throttled with bounded `429` retry/backoff.
iCIMS uses exhaustive zero-based `pr` listing pagination and stable numeric job paths. Explicit
non-U.S. listings are excluded before detail requests; ambiguous labels such as bare `Remote` are
resolved through bounded JobPosting JSON-LD details before the final U.S.-only persistence gate.
UKG Pro Recruiting establishes its anonymous public-board session, exhausts the public
`LoadSearchResults` endpoint using `Top`/`Skip` and `totalCount`, filters structured locations, and
reads the full CandidateOpportunityDetail model from selected opportunity pages.
BambooHR verifies the complete public `/careers/list` response against `totalCount`, filters its
structured ATS location before detail requests, and reads full descriptions and published metadata
from `/careers/{id}/detail`.
Oracle Recruiting Cloud exhausts anonymous `findReqs` paging to `TotalJobsCount`, uses structured
country/location evidence before details, and reads the complete anonymous `ById` detail model.
Workable follows its public careers API's opaque `nextPage` tokens to the exact `total`, filters
structured locations before details, and combines full description, requirements, and benefits.

Claude can load only the validated generic set with `npm run scan-generic-ready`. This command
enforces U.S.-only filtering, cannot close missing jobs, and disables the database-wide age sweep.

`com.careerops.generic-source-validation` continuously processes ten generic sources at browser
concurrency one, waits one minute between successful batches, checkpoints by validator version,
and idles for five minutes when no source is eligible. Its lock is
`data/generic-source-validation-worker.lock`; do not run a competing manual batch while it is live.

During development or connector verification, load at most three jobs from each verified source:

```bash
npm run scan-ats-ready -- --sample-size 3
npm run export-ats-source
```

The first command re-queries the live registry, so a stale or hand-edited CSV can never authorize a
scan. Sample mode disables closures, archives, and the global age sweep. The second command refreshes
`current_jobs.csv`, counts, and hashes after the verification load.

The daily automation currently remains in three-job sample mode. The shared U.S.-only gate and
listing-first Workday delta path are implemented and covered by connector/lifecycle tests. Keep the
sample limit until live validation is complete; then switch to bounded full-source batches rather
than enabling every approved board in one run. Continue exporting and verifying the source package.

Current verified export checkpoint: 67,237 organizations, 2,918 discovery states, 301 verified
domains, 303 source rows, 11 scan-ready approved connectors, and 86 current non-archived jobs.
There were 51 structured connector rows pending human review when the continuous worker started at
checkpoint 2,918. Read the live database/report for the current checkpoint; do not restart from zero.

Pending-validation checkpoint (2026-08-12 09:29 Central): the validator processed 315 attempts in
two persisted batches. It promoted 236 previously pending sources, rejected 14 deterministic false
or stale connector identities in total, and retained 62 sources as pending after the full pass.
Together with the 11 earlier manual approvals, the live registry had 247 scan-ready sources:
96 Workday, 85 Greenhouse, 49 Ashby, and 17 Lever. No jobs were inserted by connector validation.
The discovery worker was still running, so always query the live database before quoting counts.

Global-fallback checkpoint (2026-08-12 09:39 Central): an immediate retry examined 63 pending/new
sources, approved 53 using valid global samples where necessary, and left 10 pending. The live
approved total became 300: 121 Workday, 95 Greenhouse, 63 Ashby, and 21 Lever. The production jobs
table remained at 99 rows before and after the persisted fallback run; international validation
samples exist only inside `review_evidence`.

ADP Workforce Now checkpoint (2026-08-12): 36 conflict-free modern tenants were promoted to
bounded validation. Thirty-four were approved from up to three genuine U.S. or evidence-only global
samples; two empty boards remain `PENDING`. The validator saved 93 ADP evidence rows and inserted
zero production jobs. At that checkpoint six legacy ADP Recruiting Management pages remained
`NEEDS_ADAPTER`; they were later handled by the MyJobs checkpoint below. One saved ADP JavaScript
asset was removed as a false positive. Production loading remains U.S.-only.
After regeneration, `scan_ready_sources.csv` contains 387 approved structured sources and
`current_jobs.csv` contains 98 non-archived jobs; package verification passed.

Paylocity checkpoint (2026-08-13): 32 conflict-free full-board identities were promoted to bounded
validation. Seven are approved from genuine job samples; 25 remain `PENDING` because their boards
were empty, omitted a full JobPosting description, or returned a temporary `429`. No source was
rejected and validation inserted zero production jobs; the jobs table remained at 99 rows (98
current). Eleven saved Paylocity Details/Apply, slug-less, or legacy List URL variants remain
unsupported because a complete stable board identity cannot be inferred safely. The pre-change
backup is `data/backups/app.db.pre-migration-2026-08-13T05-27-29-861Z.bak`.

iCIMS checkpoint (2026-08-13): 40 conflict-free tenant hosts were promoted to bounded validation.
Eighteen were approved from three genuine U.S. samples each; 22 empty/no-current-job tenants remain
`PENDING`, and zero were rejected. The live canary returned three U.S. jobs with complete
7,024–7,250-character descriptions, dates, salaries, and stable IDs. Validation inserted no jobs.
The pre-change backup is
`data/backups/app.db.pre-migration-2026-08-13T05-49-01-597Z.bak`.

UKG Pro Recruiting checkpoint (2026-08-13): 39 exact host+tenant+board identities were promoted.
Thirty-eight approved from genuine U.S. samples, one empty Astadia board remains `PENDING`, and
zero were rejected. The live Milliman canary exhaustively paged 119 postings and returned three
U.S. jobs with complete 8,082–9,688-character descriptions, dates, salaries, and stable UUIDs.
Validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-migration-2026-08-13T06-07-00-758Z.bak`.

BambooHR checkpoint (2026-08-13): 27 tenant identities were promoted. Twenty-three approved from
genuine U.S. samples or evidence-only global fallback, three empty/invalid boards remain `PENDING`,
and one false `www.bamboohr.com` tenant was rejected. The live Plus One Robotics canary returned
both current U.S. jobs with complete descriptions, dates, salaries where published, and stable IDs.
Validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-bamboohr-2026-08-13T06-19-43Z.bak`. The verified export contains 604
approved structured sources, 219 additive-ready generic sources, and 98 current jobs.

Oracle Recruiting Cloud checkpoint (2026-08-13): 24 exact host/site identities were promoted.
Twenty-three approved from genuine U.S. samples, one empty Deem board remains `PENDING`, and zero
were rejected. One saved Oracle image URL was not promoted. The live Fortinet canary returned three
U.S. jobs with complete 1,673–4,974-character descriptions, dates, workplace type, salaries where
published, and stable IDs. Validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-oracle-recruiting-cloud-2026-08-13T06-31-34Z.bak`. The verified export
contains 627 approved structured sources, 220 additive-ready generic sources, and 98 current jobs.

Workable checkpoint (2026-08-13): 20 exact account-slug identities were promoted. Seventeen
approved from genuine U.S. samples or evidence-only global fallback, three empty boards remain
`PENDING`, and zero were rejected. Two job-only URLs remain `NEEDS_ADAPTER` because they omit the
account slug. The live TetraScience canary returned three U.S. jobs with complete 3,666–9,637-
character descriptions, dates, workplace types, salaries, and stable shortcodes. Validation
inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-workable-2026-08-13T06-45-56Z.bak`. The verified export contains 644
approved structured sources, 219 additive-ready generic sources, and 98 current jobs.

ADP backlog correction (2026-08-13): exact URL detection separated modern Workforce Now boards
from a stale mixed “ADP Recruiting” label. Seventeen conflict-free modern boards were promoted;
one cross-organization identity conflict and non-board/legacy/redirect URLs remained blocked. The
validator approved 18 pending/new ADP boards and retained four empty boards as `PENDING`. The
pre-change backup is `data/backups/app.db.pre-adp-wfn-reclassification-2026-08-13T06-54-26Z.bak`.
The verified export contains 662 approved structured sources, 219 additive-ready generic sources,
and 98 current jobs.

Rippling Recruiting checkpoint (2026-08-13): all 19 exact board-slug identities were promoted.
Sixteen approved from genuine U.S. samples or evidence-only global fallback, three currently empty
boards remain `PENDING`, and zero were rejected. Embedded, localized, listing, and UUID detail URLs
normalize to one board identity. The connector verifies numbered pagination against `totalItems`
and `totalPages`, filters structured locations before public detail pages, and preserves complete
descriptions. The live Aerospike canary returned three U.S. jobs with 4,647–5,769-character full
descriptions and stable UUIDs. Validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-rippling-2026-08-13T07-10-00Z.bak`. The verified export contains 678
approved structured sources, 220 additive-ready generic sources, and 98 current jobs.

Paycom checkpoint (2026-08-13): all 19 exact 32-character client-key identities were promoted.
Seventeen approved from genuine U.S. samples or evidence-only global fallback, two empty boards
remain `PENDING`, and zero were rejected. The connector obtains the short-lived anonymous session
from each public board, permits only Paycom's fixed public API host, exhausts explicit `skip`/`take`
pagination against the exact count, filters locations before detail calls, and combines full
description and qualifications. The live HealthStream canary returned three U.S. jobs with
6,609–10,010-character descriptions and stable numeric IDs. Validation inserted no jobs. The
pre-change backup is `data/backups/app.db.pre-paycom-2026-08-13T07-24-00Z.bak`. The verified export
contains 695 approved structured sources, 222 additive-ready generic sources, and 98 current jobs.

JazzHR checkpoint (2026-08-13): all 19 exact `{tenant}.applytojob.com/apply` identities were
promoted. Eighteen approved from genuine U.S. samples or evidence-only global fallback, one empty
board remains `PENDING`, and zero were rejected. The connector reads the complete server-rendered
board, applies the U.S. gate before details, and accepts either identity-matched JobPosting JSON-LD
or JazzHR's legacy full-description container guarded by its embedded stable job ID. Live canaries
covered both formats; the legacy Paradromics canary returned three U.S. jobs with 1,734–4,499-
character descriptions. Validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-jazzhr-2026-08-13T07-37-00Z.bak`. The verified export contains 713
approved structured sources, 224 additive-ready generic sources, and 98 current jobs.

Jobvite checkpoint (2026-08-13): 13 exact, conflict-free careers-site tenant identities were
promoted; malformed social/placeholder evidence was not. Ten approved from genuine U.S. samples or
evidence-only global fallback, while three remain `PENDING`: one live posting publishes no
description and two stale tenant URLs redirect away from Jobvite. The connector reads the complete
server-rendered job tables, filters locations before details, and supports both exact-identifier
JobPosting data and the identity-guarded legacy description container. Live RiskSpan and Sikich
canaries returned complete descriptions. Validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-jobvite-2026-08-13T07-51-10Z.bak`. The verified export contains 723
approved structured sources, 226 additive-ready generic sources, and 98 current jobs.

Breezy HR checkpoint (2026-08-13): all 13 exact tenant identities were promoted. Ten approved from
genuine U.S. samples, three currently empty boards remain `PENDING`, and zero were rejected. The
connector reads the complete server-rendered board, collapses multi-location duplicate cards by
stable 12-character position ID, filters before details, and accepts structured JobPosting data or
an exact-position-ID legacy description. Validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-breezy-2026-08-13T08-07-00Z.bak`. The verified export contains 733
approved structured sources, 227 additive-ready generic sources, and 98 current jobs.

Teamtailor checkpoint (2026-08-13): all five exact `{tenant}.teamtailor.com/jobs` identities were
promoted and approved from genuine U.S. samples; none remain pending or rejected. The connector
reads the tenant's public `jobs.rss` complete snapshot, verifies the channel's exact board identity,
filters structured locations before normalization, and preserves the full embedded descriptions,
departments, publication dates, remote status, and stable numeric job IDs. The live PassiveLogic
canary returned three Salt Lake City jobs with 5,957–7,138-character descriptions. Validation
inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-teamtailor-2026-08-13T08-25-00Z.bak`. The verified export contains 738
approved structured sources, 228 additive-ready generic sources, and 98 current jobs.

ApplicantPro checkpoint (2026-08-13): all eight exact tenant identities were promoted and approved
from genuine U.S. samples; none remain pending or rejected. Tenant-hosted listing/detail URLs and
central `www.applicantpro.com/openings/{tenant}/jobs` URLs normalize to one board. The connector
verifies the published board tenant/domain ID, requires the public listing count to equal the full
returned array, applies the U.S. gate to structured country/state/location fields, and then fetches
only selected descriptions from the exact domain-ID/job-ID public detail endpoint. The live MAP
Communications canary returned three Texas jobs with stable numeric IDs and 1,573–2,244-character
descriptions; the older Wegner CPAs shape also passed through the same public detail contract.
Validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-applicantpro-2026-08-13T08-35-00Z.bak`. The verified export contains 746
approved structured sources, 228 additive-ready generic sources, and 98 current jobs.

Pinpoint checkpoint (2026-08-13): all three exact tenant identities were promoted and approved from
genuine U.S. samples; none remain pending or rejected. Root, localized, and UUID posting URLs
normalize to one board. The connector reads the complete public `postings.json` UI snapshot,
verifies exact tenant origins and posting UUIDs, filters structured locations without detail calls,
and preserves full description, responsibilities, skills, benefits, department, workplace,
employment, and compensation fields. The live Utilities One canary returned three U.S. jobs with
3,183–4,101-character descriptions. Validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-pinpoint-2026-08-13T08-45-00Z.bak`. The verified export contains 749
approved structured sources, 228 additive-ready generic sources, and 98 current jobs.

ClearCompany checkpoint (2026-08-13): all eight exact tenant identities were promoted. Seven
approved from genuine U.S. samples, one currently empty Answer Financial board remains `PENDING`,
and zero were rejected. The connector verifies the ClearCompany portal's embedded tenant and
tenant-scoped public API mapping to the exact same-tenant HRMDirect board. It requests the complete
non-paginated all-filter table, treats each requisition/location pair as a stable identity, filters
locations before details, and requires exact detail canonical/apply identities before preserving the
full description. The live PayCargo canary returned three Florida jobs with 2,529–8,990-character
descriptions. Validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-clearcompany-2026-08-13T08-58-00Z.bak`. The verified export contains 756
approved structured sources, 230 additive-ready generic sources, and 98 current jobs.

Personio checkpoint (2026-08-13): the saved exact `*.jobs.personio.de` tenant identity was promoted
and approved using the permitted global fallback because its board currently has no U.S. openings.
The connector reads the complete, non-paginated public XML feed, requires stable numeric IDs,
titles, structured offices, and full multi-section descriptions, and applies the shared U.S. gate
before any normal job load. The live Kardion canary returned two genuine Stuttgart jobs with
1,522–3,941-character descriptions; validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-personio-2026-08-13T09-15-00Z.bak`. All 826 tests, lint, TypeScript, and
the Next.js webpack production build passed. The verified export contains 757 approved structured
sources, 231 additive-ready generic sources, and 98 current jobs.

Dayforce investigation checkpoint (2026-08-13): the current public UI exposes tenant-scoped site,
paginated search, and detail contracts and a normal browser rendered genuine complete jobs. The
same search endpoint returned HTTP 403 to bounded server-to-server requests even after establishing
page cookies, so Dayforce was not promoted as a structured connector. Keep its saved sources in
`NEEDS_ADAPTER`; they are candidates for the browser worker, not the normal structured scanner,
until a stable public server contract is demonstrated.

ApplicantStack checkpoint (2026-08-13): the saved exact tenant was promoted and approved from
three genuine U.S. samples. The connector exhausts the public 100-row HTML pages against their
exact total before selecting locations, normalizes pagination-only detail parameters, and requires
same-tenant canonical detail identity plus matching JobPosting IDs and full descriptions. The live
Dashiell canary traversed all 204 listings but fetched only three selected U.S. details, whose
descriptions were 4,231–5,580 characters. Validation inserted no jobs. The pre-change backup is
`data/backups/app.db.pre-applicantstack-2026-08-13T09-32-00Z.bak`. All 829 tests, lint, TypeScript,
and the Next.js webpack build passed. The verified export contains 758 approved structured sources,
231 additive-ready generic sources, and 98 current jobs.

Comeet checkpoint (2026-08-13): the saved exact slug/company-UID identity was promoted and approved
using one genuine global sample because Lumus currently has no U.S. openings. The connector verifies
the embedded public company identity and complete positions snapshot, requires each canonical URL
to carry the same slug, company UID, and position UID, expands ISO country codes before location
classification, and preserves all ordered description sections. The live hybrid Israel job had a
1,739-character description. Validation inserted no jobs; production remains U.S.-only. Backup:
`data/backups/app.db.pre-comeet-2026-08-13T09-45-00Z.bak`. All 832 tests, lint, TypeScript, webpack
build, export, and verification passed. The verified export contains 759 approved structured
sources, 231 additive-ready generic sources, and 98 jobs.

CATS checkpoint (2026-08-13): exact tenant portal, listing, detail, registration, and apply URLs
normalize to one `host|portalId` source identity. The connector verifies public CATS branding and
portal identity, reads the complete server-rendered listing, applies the U.S. gate before detail
requests, and requires exact same-tenant numeric job and apply identities plus a full rendered job
description. Canidium's live canary returned three genuine U.S. jobs with 3,053–6,165-character
descriptions; two also exposed salary ranges. One source was promoted and approved, validation
inserted no jobs, and backup `data/backups/app.db.pre-cats-2026-08-13T09-55-00Z.bak` is integrity-ok.
All 835 tests, lint, TypeScript, webpack build, export, and verification passed. The verified export
contains 760 approved structured sources, 231 additive-ready generic sources, and 98 jobs.

GoHire checkpoint (2026-08-13): exact public widget URLs normalize to the eight-character client
hash. One listing request returns the complete tenant job array; the U.S. gate runs before exact
client-hash/job-ID details, whose client and job identities must match and whose descriptions must
be complete. Troy Web Consulting returned three genuine U.S. jobs with 2,491–4,896-character
descriptions, salary, type, and posting dates. One source was promoted and approved, no jobs were
inserted, and backup `data/backups/app.db.pre-gohire-2026-08-13T10-00-00Z.bak` is integrity-ok. All
838 tests, lint, TypeScript, webpack build, export, and verification passed. The verified export
contains 761 structured sources, 231 additive-ready generic sources, and 98 jobs.

Newton / Recruiting by Paycor checkpoint (2026-08-13): legacy NewtonSoftware iframe URLs and
migrated Paycor listing/detail/apply URLs normalize to one 32-hex client ID and canonical Paycor
board. CareerHome is a complete server-rendered snapshot; U.S. filtering runs before exact
client-ID/job-ID details, whose apply identity and full description must match. Clinical Ink had
two clearly U.S.-scoped jobs with 2,199- and 4,345-character descriptions; bare-remote and explicit
international rows stayed excluded. One source was approved, no jobs were inserted, and backup
`data/backups/app.db.pre-newton-2026-08-13T10-15-00Z.bak` is integrity-ok. All 841 tests and all
other gates passed. The verified export contains 762 structured sources, 231 generic sources, and
98 jobs.

SilkRoad checkpoint (2026-08-13): the bounded discovery chain maps the saved legacy OpenHire URL
to the exact modern `account|site` board. The connector exhausts all 13 reported pages, rejects
shifted totals and duplicate IDs, applies the U.S. gate before details, and requires exact
board/job/apply identities plus full descriptions. Traylor returned three genuine U.S. jobs with
6,417–7,272-character descriptions, departments, employment type, and salary where published. One
source was approved, no jobs were inserted, and backup
`data/backups/app.db.pre-silkroad-2026-08-13T10-30-00Z.bak` is integrity-ok. All 844 tests and all
other gates passed. The export has 763 structured sources, 231 generic sources, and 98 jobs.

JobDiva checkpoint (2026-08-13): exact public portal URLs normalize to
`host|64-character-account|compid|division-IDs`. The anonymous public API is stateful, so the
connector traverses pages sequentially and requires two identical complete snapshots before the
U.S. gate or details; changing totals, IDs, duplicate rows, or listing/detail 404 drift fail closed
and cannot drive job closure. All 12 saved JobDiva sources were promoted after backup
`data/backups/app.db.pre-jobdiva-2026-08-13T11-00-00Z.bak`; 11 validated from three genuine U.S.
jobs each, while the empty Emonics division-scoped board remains pending. Validation inserted no
jobs. All 847 tests, lint, TypeScript, webpack build, export, and verification passed. The verified
export contains 774 structured sources, 231 generic sources, and 98 jobs. The unsupported catalog
now contains 21 signatures. Twelve Phenom CDN/static-asset false positives were also removed with
the scoped cleanup switch; they were never employer boards.

Taleo checkpoint (2026-08-13): exact tenant host and career-section identities normalize to
`host|section`. The connector verifies the public faceted-search bootstrap, requests every page
advertised by the tenant, rejects changing pagination metadata and duplicate requisition IDs,
applies the U.S. gate before detail requests, and requires matching internal requisition, public
contest, title, detail, and apply identities before preserving full descriptions and
qualifications. Taleo's own `totalCount` can exceed the rows its endpoint returns and intermediate
pages can be short, so those provider quirks are accepted only while all advertised pages remain
bounded and identity-safe. UniFirst's live canary returned three genuine U.S. jobs with
2,329–6,105-character descriptions and published salary where available. Four saved sources were
promoted after backup `data/backups/app.db.pre-taleo-2026-08-13T11-00-34Z.bak`: UniFirst approved;
unreachable HCA, non-public Tetra Tech, and Texas Health's currently failing detail route remain
pending; none were rejected. Validation inserted no jobs. All 850 tests, lint, TypeScript, webpack
build, export, and verification passed. The verified export contains 775 structured sources, 231
generic sources, and 882 current jobs. The unsupported catalog now contains 20 signatures.

ADP Recruiting Management / MyJobs checkpoint (2026-08-13): legacy `recruiting.adp.com/srccar`
boards are resolved through a bounded cookie-preserving exact-ADP redirect chain to MyJobs. The
saved source identity pins the MyJobs slug, career-site UUID, organization ID, and ADP client ID;
each scan re-verifies all four fields and obtains a short-lived public token rather than storing
credentials. The public feed contains count, structured locations, stable requisition IDs, and
full descriptions. It is exhausted before the U.S. gate and uses requisition ID as a deterministic
posting-date tie-breaker; duplicate/shifted pagination fails closed. American Woodmark's live
canary returned three genuine U.S. jobs with 2,323–3,880-character descriptions. Seven saved
legacy boards were promoted after backup `data/backups/app.db.pre-adp-rm-2026-08-13T11-20-00Z.bak`:
American Woodmark, Data Axle, Schneller, and Follett approved; Lincare's live feed still overlaps
pages, Afni publishes a row with no full description, and Northwood is empty, so those three remain
pending. None were rejected and validation inserted no jobs. All 853 tests, lint, TypeScript,
webpack build, export, and verification passed. The verified export contains 779 structured
sources, 232 generic sources, and 1,831 current jobs. The unsupported catalog now has 19 signatures.

Eightfold checkpoint (2026-08-13): exact `*.eightfold.ai` host plus the SmartApply embedded employer
domain form the source identity. The connector verifies the server-rendered tenant/count bootstrap,
exhausts the public API in exact ten-row offset pages, rejects changed counts, incomplete pages,
private or duplicate job IDs, filters structured locations before details, and requires matching
numeric job/title/canonical identities plus a non-empty full description. Albemarle's 42-row live
board returned three genuine U.S. jobs with 5,397–5,794-character descriptions, departments, work
location type, and provider dates. Of three saved records, Albemarle was promoted and approved;
Chevron's saved board is 404 and Tektronix points to a generic Eightfold app without employer
identity, so those records remain `NEEDS_ADAPTER`. Validation inserted no jobs. Backup:
`data/backups/app.db.pre-eightfold-2026-08-13T11-45-00Z.bak`. All 856 tests, lint, TypeScript,
webpack build, export, and verification passed. Export: 780 structured sources, 232 generic sources,
and 1,831 current jobs. The unsupported catalog now has 18 signatures.

Cornerstone implementation checkpoint (2026-08-13): exact `*.csod.com` host, career-site ID, and
corporation key form the source identity. Each scan obtains a fresh short-lived anonymous token
from the public server-rendered bootstrap, pins the advertised API to `*.api.csod.com`, exhausts the
exact-count 25-row feed, rejects count drift, incomplete pages, duplicates, missing job identity,
or empty descriptions, and applies the U.S. gate to structured locations before returning jobs.
Colorcon, Turner Construction, and Laerdal each returned three genuine U.S. canary jobs with full
descriptions (904–3,410 characters). All 859 tests, lint, TypeScript, and the webpack production
build passed. Backup: `data/backups/app.db.pre-cornerstone-2026-08-13T11-56-10Z.bak`.

Cornerstone promotion completed after fresh backup
`data/backups/app.db.pre-cornerstone-promotion-2026-08-13T14-42-16Z.bak`: Colorcon, Turner
Construction, and Laerdal were promoted and all three approved from three genuine U.S. samples
each. The fourth diagnostic Cornerstone record remains `NEEDS_ADAPTER` because it did not resolve
to an exact public board. Validation inserted zero jobs. The final verified export contains 783
approved structured sources, 232 generic sources, and 1,831 current jobs; manifest SHA-256 is
`57a69a579ba5bf89b8c77ba436ca9a9e50dfb8f5d98d4c4f72337afe1f49eaa7`.

Avature checkpoint (2026-08-13): adapter #34 explicitly supports two proven public portal modes.
TemplateBuilder boards such as MAXIMUS use a fresh anonymous Chromium session, job-ID sorting, and
two identical complete exact-count JSON snapshots before U.S. filtering. Legacy boards such as
Xerox traverse every advertised five-row HTML page twice and require identical 357-job snapshots.
Both modes reject count drift, page shifts, duplicates, tenant/detail identity mismatches, and empty
descriptions. MAXIMUS and Xerox each approved from three genuine U.S. samples; Ross remains
`NEEDS_ADAPTER` because its saved URL is a talent-community page, not a job listing. No jobs were
inserted. Backup: `data/backups/app.db.pre-avature-2026-08-13T15-13-30Z.bak`. All 863 tests, lint,
TypeScript, webpack build, database integrity, export, and verification passed. Export: 785
structured sources, 234 generic sources, 1,831 current jobs, 62,839 discovery states; manifest
`8f3da20539910591da68c7955fc484e8553ab047c5ac8d1ee7e1adc5c4c59d78`.

Worker startup reliability checkpoint (2026-08-13): process initialization no longer rewrites all
67,237 legacy companies on every web/worker connection. The idempotent migration now projects only
legacy rows missing an organization link; ordinary company writes retain their exact dual-write
sync. This removed the recurring multi-worker `SQLITE_BUSY` startup contention while preserving
the registry backfill regression contract.

Continuous discovery is now controlled by the user LaunchAgent `com.careerops.ats-discovery` using
`npm run discover-organizations-continuous`. It holds `data/ats-discovery-worker.lock`, processes
one 2,000-company cohort at a time, exports and verifies after every cohort, writes durable JSONL
reports under `data/discovery-reports/`, sends a native macOS completion notification, waits five
minutes, and continues. The old two-hour Codex discovery automation is paused.

A separate user LaunchAgent, `com.careerops.ats-browser-discovery`, runs
`npm run discover-organization-sources-browser-continuous` in parallel. It touches only companies
whose domains are already `VERIFIED` and whose HTTP source result is generic, unresolved, missing,
or temporarily failed. It processes 25 organizations per batch at browser concurrency 1, writes an
append-only database audit plus reports under `data/browser-source-discovery-reports/`, and never
re-resolves company identity or loads jobs. Structured findings remain `PENDING` until the existing
connector validator approves them. Its lock is `data/ats-browser-discovery-worker.lock`.

Unsupported ATS discovery uses the centralized, extensible catalog in
`src/lib/ats/unsupportedCatalog.ts`. As of 2026-08-13 it contains 18 conservative unsupported hosted-platform
signatures. Matches are diagnostic `NEEDS_ADAPTER` records only and never authorize job loading.
Run `npm run reclassify-ats-adapters` for a read-only preview and add `-- --apply` only after a
backup/review. The reclassifier is idempotent and also removes known vendor legal/static-asset
false positives. Unknown/custom systems remain `GENERIC_SUPPORTED` or `UNRESOLVED`; never guess.

The zero-token adapter profiler runs independently as `com.careerops.ats-adapter-profiler`. It
samples at most three sources per unsupported ATS family and records redacted endpoint shapes,
public API hints, tenant keys, and pagination clues in `ats_adapter_profile_runs`. It uses bounded
public HTTP requests only; it never calls an AI service, loads jobs, changes source status, or
approves a connector. Run one batch manually with `npm run profile-ats-adapters`, or inspect
`data/adapter-profiler-reports/latest.json`. Evidence guides which adapter to implement next.
Use only the newest `profiler_version` for adapter decisions; v2 excludes common CDN JavaScript,
logo, favicon, and social-image false signals discovered during the first evidence review.

The zero-token connector-health worker runs as `com.careerops.connector-health`. It checks one
global sample from ten approved structured sources per batch, at concurrency two, with a 24-hour
per-source interval. `HEALTHY_EMPTY` means the endpoint completed successfully but currently listed
no jobs; it is distinct from a provider/network failure. The worker writes append-only evidence and
reports under `data/connector-health-reports/`. It never inserts or closes jobs, changes approval,
or overwrites `companies.connector_health`, which remains the result of real ingestion scans.

Do not use the general `npm run scan` command for this handoff workflow: it includes generic career
pages, while `scan-ats-ready` intentionally restricts execution to verified structured connectors.

## Current gate

The first 25-employer canary found a false Wikidata domain and expansion was stopped. The resolver
was hardened to require matching first-party identity evidence. Before a 1,000-company discovery
pilot, run a second 25-employer HTTP-only canary and manually inspect every `VERIFIED` result:

```bash
npm run discover-employers -- --batch-size 25 --no-browser
npm run export-ats-source
```

Do not authorize the 1,000-company pilot until the reviewed VERIFIED sample contains no false
positive domain.

## Verification checklist

After every export:

1. Read `manifest.json` and confirm `schemaVersion` is `careerops-ats-source-v1`.
2. Confirm `integrityCheck` is `ok` and `foreignKeyViolations` is `0`.
3. Confirm every listed file exists and its SHA-256 matches the manifest.
4. Confirm organizations are not counted from `employer_provenance.csv`.
5. Confirm every `scan_ready_sources.csv` row has a matching active `job_sources.csv` row.
6. Update `CAREER_OPS_ATS_DISCOVERY_50K_CHECKPOINT.md` with outcomes and exact next action.

## Official source

The employer seed data comes from the U.S. Department of Labor OFLC disclosure program:

- https://www.dol.gov/agencies/eta/foreign-labor/performance
- https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/PERM_Disclosure_Data_FY2025_Q4.xlsx
