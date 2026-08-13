# Claude Task — Continue CareerOps ATS Discovery and Load Jobs Safely

> **Fresh-session entry point:** read `ATS_MULTI_AGENT_HANDOFF.md`, then
> `CLAUDE_ATS_CONTINUATION_RUNBOOK.md`. They contain the
> live-state queries, remaining-adapter workflow, three-job validation contract, and bounded
> U.S.-only first-load plan. Counts later in this historical prompt are checkpoints, not live truth.

You are continuing the isolated ATS/company-discovery branch. Treat the repository, SQLite database,
generated manifest, and tests as authoritative; do not rely on prior chat memory.

## Read first

1. `AGENTS.md`
2. `CAREER_OPS_ATS_DISCOVERY_50K_CHECKPOINT.md`
3. `ATS_DISCOVERY_SOURCE_OF_TRUTH.md`
4. `data/exports/ats-source-of-truth/manifest.json`

Confirm the branch is `codex/ats-job-discovery-50k`. Preserve the unrelated
`.claude/settings.local.json` change and never stage it. Do not commit `data/**`.

## Validate the source package

Run:

```bash
git branch --show-current
git status --short
npm run export-ats-source
npm run verify-ats-source
```

Check that the manifest reports database integrity `ok`, zero foreign-key violations, 67,237
organizations, 80,714 employer provenance records, and hashes for every exported CSV. Counts may
legitimately increase after reviewed discovery/import work; explain every change.

## Immediate work

Continue the registry-wide discovery campaign in resumable HTTP-only cohorts. This command covers
both LCA-backed and PERM-only canonical organizations:

```bash
npm run discover-organizations -- --batch-size 2000
npm run export-ats-source
npm run verify-ats-source
```

Automated structured connectors must remain `review_status=PENDING` until the separate bounded
validator succeeds. Run `npm run validate-pending-connectors -- --batch-size 100 --sample-size 3
--concurrency 3`; it performs read-only ATS probes, never inserts jobs, and stores structured audit
evidence. It first tries explicit-U.S. samples, then uses up to three global samples only to prove
connector operation. Global validation samples are stored in evidence, never in the jobs table;
production loading stays U.S.-only. It rejects deterministic bad configurations and leaves truly
empty/transient outcomes pending.
If any false positive exists, preserve the evidence, harden the resolver, and remediate only the
incorrect derived records after a backup.
The continuous discovery worker also runs this bounded validator after each completed cohort;
do not start a competing validator while that post-cohort step is active. Pending retry outcomes
observe a 24-hour cooldown.
Bulk discovery is owned by the local macOS LaunchAgent `com.careerops.ats-discovery`, which runs
`npm run discover-organizations-continuous`. It executes one locked 2,000-organization cohort,
exports/verifies, writes `data/discovery-reports/cohorts.jsonl`, waits five minutes, and immediately
continues. Do not create/reactivate an hourly discovery schedule or start a second manual cohort
while `data/ats-discovery-worker.lock` belongs to a live process. The old Codex bulk-discovery
automation is paused. Connector review and job loading remain separate manual gates.

The unsupported ATS signature catalog is centralized in `src/lib/ats/unsupportedCatalog.ts` and
currently covers 18 unsupported hosted ATS families. JobDiva, Taleo, ADP Recruiting Management/MyJobs, Eightfold, SmartRecruiters, modern
ADP Workforce Now, exact full-board Paylocity URLs, tenant-hosted iCIMS boards, and exact UKG Pro
Recruiting boards, tenant-hosted BambooHR careers boards, and exact Oracle Recruiting Cloud
host/site boards, account-scoped Workable boards, Rippling Recruiting, Paycom, and exact tenant-scoped
JazzHR boards, exact Jobvite careers-site tenants, tenant-hosted Breezy HR boards, and exact
Teamtailor tenant boards, exact ApplicantPro tenant boards, and exact Pinpoint tenant boards are
supported structured adapters; exact ClearCompany tenants mapped to their same-tenant HRMDirect
boards are also supported.
JobDiva saved-source promotion is connector-scoped through
`npm run promote-supported-saved-sources -- --provider jobdiva`; preview first and use `--apply`
only after a database backup. Its adapter sequentially traverses the stateful public search API and
requires two identical complete snapshots before ingestion.
Legacy `recruiting.adp.com` Recruiting Management is handled separately by the identity-pinned
`adp_rm` MyJobs adapter and its cookie-preserving saved-source resolver. Extend the unsupported
registry and table-driven tests when another vendor is evidenced. `npm run reclassify-ats-adapters` previews saved-URL reclassification;
`-- --apply` requires a backup and reviewed preview. A `NEEDS_ADAPTER` match is never scan approval.

The independent LaunchAgent `com.careerops.ats-browser-discovery` owns the verified-domain Tier-3
queue. It runs 25-company batches at browser concurrency 1 and records every attempt in
`organization_source_discovery_attempts`; do not launch a competing browser batch while its lock is
live. It never loads jobs, never changes domain identity, and never auto-approves a connector.

The independent zero-token LaunchAgent `com.careerops.ats-adapter-profiler` passively profiles up to
three representative `NEEDS_ADAPTER` sources per ATS family. Read
`ats_adapter_profile_runs.csv` or `data/adapter-profiler-reports/latest.json` when choosing the next
adapter. Endpoint evidence is research only: it cannot approve connectors or authorize job loads.

The independent zero-token LaunchAgent `com.careerops.connector-health` rechecks approved structured
sources every 24 hours in bounded batches. Read `connector_health_check_runs.csv` or
`data/connector-health-reports/latest.json`. These checks never load/close jobs, revoke approval, or
replace ingestion scan health; repeated failures are review alerts only.

## Verify job loading first — maximum 3 jobs per company

For development/testing, never load an entire board. Use the bounded verification mode:

```bash
npm run scan-ats-ready -- --sample-size 3
npm run export-ats-source
```

This fetches and stores at most three jobs from each verified company. Sample mode disables company
closures, archives, and the global age sweep. `scan-ats-ready` must remain restricted to active
`VERIFIED`, review-`APPROVED` Greenhouse, Lever, Ashby, Workday, SmartRecruiters, ADP Workforce
Now, Paylocity, iCIMS, UKG Pro Recruiting, BambooHR, Oracle Recruiting Cloud, Workable, Rippling
Recruiting, Paycom, JazzHR, Jobvite, Breezy HR, Teamtailor, ApplicantPro, Pinpoint, and ClearCompany
sources.

The scheduled daily automation currently runs the same three-job verification sample. U.S.-only
filtering and listing-first Workday delta fetching are implemented and tested, but keep the sample
limit until live validation is complete. The first full load must use bounded approved-source
batches, not every source at once. Never let a generic, unresolved, `NEEDS_ADAPTER`, partial, or
failed source perform authoritative job closure.

Generic sources in `generic_additive_ready_sources.csv` may add/update explicit U.S. jobs only.
Require the matching latest validation row to have `can_ingest=1` and always honor
`can_close_missing=0`. Rows in `job_source_validation_samples.csv` are evidence, not jobs to import.
Use `npm run scan-generic-ready`; do not substitute the broad legacy `npm run scan` command.
The LaunchAgent `com.careerops.generic-source-validation` owns continuous generic validation while
its lock is live; Claude should consume its exports, not start a competing validator.

Resume from the verified manifest checkpoint, not from a new seed/import: 67,237 organizations,
2,918 discovery states, 301 domain rows, 303 source rows, 11 approved scan-ready connectors, 51
structured connectors pending review, and 86 current non-archived jobs. The first manual
2,000-company cohort is complete. The continuous worker started from checkpoint 2,918; read its
latest durable report or the live database for current progress and never restart from zero.

Newer connector-validation checkpoint (2026-08-12): 247 supported sources were approved after a
read-only validation pass (96 Workday, 85 Greenhouse, 49 Ashby, 17 Lever), 14 were rejected, and 62
remained pending. Because discovery continues to add candidates, query the live database and rerun
the bounded validator rather than treating those counts as final. Validation itself inserts no jobs.

After the global fallback was enabled, an immediate retry approved 53 of 63 pending/new candidates.
The checkpoint became 300 approved sources (121 Workday, 95 Greenhouse, 63 Ashby, 21 Lever), 10
pending, and 14 rejected. The production jobs table stayed at 99 rows across that validation run.

ADP Workforce Now checkpoint (2026-08-12): the public career-center adapter was added with
one-based pagination, detail retrieval, stable IDs, deduplication, and U.S.-only filtering. Of 36
promoted modern tenants, 34 are approved and two empty boards remain pending. Six legacy ADP
Recruiting Management sources remain `NEEDS_ADAPTER`. Validation inserted no production jobs.
The regenerated verified export contains 387 scan-ready structured sources and 98 current
non-archived jobs. Query the live database/export because discovery workers continue to advance.

Paylocity checkpoint (2026-08-13): the complete public board listing is parsed before detail
fetching, U.S. filtering happens before those detail requests, and selected jobs use full
JobPosting JSON-LD descriptions. Public-host requests are serialized and rate-aware. Thirty-two
exact full-board identities were promoted: seven are approved and 25 safely remain pending due to
empty boards, missing full descriptions, or temporary rate limiting. Validation loaded no jobs;
the jobs table stayed at 99 rows (98 current). Eleven incomplete/detail/legacy URL variants remain
unsupported. For a deliberate Paylocity-only retry use concurrency one:
`npm run validate-pending-connectors -- --provider paylocity --batch-size 100 --sample-size 3
--concurrency 1 --retry-pending-now`.

iCIMS checkpoint (2026-08-13): exhaustive zero-based listing pagination, stable numeric job IDs,
full JobPosting descriptions, and ambiguous-location detail resolution are implemented. Forty
conflict-free tenant hosts were promoted; 18 are approved from genuine U.S. samples and 22 empty
tenants remain pending. Zero were rejected, and validation inserted no production jobs. The live
canary returned three complete U.S. jobs with 7,024–7,250-character descriptions.

UKG Pro Recruiting checkpoint (2026-08-13): its anonymous public session, 50-row `Top`/`Skip`
pagination, `totalCount`, structured locations, stable opportunity UUIDs, and full detail model are
implemented. Thirty-nine exact boards were promoted; 38 approved from genuine U.S. samples and one
empty board remains pending. The live canary exhausted all 119 listings and returned three complete
U.S. jobs. Validation inserted no production jobs.

BambooHR checkpoint (2026-08-13): the public `/careers/list` response is verified against its
`totalCount`, structured country/state/city data is filtered before detail requests, and selected
jobs use full `/careers/{id}/detail` descriptions. Twenty-seven tenant boards were promoted: 23
approved, three safely remain pending, and one false `www.bamboohr.com` tenant was rejected. The
live canary returned both current U.S. jobs with complete descriptions. Validation inserted no
production jobs. The verified export now contains 604 approved structured sources, 219 additive-
ready generic sources, and 98 current jobs.

Oracle Recruiting Cloud checkpoint (2026-08-13): anonymous `findReqs` paging is bounded by
`TotalJobsCount`; ISO country fields are normalized without treating non-U.S. country codes as U.S.
state abbreviations, and selected jobs use full anonymous `ById` detail records. Twenty-four exact
host/site boards were promoted: 23 approved and one empty board remains pending. One saved image
URL stayed unsupported. Validation inserted no production jobs. The verified export now contains
627 approved structured sources, 220 additive-ready generic sources, and 98 current jobs.

Workable checkpoint (2026-08-13): the public careers API is exhausted through opaque `nextPage`
tokens to its exact `total`, structured locations are filtered before `/api/v2` job details, and
description/requirements/benefits are preserved. Twenty account-slug boards were promoted: 17
approved and three empty boards remain pending. Two tenantless `/j/{code}` URLs remain unsupported
until redirect evidence supplies the account slug. Validation inserted no production jobs. The
verified export now contains 644 approved structured sources, 219 additive-ready generic sources,
and 98 current jobs.

ADP backlog correction (2026-08-13): a stale “ADP Recruiting” cluster was separated by exact URL
identity. Seventeen conflict-free modern Workforce Now boards were promoted; one duplicate identity,
one static asset, one legacy Recruiting Management board, and one intermediate redirect were not.
The bounded validator processed those plus newly pending ADP sources, approving 18 and leaving four
empty boards pending. The verified export now contains 662 approved structured sources and 98 jobs.

Rippling Recruiting checkpoint (2026-08-13): public numbered listing pages are verified against
exact totals, structured locations are filtered before UUID job details, and complete descriptions
are preserved. All 19 exact board identities were promoted: 16 approved and three empty boards
remain pending. Validation inserted no production jobs. The verified export now contains 678
approved structured sources, 220 additive-ready generic sources, and 98 current jobs.

Paycom checkpoint (2026-08-13): exact client-key boards bootstrap their anonymous public session,
exhaust count-checked listing pages, filter locations before details, and preserve full description
plus qualifications. All 19 boards were promoted: 17 approved and two empty boards remain pending.
Validation inserted no production jobs. The verified export now contains 695 approved structured
sources, 222 additive-ready generic sources, and 98 current jobs.

JazzHR checkpoint (2026-08-13): exact tenant boards expose the complete listing in initial HTML,
so the connector filters locations before fetching details. Both JobPosting JSON-LD and the older
identity-matched full-description page are supported. All 19 boards were promoted: 18 approved and
one empty board remains pending. Validation inserted no production jobs. The verified export now
contains 713 approved structured sources, 224 additive-ready generic sources, and 98 current jobs.

Jobvite checkpoint (2026-08-13): complete server-rendered job tables are filtered before exact-ID
details; both structured and identity-guarded legacy descriptions are supported. Thirteen exact
tenant boards were promoted: 10 approved and three remain pending because of missing description or
stale redirects. Validation inserted no production jobs. The verified export now contains 723
approved structured sources, 226 additive-ready generic sources, and 98 current jobs.

Breezy HR checkpoint (2026-08-13): complete server-rendered boards deduplicate multi-location cards
by exact position ID and filter before details. All 13 boards were promoted: 10 approved and three
empty boards remain pending. Validation inserted no production jobs. The verified export now
contains 733 approved structured sources, 227 additive-ready generic sources, and 98 current jobs.

Teamtailor checkpoint (2026-08-13): each exact tenant's public `jobs.rss` is a complete snapshot
with full descriptions and structured location metadata, so the U.S. gate runs without detail-page
requests. All five saved tenant boards were promoted and approved from genuine U.S. samples; none
remain pending or rejected. Validation inserted no production jobs. The verified export now
contains 738 approved structured sources, 228 additive-ready generic sources, and 98 current jobs.

ApplicantPro checkpoint (2026-08-13): exact tenant/domain IDs guard a complete count-matched public
listing, structured locations are filtered before details, and descriptions come from the exact
domain-ID/job-ID public endpoint. All eight saved tenant boards were promoted and approved from
genuine U.S. samples; none remain pending or rejected. Validation inserted no production jobs. The
verified export contains 746 approved structured sources, 228 additive-ready generic sources, and
98 current jobs.

Pinpoint checkpoint (2026-08-13): the complete public `postings.json` UI snapshot supplies exact
posting UUIDs, structured locations, and full multi-section descriptions without detail calls. All
three saved tenants were promoted and approved from genuine U.S. samples; none remain pending or
rejected. Validation inserted no production jobs. The verified export contains 749 approved
structured sources, 228 additive-ready generic sources, and 98 current jobs.

ClearCompany checkpoint (2026-08-13): the tenant-scoped public API is identity-checked before
following its exact same-tenant HRMDirect board. The complete all-filter table is non-paginated;
locations are filtered before exact requisition/location details. All eight tenants were promoted:
seven approved from genuine U.S. samples and one empty board remains pending. Validation inserted no
production jobs. The verified export contains 756 approved structured sources, 230 additive-ready
generic sources, and 98 current jobs.

Personio checkpoint (2026-08-13): exact `*.jobs.personio.de` tenant/job URLs normalize to one board,
and the complete public XML feed supplies stable numeric IDs, structured offices, timestamps, and
full multi-section descriptions. Kardion had no U.S. openings, so two genuine global jobs validated
the connector under the explicit fallback; production remains U.S.-only and validation inserted no
jobs. Backup: `data/backups/app.db.pre-personio-2026-08-13T09-15-00Z.bak`. All 826 tests, lint,
TypeScript, webpack build, export, and verification passed. Current verified export: 757 approved
structured sources, 231 additive-ready generic sources, and 98 jobs.

Dayforce is not structured-approved: its ordinary browser UI produced genuine jobs, but the public
search endpoint returned HTTP 403 to server-to-server scanner requests. Leave those sources as
`NEEDS_ADAPTER` and route future coverage through the browser-worker path unless a stable public
server contract is proven.

ApplicantStack checkpoint (2026-08-13): exact tenant opening/detail/apply URLs normalize to one
board. The connector exhausts all 100-row listing pages against the reported total, applies the
U.S. gate before details, removes only pagination navigation parameters, and requires exact
same-tenant canonical/JobPosting identities. Dashiell's canary traversed 204 listings and fetched
three U.S. descriptions of 4,231–5,580 characters. One source was approved, validation inserted no
jobs, and backup `data/backups/app.db.pre-applicantstack-2026-08-13T09-32-00Z.bak` is integrity-ok.
All 829 tests, lint, TypeScript, webpack build, export, and verification passed. Current verified
export: 758 structured sources, 231 additive-ready generic sources, and 98 jobs.

Comeet checkpoint (2026-08-13): exact slug/company-UID/job-UID URLs normalize to one board. The
complete public embedded positions snapshot includes ordered full descriptions and structured
locations; ISO country codes are expanded before the U.S. gate so Israel `IL` cannot be mistaken
for Illinois. Lumus had one genuine non-U.S. hybrid job with a 1,739-character description, approved
under the explicit global fallback while production stays U.S.-only. Validation inserted no jobs.
Backup: `data/backups/app.db.pre-comeet-2026-08-13T09-45-00Z.bak`. All 832 tests and all other gates
passed. Current verified export: 759 structured sources, 231 generic sources, and 98 jobs.

CATS checkpoint (2026-08-13): exact tenant portal/listing/detail/apply URLs normalize to a guarded
`host|portalId` identity. The complete server-rendered listing is filtered for U.S. scope before
details, and every selected numeric job must retain the same tenant, portal, canonical detail, and
apply identity. Canidium returned three genuine U.S. descriptions of 3,053–6,165 characters; two
included salary ranges. One source was approved, no production jobs were inserted, and backup
`data/backups/app.db.pre-cats-2026-08-13T09-55-00Z.bak` is integrity-ok. All 835 tests and all other
gates passed. Current verified export: 760 structured sources, 231 generic sources, and 98 jobs.

GoHire checkpoint (2026-08-13): exact widget URLs normalize to an eight-character client hash. The
complete tenant job array is fetched once and filtered for U.S. scope before exact client/job
details. Troy Web Consulting validated three genuine U.S. jobs with 2,491–4,896-character full
descriptions plus salary, type, and posting dates. One source was approved, no jobs were inserted,
and backup `data/backups/app.db.pre-gohire-2026-08-13T10-00-00Z.bak` is integrity-ok. All 838 tests
and all other gates passed. Current verified export: 761 structured sources, 231 generic sources,
and 98 jobs.

Newton / Recruiting by Paycor checkpoint (2026-08-13): legacy Newton iframe and migrated Paycor
URLs normalize to a 32-hex client ID. The complete CareerHome listing is U.S.-filtered before exact
client/job details. Clinical Ink validated its two clearly U.S. jobs with 2,199- and 4,345-character
full descriptions; bare remote and international rows remained excluded. One source was approved,
no jobs were inserted, and backup `data/backups/app.db.pre-newton-2026-08-13T10-15-00Z.bak` is
integrity-ok. All 841 tests and all other gates passed. Current export: 762 structured sources, 231
generic sources, and 98 jobs.

SilkRoad checkpoint (2026-08-13): bounded rediscovery maps the legacy OpenHire URL to an exact
modern `account|site` identity. The connector exhausts all 13 pages, verifies stable pagination and
unique job IDs, filters U.S. scope before details, and requires exact job/apply identity. Traylor
validated three genuine U.S. descriptions of 6,417–7,272 characters. One source was approved, no
jobs were inserted, and backup `data/backups/app.db.pre-silkroad-2026-08-13T10-30-00Z.bak` is
integrity-ok. All 844 tests and all gates passed. Current export: 763 structured, 231 generic, 98
jobs.

JobDiva checkpoint (2026-08-13): exact portal URLs normalize to
`host|64-character-account|compid|division-IDs`. All 12 saved sources were promoted after backup
`data/backups/app.db.pre-jobdiva-2026-08-13T11-00-00Z.bak`; 11 approved from three genuine U.S.
jobs each and the empty Emonics division-scoped source remains pending. No jobs were inserted.
Stateful pages are fetched sequentially and two identical full snapshots are required, so provider
node drift fails closed. All 847 tests and every gate passed. Current export: 774 structured, 231
generic, 98 jobs; unsupported catalog: 21.

Taleo checkpoint (2026-08-13): exact tenant host/career-section URLs normalize to `host|section`.
Every advertised public faceted-search page is traversed before U.S. filtering; pagination
identity, requisition IDs, contest IDs, titles, detail pages, and apply controls are fail-closed.
UniFirst validated three genuine U.S. jobs with full descriptions. Of four promoted saved sources,
UniFirst approved while HCA, Tetra Tech, and Texas Health remain pending on current public endpoint
failures; none were rejected and no production jobs were inserted. Backup:
`data/backups/app.db.pre-taleo-2026-08-13T11-00-34Z.bak`. All 850 tests and every gate passed.
Current export: 775 structured, 231 generic, 882 current jobs; unsupported catalog: 20.

ADP Recruiting Management checkpoint (2026-08-13): saved legacy srccar links resolve through a
bounded exact-host redirect chain to identity-pinned MyJobs sources. Each scan verifies slug, site
UUID, organization ID, and client ID, obtains a short-lived public token, exhausts the full feed,
and fails closed on pagination drift or incomplete descriptions. Four of seven promoted sources
approved from three genuine U.S. samples each; Lincare, Afni, and Northwood remain pending for
overlapping pages, missing description, and an empty board respectively. No validation jobs were
inserted. Backup: `data/backups/app.db.pre-adp-rm-2026-08-13T11-20-00Z.bak`. All 853 tests and all
gates passed. Export: 779 structured, 232 generic, 1,831 current jobs; unsupported catalog: 19.

Eightfold checkpoint (2026-08-13): exact Eightfold host plus embedded SmartApply employer domain
form the identity. The connector exhausts all exact ten-row pages before U.S. filtering and detail
calls, rejecting count drift, incomplete/duplicate/private jobs, and mismatched canonical details.
Albemarle approved from three genuine U.S. jobs with 5,397–5,794-character descriptions. Chevron
is 404 and Tektronix has no employer tenant identity, so they remain unpromoted. No validation jobs
were inserted. Backup: `data/backups/app.db.pre-eightfold-2026-08-13T11-45-00Z.bak`. All 856 tests
and all gates passed. Export: 780 structured, 232 generic, 1,831 jobs; unsupported catalog: 18.

Cornerstone checkpoint (2026-08-13): adapter #33 is implemented with exact `host|site ID|corp`
identity, fresh anonymous public-token bootstrap, pinned `*.api.csod.com` API origin, exact-count
pagination, complete descriptions, duplicate/count/page safety checks, and structured U.S.
filtering. Colorcon, Turner Construction, and Laerdal each passed a three-U.S.-job canary. All 859
tests, lint, TypeScript, and webpack build passed. After fresh backup
`data/backups/app.db.pre-cornerstone-promotion-2026-08-13T14-42-16Z.bak`, all three were promoted
and approved; the fourth unresolved diagnostic remains `NEEDS_ADAPTER`. No jobs were inserted.
The verified export contains 783 structured, 232 generic, and 1,831 current jobs; manifest hash
`57a69a579ba5bf89b8c77ba436ca9a9e50dfb8f5d98d4c4f72337afe1f49eaa7`. Continue with Avature;
do not redo the Cornerstone research or implementation.

Avature checkpoint (2026-08-13): adapter #34 supports exact TemplateBuilder and legacy portal modes.
MAXIMUS uses a fresh anonymous browser session and two identical job-ID-sorted 266-job snapshots;
Xerox uses two identical exact-count 357-job HTML snapshots. Both were approved from three genuine
U.S. samples; Ross remains `NEEDS_ADAPTER` because its saved talent-community page has no job list.
No jobs were inserted. Backup: `data/backups/app.db.pre-avature-2026-08-13T15-13-30Z.bak`. All 863
tests and all gates passed. Export: 785 structured, 234 generic, 1,831 jobs, 62,839 discovery states;
manifest `8f3da20539910591da68c7955fc484e8553ab047c5ac8d1ee7e1adc5c4c59d78`.

Next adapter evidence: SuccessFactors has 23 diagnostics. Representative career4/career8 tenants
share a public DWR initial-job-search endpoint, but the approval usage limit stopped the empty-search
contract inspection before it ran. Resume by logging only DWR field names/response structure—not
values, cookies, or session material—and require exact count/pagination/detail evidence across two
tenants before implementation. Avature's browser mode received a final per-request SSRF guard after
the recorded 863-test gate; TypeScript/lint pass, and its targeted/full tests should be rerun when
loopback test-server execution is available.

The implementation now enforces both requirements documented in the checkpoint:

- listing-first/delta scanning, especially for Workday, so later scans fetch details only for new or
  changed requisitions; and
- a provider-independent U.S.-only pre-load gate that includes explicit U.S./U.S.-remote and
  multi-location-with-U.S. jobs, excludes explicit non-U.S.-only jobs, and resolves or reports
  unknown/bare-remote locations conservatively before insertion. Remaining `UNKNOWN` locations are
  excluded and make the scan partial, which reports the count and disables lifecycle closure.

## Finish the slice

Run:

```bash
npm test
npm run lint
npm run build -- --webpack
```

Update `CAREER_OPS_ATS_DISCOVERY_50K_CHECKPOINT.md` with exact counts, reviewed domain/source
outcomes, test results, backups, and the next command. Do not commit unless the user requests it.
