# Career-Ops 50K ATS/Job Discovery — Active Branch Checkpoint

## Status

- **Branch:** `codex/ats-job-discovery-50k`
- **Branch base:** `9538f08` (`feat: add candidate-scoped tailoring run API`)
- **Initiative status:** Stage 2 complete; 67,237 canonical organizations seeded; Stage 3 pilot is next
- **Last updated:** 2026-08-11
- **Scope owner:** the user; this file is the durable handoff for Claude, Codex, or another coding agent

This is a living checkpoint. Update it after every completed implementation slice. A new agent must
read this file, `AGENTS.md`, the relevant code, and the relevant Next.js guide before changing code.
Code and tests win if this document ever disagrees with the repository.

## Scope boundary

This branch is exclusively for scaling employer identity, ATS source discovery, job-source storage,
connector coverage, and scheduled job ingestion toward a registry of 50,000+ companies.

In scope:

- Build a canonical organization registry from DOL LCA/PERM and selected authoritative sources.
- Allow one organization to have multiple legal-name aliases, domains, and ATS/job sources.
- Resolve and verify domains without guessing or silently merging ambiguous companies.
- Discover and validate ATS boards at scale.
- Add connectors based on measured coverage, initially Workable and Recruitee if the pilot confirms
  they are the highest-value next adapters.
- Add resumable, adaptive, rate-limited discovery and scanning.
- Preserve current dedupe, lifecycle, H1B, candidate-isolation, and matching behavior.
- Keep a local/SQLite development path while defining a safe production-scale persistence path.

Out of scope unless the user explicitly expands it:

- Phase 3 resume or cover-letter generation.
- Auto-application or submission to ATS platforms.
- Scraping candidate data or authenticated application forms.
- Replacing deterministic matching with AI.
- Migrating the entire application to hosted infrastructure before the local pilot proves the model.

## Current verified baseline

At branch creation, the live local database contained:

| Entity | Count |
|---|---:|
| `h1b_sponsors` | 44,697 |
| `companies` | 13 |
| `jobs` | 54 |
| `employer_identity_resolutions` | 22 |
| `discovery_runs` | 2 |
| `scan_runs` | 17 |

Company source state at branch creation:

- Greenhouse, Lever, Ashby, and Workday connector implementations exist.
- Company rows: 1 Ashby, 1 Workday, 11 `career_link`.
- Resolution: 2 `VERIFIED`, 6 `GENERIC_SUPPORTED`, 1 `NEEDS_ADAPTER`, 4 `UNRESOLVED`.
- The one recorded unsupported ATS was SuccessFactors.

Never commit `data/app.db` or any candidate/master/generated files. Treat them as sensitive.

## Existing foundations to reuse

- `src/lib/companyIdentity/**` — domain candidate generation, verification, SEC/Wikidata evidence.
- `src/lib/discovery/batch.ts` — bounded, resumable small-batch employer discovery.
- `src/lib/discovery/priority.ts` — deterministic H1B employer discovery priority.
- `src/lib/ats/discovery.ts` — bounded HTTP ATS discovery and unsupported-platform detection.
- `src/lib/ats/discoveryBrowser.ts` — tightly bounded, SSRF-guarded browser fallback.
- `src/lib/ats/{greenhouse,lever,ashby,workday}.ts` — structured connectors.
- `src/lib/ats/smartrecruiters.ts` — official Posting API connector with exhaustive pagination,
  stable IDs, details and U.S.-only filtering.
- `src/lib/ats/adpWorkforceNow.ts` — public career-center connector with one-based pagination,
  stable requisition IDs, deduplication, full details and U.S.-only filtering.
- `src/lib/ats/genericPlaywright.ts` — best-effort generic fallback; never authoritative for closure.
- `src/lib/net/safeFetch.ts` — mandatory SSRF-safe network boundary for discovery.
- `src/lib/scan.ts` and `src/lib/scan/**` — current ingestion, retry, health, and lifecycle safeguards.
- `src/db/queries/atsCoverage.ts` and `/ats-coverage` — current coverage reporting.

Do not build a parallel implementation of these responsibilities. Extend or refactor the existing
modules with regression tests.

## Hard invariants

1. Failed, partial, or generic scans never close/archive jobs.
2. Job identity remains deterministic; AI never computes or changes `dedupe_key`.
3. A different authoritative external job ID is a different requisition.
4. Candidate-specific state stays isolated in candidate-scoped tables.
5. Employer identity and ATS-source resolution remain separate evidence axes.
6. Ambiguous legal names/domains are queued for review, never silently merged.
7. Every network navigation goes through the existing SSRF-safe boundary.
8. Prefer documented public APIs/feeds; never bypass auth, CAPTCHA, or access controls.
9. Respect robots rules and provider/host rate limits; honor `429` and `Retry-After`.
10. Schema migrations are additive and tested against a throwaway copy before the live DB.
11. The existing `.claude/settings.local.json` modification is unrelated and must not be staged.

## Generic validation and adapter expansion (2026-08-12)

- Added append-only `job_source_validation_runs` and `job_source_validation_samples`; three-job
  validation probes never write to the production `jobs` table.
- Generic pages can become only `READY_ADDITIVE`: U.S.-only add/update is permitted, while
  pagination/completeness and `can_close_missing` remain false.
- Added `validate-generic-sources` plus source-of-truth exports for readiness and evidence samples.
- Promoted SmartRecruiters from unsupported detection to a structured provider adapter. Existing
  discovered tenants can be promoted to `PENDING` and passed through bounded connector validation.

## Required architectural correction

The present `companies` row combines canonical employer identity and exactly one source
(`source_type`, `ats_board_token`, `career_page_url`). At 50K scale this is insufficient because one
organization may have several legal entities, domains, subsidiaries, regions, and ATS boards.

Target logical model (names may be refined during Stage 1, but responsibilities must remain):

| Entity | Responsibility |
|---|---|
| `organizations` | Canonical public organization identity |
| `organization_aliases` | DOL/SEC/legal/former/trade names with provenance |
| `organization_domains` | Candidate and verified domains with evidence/status |
| `job_sources` | One ATS board or generic careers source per row |
| `source_resolution_attempts` | Append-only discovery evidence and outcome |
| `source_crawl_state` | Scheduling, lease, cursor, ETag, backoff, and health |
| `jobs` | Normalized posting linked to a source as well as organization |
| `manual_review_queue` | Ambiguous identity/source cases requiring a decision |

Compatibility must be explicit: existing routes and queries may continue reading `companies` during
an incremental transition. Do not perform a big-bang destructive migration.

## Implementation stages

### Stage 0 — Baseline and design tests

- [x] Capture current full test/lint/build results on this branch.
- [x] Add migration fixtures covering a company with multiple job sources and multiple aliases.
- [x] Write an approved schema/compatibility decision in this document before migration code.
- [x] Define metrics separately for registry organizations, verified domains, verified job sources,
      active hiring sources, and active jobs.

Exit gate: tests prove the intended multi-source relationships and preservation of current rows.

### Stage 1 — Additive organization/source registry

- [x] Add the new canonical organization, alias, domain, and job-source tables additively.
- [x] Backfill current companies into organizations and job sources idempotently.
- [x] Preserve existing company/job IDs and behavior during transition.
- [x] Add query-layer APIs; routes must not contain raw SQL.
- [x] Add coverage and migration tests, including re-running backfill safely.

Exit gate: the current app works unchanged while the new registry can represent multiple sources.

**Exit gate passed on 2026-08-11.** Compatibility decision and implementation record:

- `companies` remains the live scan/API interface; no existing ID or foreign key was replaced.
- `organization_company_links` is the explicit bridge. It permits several reviewed legacy company
  rows to map to one organization while each company maps to exactly one organization.
- `job_sources.legacy_company_id` is the dual-write compatibility key. Provider promotion updates
  that source in place rather than creating a duplicate.
- No fuzzy/name/domain auto-merge exists. A duplicate provider/source identity raises a uniqueness
  error for review.
- Existing company creation, edits, ATS discovery promotion, and verified-domain updates dual-write
  transactionally through `src/db/organizationRegistryCore.ts`.
- The canonical name follows a legacy company only while the mapping is one-to-one. After a reviewed
  multi-company merge, an arbitrary sync cannot overwrite the chosen canonical name.

Metric definitions locked for later reporting:

- registry organizations = rows in `organizations` excluding inactive/merged records;
- verified domains = distinct organizations with a `VERIFIED` `organization_domains` row;
- verified job sources = active `job_sources` with `resolution_status='VERIFIED'`;
- active hiring sources = verified sources whose latest successful listing contains active jobs;
- active jobs = current non-archived postings, never inferred from registry/source counts.

Verification record:

- Baseline before changes: 728 tests passing.
- After Stage 1: 735 tests passing, 0 failing; lint clean.
- Default Turbopack build was blocked by the execution sandbox when its CSS worker attempted to bind
  a local port. The documented `next build --webpack` path compiled, type-checked, generated all 27
  pages, and completed successfully.
- Throwaway-copy migration preserved companies=13, jobs=54, h1b_sponsors=44,697, and
  employer_identity_resolutions=22; produced organizations=13, links=13, aliases=13, domains=11,
  job_sources=13; `integrity_check=ok`, zero FK violations, zero unlinked companies/sources.
- Live migration used automatic backup
  `data/backups/app.db.pre-migration-2026-08-11T16-02-18-667Z.bak` and produced the same counts and
  integrity results. The final idempotent resync after timestamp/canonical-name hardening created
  `data/backups/app.db.pre-migration-2026-08-11T16-04-31-021Z.bak`; counts and integrity remained
  identical.

### Stage 2 — Seed ingestion to 50K candidates

- [x] Reuse the 44,697 H1B sponsor rollups as the first source.
- [x] Add DOL PERM ingestion with raw filing aggregates and normalized employer provenance.
- [x] Skip SEC seeds because exact-deduplicated DOL sources already exceed 50K.
- [x] Never count raw aliases as canonical companies.
- [x] Produce a deterministic registry report and automated collision/integrity audit.

Exit gate: at least 50,000 canonical candidate organizations, with source provenance and measured
identity quality. This is a registry target, not a claim that all 50K have usable ATS boards.

**Exit gate passed on 2026-08-11.** Stage 2 implementation and evidence:

- Added idempotent `perm_employer_filings` keyed by normalized employer, fiscal year, and official
  dataset variant. This preserves both FY2024 form datasets without double-counting a rerun.
- Added derived `perm_employers` and generic `organization_employer_records` provenance links.
- `scripts/ingest-perm.ts` stores only employer name and determination totals; source contact and
  personal fields are intentionally excluded.
- `scripts/seed-organization-registry.ts` exact-matches the existing DOL normal form only. It does
  not perform fuzzy, domain, parent/subsidiary, or ATS inference. An ambiguous match is kept as a
  separate candidate rather than silently merged.
- Official source: `https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/PERM_Disclosure_Data_FY2025_Q4.xlsx`
  (148,659 data rows; source SHA-256
  `33554317b020289edb4e34d40ede6f9cf3c3ecbdb7334b7398eb9b7dbb44edbe`).
- FY2025 produced 36,017 normalized PERM employers; 1,603 rows with blank employer names were
  skipped. The H1B + PERM source pool contains 80,714 provenance records.
- Final canonical registry: 67,237 organizations, including 67,224 seed-only candidates and the 13
  application organizations. Exact cross-source consolidation linked 13,490 source rows during the
  initial run; 13,479 organizations have both LCA and PERM provenance.
- Idempotency rerun: organizations remained exactly 67,237; all 80,714 source links refreshed and
  zero organizations were created. `PRAGMA integrity_check` returned `ok`; foreign-key check
  returned zero rows.
- Automatic backups before the schema/live seed steps:
  `data/backups/app.db.pre-migration-2026-08-11T16-14-26-401Z.bak` and
  `data/backups/app.db.pre-migration-2026-08-11T16-14-46-418Z.bak`.
- Stage 2 tests cover dataset replacement vs official form variants, exact H1B/PERM consolidation,
  idempotent reseeding, ambiguous-name separation, and discovery promotion into the seeded org.
- Final gate: 739 tests passing, zero failing; lint clean; `next build --webpack` compiled,
  type-checked, and generated all 27 pages successfully.

### Stage 3 — 1,000-organization discovery pilot

- [ ] Select the top 1,000 by recent immigration activity and deterministic priority.
- [ ] Run HTTP discovery first; browser fallback only for verified domains unresolved over HTTP.
- [ ] Persist each stage/outcome immediately so interruption is safe.
- [ ] Produce actual domain/ATS resolution rates and ranked `NEEDS_ADAPTER` counts.
- [ ] Manually audit a sample of VERIFIED, AMBIGUOUS, and UNRESOLVED outcomes.

Exit gate: measured precision is acceptable to the user and the connector backlog is evidence-based.

**25-employer HTTP-only canary on 2026-08-11 (pre-pilot safety gate):**

- Outcomes: 4 domain `VERIFIED`, 5 `AMBIGUOUS`, 11 `UNRESOLVED`, 5 `FAILED_TEMPORARY`;
  2 generic careers pages resolved and zero structured ATS boards verified.
- The seeded-organization compatibility bridge worked: four live company rows were promoted into
  their existing DOL organizations and the canonical organization count remained exactly 67,237.
- Manual review accepted ByteDance (`bytedance.com`), Kforce (`kforce.com`), and PayPal
  (`paypal.com`) as plausible. It rejected Qualcomm -> `consumerrights.wiki`, a bad live Wikidata
  P856 claim that the previous rule treated as self-sufficient.
- Expansion stopped immediately. `verifyDomainIdentity` now requires at least one matching
  first-party identity channel for Wikidata/redirect/SEC corroboration. A regression test locks the
  rule, and a live read-only Qualcomm rerun now returns `UNRESOLVED`.
- The false derived Qualcomm company/domain/source rows had zero jobs and were removed after backup
  `data/backups/app.db.pre-migration-2026-08-11T16-21-09-040Z.bak`; its canonical organization and
  H1B/PERM provenance remain intact. Final database integrity is `ok` with zero FK violations.
- Current live metrics after remediation: organizations=67,237; companies=16; the three accepted
  canary domains remain linked. This result is not precise enough to authorize the 1,000-company
  expansion without another canary under the hardened rule.

**Durable source-of-truth and job-loading handoff added on 2026-08-11:**

- `ATS_DISCOVERY_SOURCE_OF_TRUTH.md` defines file grains, authority, metric meanings, queue usage,
  verification, discovery, and safe job-loading commands.
- `CLAUDE_ATS_JOB_LOADING_PROMPT.md` is the self-contained prompt the user can give Claude after
  its limit resets. `CLAUDE.md` points Claude to both files automatically on this branch.
- `npm run export-ats-source` generates a read-only snapshot under
  `data/exports/ats-source-of-truth/`: full company names, canonical organizations, DOL provenance,
  domains, job sources, ATS queue, scan-ready sources, current jobs, and a hashed manifest.
- `npm run verify-ats-source` streams every CSV, verifies every SHA-256 and row count, and reconciles
  the one-row-per-organization/provenance invariants. Latest verification passed for 67,237 company
  names, 67,237 organization rows, 80,714 provenance records, 67,237 queue rows, 14 domains,
  16 sources, 2 scan-ready structured sources, and 54 current jobs.
- `npm run scan-ats-ready` re-queries live registry state and loads jobs only from active VERIFIED
  Greenhouse/Lever/Ashby/Workday sources. It cannot be authorized by editing a CSV and excludes
  generic/unresolved/NEEDS_ADAPTER sources.
- Live proof after automatic backup
  `data/backups/app.db.pre-migration-2026-08-11T16-44-46-586Z.bak`: Ostium/Ashby refreshed two
  jobs, ULResearchInstitute/Workday refreshed two jobs, zero new/closed jobs, and zero errors.
- A formatted companion workbook was generated for human review; the CSV/manifest package remains
  the complete machine-readable source snapshot. The workbook's catalog is intentionally a compact
  priority sample because the complete 67,237-row catalog is `company_names.csv`.

**Second 25-employer HTTP-only canary and first expanded job load on 2026-08-11:**

- Outcomes under the hardened rule: 3 domain `VERIFIED`, 5 `AMBIGUOUS`, 13 `UNRESOLVED`, and
  4 `FAILED_TEMPORARY`; 1 structured ATS source and 2 generic careers pages were resolved.
- Every VERIFIED result was manually checked against first-party pages: Uber -> `uber.com`,
  Virtusa -> `virtusa.com`, and Elevance Health -> `elevancehealth.com`. No false-positive domain
  was accepted in this canary.
- Elevance Health resolved to Workday token `elevancehealth|wd1|ANT`. A direct call to its public
  Workday listing endpoint returned 329 open postings, confirming the connector before loading.
- Workday detection now normalizes individual job/apply URLs to the stable board root
  `https://elevancehealth.wd1.myworkdayjobs.com/ANT`; a regression test covers this case.
- Before loading, the database was backed up to
  `data/backups/app.db.pre-elevance-scan-2026-08-11T16-58.bak`.
- `npm run scan-ats-ready` loaded 329 new Elevance jobs, refreshed 4 existing structured-source
  jobs, closed 0, and reported 0 errors. Existing age-retention rules then removed/archive-filtered
  older postings; the source-of-truth export contains 239 active, unarchived jobs.
- The refreshed verified package contains 67,237 canonical organizations, 80,714 provenance rows,
  17 verified domain rows, 19 job-source rows, 3 scan-ready structured sources, and 239 current jobs.
- Test gate after Workday URL normalization: 740 passing, zero failing.

**Next 100-employer cohort (partial) on 2026-08-11:**

- The process persisted 57 employer outcomes, then a malformed remote HTTP response triggered an
  internal Node/Undici parser assertion. Because results are stored per employer, the 57 completed
  outcomes survived; the aggregate `discovery_runs` row was correctly not written for an incomplete
  run. Backup: `data/backups/app.db.pre-discovery-100-2026-08-11T17-00.bak`.
- Partial outcomes: 9 `VERIFIED`, 5 `AMBIGUOUS`, 28 `UNRESOLVED`, and 15
  `FAILED_TEMPORARY` domain results.
- Manual first-party review accepted Adobe, Hexaware, Intuit, Synechron, Palo Alto Networks,
  Eficens, Coforge, and Snowflake. It rejected `QUANTUM TECHNOLOGIES, INC.` -> `quantum.com`:
  Quantum's legal pages identify that site as Quantum Corporation.
- The rejected Quantum derived company/domain/source rows had zero jobs and were removed; its
  canonical organization and DOL provenance remain. The resolution is retained as `UNRESOLVED`
  with explicit manual-rejection evidence.
- Root cause: the broad DOL sponsor normalizer intentionally strips trailing descriptive words such
  as `Technologies`, which is useful for sponsor rollups but unsafe for domain ownership. Domain
  verification now uses a stricter legal-name normalizer that removes only corporate suffixes, so
  `Quantum Technologies` and `Quantum` cannot compare equal. A regression test covers the exact
  collision.
- The accepted partial cohort added two verified Workday connectors: Synechron
  (`synechron|wd1|SynechronCareers`, 116 live listings at validation) and Palo Alto Networks
  (`paloaltonetworks|wd5|panwexternalcareers`, 1,406 live listings at validation).
- Before their first load, the database was backed up to
  `data/backups/app.db.pre-synechron-panw-scan-2026-08-11T17-06.bak`. The guarded scan loaded
  1,434 new jobs across those boards and refreshed 92 rows; zero jobs were closed. Elevance alone
  exposed one malformed Workday list row containing a requisition ID but no title/path.
- Workday now represents that provider edge case as a sighting-only partial record. The scanner
  counts its requisition as seen, preserves previously stored content, and blocks lifecycle closures
  for that partial source. A targeted Elevance rescan then refreshed 214 jobs with zero errors and
  zero closures. `scan-ats-ready -- --company-id <id>` supports safe targeted verification while
  retaining the same live-registry authorization gate.
- Final handoff snapshot after retention policy: 67,237 canonical organizations, 80,714 provenance
  rows, 25 domain rows, 27 job-source rows, 5 scan-ready structured sources, and 524 active,
  unarchived jobs. The package verification passed; full test gate is 742 passing, zero failing.
- A Codex local automation named `CareerOps daily verified ATS scan` is active for 06:00 Central.
  It runs the guarded loader, then regenerates and verifies this source-of-truth package. It does
  not authorize generic, unresolved, or `NEEDS_ADAPTER` sources and does not run discovery itself.

**Bounded connector verification correction on 2026-08-11:**

- Development verification now uses `npm run scan-ats-ready -- --sample-size 3`. Every connector
  maps/fetches at most three jobs; Workday also stops pagination and performs only three detail
  requests. Sample mode disables source closures, archives, and the global age sweep.
- The 67,237 canonical organization rows have 67,237 distinct IDs and 67,237 distinct exact
  canonical names. Aliases and 80,714 DOL provenance records are separate grains and are never
  counted as additional companies. Ambiguous identities remain separate rather than being merged
  speculatively.
- None of the bulk-loaded Elevance, Synechron, or Palo Alto jobs had candidate state, notes, or pins.
  After backup `data/backups/app.db.pre-prune-bulk-test-jobs-2026-08-11T18-00.bak`, 557 bulk test
  rows and only their automatic `Aged out:` suppressions were removed. No user suppression was
  removed.
- The bounded live proof then loaded exactly 3 jobs each for Elevance, Palo Alto Networks, and
  Synechron; Ostium exposed 2; UL Research Institute has 3 current jobs. Result: 10 new,
  4 refreshed, 0 closed, and 0 errors.
- Claude's handoff prompt now requires the three-job sample for development verification. The daily
  production automation remains the separate full-board path after connector verification.
- The regenerated verified handoff contains 63 current jobs total: the bounded connector samples
  plus existing CareerOps jobs that predated this ATS-discovery test.
- Test gate for sampling/pagination safety: 743 passing, zero failing.

**All-company readiness and connector-path audit:**

- Read-only audit passed: SQLite integrity `ok`; 67,237 organizations, 67,237 distinct IDs, and
  67,237 distinct exact canonical names. The complete 67,237-row discovery queue and every export
  hash/row count verified successfully.
- Coverage remains explicit: 25 verified domains, 5 scan-ready structured connectors, and 67,212
  organizations still needing verified domain discovery. Registry presence is not connector proof.
- Repeated live sample over all 5 scan-ready connectors processed at most 3 jobs per company:
  14 refreshed, 0 new, 0 closed, and 0 errors. The regenerated snapshot contains 63 current jobs.
- Do not launch all 67,212 remaining external lookups as one process. Continue resumable cohorts and
  manually review every newly `VERIFIED` identity/source until a separate reviewed-promotion gate
  exists; only reviewed structured connectors may enter daily full-board loading.

**Completed 100-company cohort:**

- Backup: `data/backups/app.db.pre-discovery-100-2026-08-11T18-10.bak`.
- Outcomes in 280,462 ms: 8 `VERIFIED`, 13 `AMBIGUOUS`, 55 `UNRESOLVED`, and 24
  `FAILED_TEMPORARY`; 5 structured ATS connectors, 7 generic careers pages, 1 source unresolved.
- First-party review accepted Docusign, Workday, Micron, Amgen, Medtronic, Nike, Brillio, and
  Stripe. No reviewed false-positive domain was retained.
- Five new Workday connectors were live-validated before loading: Workday (327 listings), Micron
  (2,698), Amgen (1,726), Medtronic (1,096), and Nike (769).
- Three-job sample across all 10 scan-ready connectors: 15 new, 14 refreshed, 0 closed, 0 errors.
  Refreshed handoff: 33 domain rows, 35 source rows, 10 scan-ready connectors, 78 current jobs.
- Because the current Workday path fetches every detail, a full daily run over these boards would
  make thousands of unnecessary requests. The 06:00 Central automation has been changed to the
  lifecycle-disabled three-job sample until listing-first detail-fetch optimization is implemented
  and explicitly validated. It must not switch itself to full-board mode.

**Following 100-company cohort:**

- Backup: `data/backups/app.db.pre-discovery-100-2026-08-11T18-20.bak`.
- Outcomes in 321,891 ms: 9 domain `VERIFIED`, 16 `AMBIGUOUS`, 56 `UNRESOLVED`, and 19
  `FAILED_TEMPORARY`; zero supported structured connectors, 1 `NEEDS_ADAPTER`, 6 generic careers
  pages, and 2 source-unresolved results.
- First-party/manual evidence review retained the verified identities for Denken Solutions,
  Slalom, Chewy, Roblox, Best Buy, Airbnb, Twilio, IntraEdge, and Marlabs. Their saved domains are
  `denkensolutions.com`, `slalom.com`, `chewy.com`, `roblox.com`, `bestbuy.com`, `airbnb.com`,
  `twilio.com`, `intraedge.com`, and `marlabs.com` respectively.
- Marlabs exposed SuccessFactors and remains `NEEDS_ADAPTER`; it is not scan-ready and cannot enter
  the daily loader. No new source from this cohort was authorized for a structured connector scan.
- Best Buy's detector initially persisted an internal SSO `auth_redirect.do` URL. Manual remediation
  replaced it with the public first-party entry point `https://jobs.bestbuy.com/bby`; it remains a
  non-authoritative generic source and is excluded from `scan-ats-ready`.
- Refreshed handoff verification passed: 67,237 canonical organizations, 80,714 provenance rows,
  42 domain rows, 44 source rows, 10 scan-ready structured connectors, and 78 current jobs.

**Next 100-company cohort and manual connector gate:**

- Pre-run backup: `data/backups/app.db.pre-discovery-100-2026-08-11T18-38-54Z.bak`.
- Run 7 completed in 273,945 ms: 11 domain `VERIFIED`, 19 `AMBIGUOUS`, 53 `UNRESOLVED`,
  and 17 `FAILED_TEMPORARY`; automated source discovery reported 2 structured ATS results,
  2 `NEEDS_ADAPTER`, 6 generic careers pages, and 1 source-unresolved result.
- The 11 retained identities are Lam Research, Manhattan Associates, Okta, Axtria, HubSpot,
  West Virginia University, Synopsys, Waymo, Artech, MongoDB, and Cepheid. Manual review corrected
  West Virginia University's generated `westvirginiauniversity.com` candidate to its official
  `wvu.edu` domain and left its job source unresolved.
- Canonical-source remediation removed transient/tracking parameters from HubSpot and Waymo,
  replaced MongoDB's recruiting-scam notice with its first-party open-jobs page, and retained
  stable company-specific SuccessFactors entry points for Lam Research and Axtria.
- Live Workday validation accepted Manhattan Associates (`manh|wd5|External`, 38 listings). The
  apparent Cepheid token was rejected as scan-ready because it is the unfiltered 1,378-job Danaher
  parent board. Cepheid is now `NEEDS_ADAPTER` with an explicit parent-board-filter requirement;
  CareerOps cannot load those jobs under Cepheid.
- Before the first Manhattan load, the database was backed up to
  `data/backups/app.db.pre-manhattan-sample-2026-08-11T18-48Z.bak`. The lifecycle-disabled sample
  loaded exactly 3 new jobs, refreshed 0, closed 0, and reported 0 errors.
- Refreshed handoff verification passed: 67,237 canonical organizations, 80,714 provenance rows,
  53 domain rows, 55 source rows, 11 scan-ready structured connectors, and 81 current jobs.
- Compatibility sync now preserves stronger reviewed/curated domain evidence instead of replacing
  it with generic legacy-backfill text. A regression test covers reruns; full gate is 744 tests
  passing, zero failing, with lint clean.

**All-67,237 discovery campaign launched:**

- New structured ATS findings now default to `job_sources.review_status='PENDING'` and are excluded
  from `scan-ats-ready`. Only independently `APPROVED` sources are scan-ready; changing a provider,
  token, or URL automatically invalidates an earlier approval. The 11 previously audited connectors
  were approved once during the additive migration. Backup:
  `data/backups/app.db.pre-source-review-gate-2026-08-11T18-55-49Z.bak`.
- Added `organization_discovery_state`, a one-row-per-canonical-organization checkpoint that covers
  both LCA-backed and PERM-only registry organizations. Existing H1B discovery outcomes backfill
  idempotently so completed work is not repeated.
- `npm run discover-organizations -- --batch-size 2000` is the registry-wide HTTP-only runner. It
  persists every outcome immediately, retries temporary failures only after cooldown, and never
  approves or scans a discovered source.
- The `CareerOps bulk ATS discovery` Codex automation is paused. It was superseded by the locked
  local LaunchAgent `com.careerops.ats-discovery`, which runs consecutive 2,000-organization
  cohorts with a five-minute safety pause, regenerates/verifies the export, and writes a durable
  report after each cohort without requiring another user prompt.
- The initial H1B-only large run was intentionally interrupted after its durable searched count
  reached 636. Migration backup `app.db.pre-migration-2026-08-11T19-04-57-745Z.bak` seeded those
  636 outcomes into the unified queue, leaving 66,601 pending; the first unified 1,000-organization
  cohort was then launched.
- Safety and registry-wide checkpoint tests bring the full gate to 746 passing, zero failing; lint
  and TypeScript type-check are clean.
- At the user's request, the hourly discovery automation remains paused. The first manual
  2,000-organization cohort plus six conflict retries is complete: 2,918 searched and 64,319
  remaining. Current state contains 301 domain-`VERIFIED` outcomes, 11 approved structured
  connectors, and 51 structured connectors pending review. Six duplicate connector/source
  identities were checkpointed as `NEEDS_ADAPTER` review conflicts rather than force-merged.
  The verified export contains 301 domain rows, 303 source rows, 11 scan-ready sources, and 86
  current non-archived jobs. On 2026-08-11 the continuous LaunchAgent began the next cohort from
  checkpoint 2,918. Do not start another manual discovery process while its live lock exists.

### Stage 4 — Connector contract and highest-value adapters

Expanded-discovery checkpoint (2026-08-11): unsupported ATS recognition was moved to a centralized
44-platform catalog with conservative hostname/path rules. Saved discovery URLs were reclassified
transactionally after backup, finding Oracle Recruiting Cloud, UKG Pro, Paylocity, Avature, and
Cornerstone signals that the original nine-platform list missed. Vendor legal/static assets from
iCIMS, SuccessFactors, and Jobvite were removed as false positives; Greenhouse embed URLs now use
their `for=` board token rather than the literal word `embed`. Reclassification is idempotent,
source-of-truth verification passes, and the full regression gate is 756 tests passing.

Pending-connector validation checkpoint (2026-08-12):

- Added `npm run validate-pending-connectors`, a resumable, bounded, structured-ATS validation
  command. It checks registry/domain/provider/token/source-URL agreement and reads at most three
  explicit-U.S. job samples without inserting jobs or running lifecycle actions.
- Validation evidence is persisted as `careerops.connector-validation.v1` JSON in
  `job_sources.review_evidence`; `last_validated_at` records every attempt. Deterministic bad source
  identities/configurations are rejected. Empty boards, no-U.S. samples, rate limits, blocks, and
  transient provider failures remain pending for later retry.
- A five-source no-write dry run produced four valid Workday results and caught the historical
  Greenhouse `embed` false positive. Two persisted passes then processed 315 attempts: 236 new
  approvals, 14 total rejected sources, and 62 still pending after the full pass.
- Live approval total at 2026-08-12 09:29 Central was 247: 96 Workday, 85 Greenhouse, 49 Ashby, and
  17 Lever. Connector validation inserted zero jobs. The independent discovery worker remained
  healthy and continued adding candidates.
- Full regression gate after implementation: 758 tests passing, zero failing; ESLint and TypeScript
  checks clean.
- The continuous worker now runs the same bounded validator after each completed discovery cohort
  and once at campaign completion. New candidates are validated immediately; pending empty/transient
  outcomes have a 24-hour cooldown. Validator failure is isolated and cannot cause a completed
  discovery cohort to be repeated.
- Connector validation now falls back to at most three global jobs when a board has no explicit-U.S.
  sample. These sample fields are saved only in validation evidence and can approve the connector;
  they are never inserted into the production jobs table, and all real job scans remain U.S.-only.
  `--retry-pending-now` is the explicit bypass for the normal 24-hour pending retry cooldown.
- Live global-fallback run: 63 pending/new sources attempted, 53 approved, zero newly rejected, and
  10 retained pending. Approved total reached 300 (121 Workday, 95 Greenhouse, 63 Ashby, 21 Lever);
  rejected total remained 14. The production `jobs` count was 99 both before and after this run,
  proving global samples were retained only as validation evidence.

Verified-domain browser second-pass checkpoint (2026-08-12):

- Added append-only `organization_source_discovery_attempts` and included it in the generated
  source-of-truth package as `browser_source_discovery_attempts.csv`.
- Added `npm run discover-organization-sources-browser` and the independent locked LaunchAgent
  `com.careerops.ats-browser-discovery`. It processes 25 companies per batch at concurrency 1,
  prioritizing known generic career pages before bare unresolved domains. Only domain-`VERIFIED`
  companies are eligible; the first-pass identity evidence is never overwritten.
- Browser `VERIFIED` findings become connector-review `PENDING`, recognized unsupported systems
  become `NEEDS_ADAPTER`, and browser-unresolved results never downgrade an existing generic page.
  Connector identity collisions are checkpointed for review rather than force-merged.
- Migration backup: `data/backups/app.db.pre-migration-2026-08-12T15-03-30-475Z.bak`.
- A three-company no-write canary and a ten-company persisted canary completed without false
  connector promotion. The persisted canary produced two improved generic career pages and eight
  unresolved outcomes. A following generic-page dry run exposed JobDiva, which was added as the
  44th conservative unsupported-ATS signature.

- [ ] Refactor connectors behind one typed contract: detect, validate, list, optional detail,
      normalize, pagination/cursor, and rate policy.
- [ ] Preserve all existing connector behaviors through contract tests.
- [x] Optimize Workday: list first and fetch detail only for new/changed requisitions.
- [x] Add a provider-independent U.S.-only listing gate before detail fetching and database insert.
      Classify listing locations as `US`, `NON_US`, or `UNKNOWN`: include explicit U.S. locations,
      U.S.-remote roles, and multi-location roles with at least one U.S. location; exclude explicit
      non-U.S.-only roles; fetch minimal detail for `UNKNOWN` only when needed to resolve country.
- [ ] Implement the top missing adapters from Stage 3; expected early candidates are Workable and
      Recruitee, but measured coverage decides.

Exit gate: supported sources have fixture tests, live opt-in validation, and no lifecycle regression.

**ADP Workforce Now adapter checkpoint (2026-08-12):**

- Added `adp_wfn` as a structured provider using the public browser-facing Workforce Now
  career-center list/detail feed. It exhausts ADP's one-based pagination, deduplicates stable
  `itemID` requisitions, retrieves full descriptions, and applies the shared U.S.-only gate.
- A live three-job canary returned three unique U.S. jobs with full descriptions. The first probe
  exposed ADP's special zero-offset behavior; the adapter was corrected and regression-tested.
- Promoted 36 conflict-free modern tenants to bounded validation: 34 became `APPROVED`; Conavlytics
  and Fujitsu Frontech North America remain `PENDING` because their boards currently publish no
  jobs. Ninety-three sample records were saved as validation evidence and zero production jobs were
  inserted; the production jobs table remained at 99.
- Six legacy `recruiting.adp.com` Recruiting Management sources remain `NEEDS_ADAPTER` because they
  are a different product. One saved Workforce Now JavaScript asset was identified for false-positive
  removal. The pre-change database backup is
  `app.db.pre-migration-2026-08-12T19-01-57-582Z.bak`.
- Final gate: 765 tests passed, lint passed, the Next.js webpack production build passed, and the
  regenerated source package verified with database integrity intact. The export contains 387
  scan-ready structured sources, 29 additive-ready generic sources, and 98 current non-archived jobs.

**Zero-token ATS adapter profiler checkpoint (2026-08-12):**

- Added a separate passive worker that samples at most three sources per unsupported ATS family,
  inspects bounded public HTML and same-host scripts, and stores redacted endpoint/protocol evidence.
- It cannot change connector status, approve a source, or write to `jobs`. Evidence is exported in
  `ats_adapter_profile_runs.csv` for Claude/Codex adapter development.
- The first six-source canary found endpoint evidence for two of three iCIMS samples and all three
  Paylocity samples; one iCIMS request failed temporarily. The backed-up migration snapshot is
  `app.db.pre-migration-2026-08-12T23-04-23-962Z.bak`.
- Evidence filtering was tightened to v2 after review so CDN libraries, logo files, and social-image
  URLs cannot inflate API/job endpoint counts. The v2 canary retained endpoint evidence for two
  iCIMS and all three Paylocity samples. Final gates passed: 767 tests, lint, typecheck, and the
  Next.js webpack production build.

**Zero-token connector-health worker checkpoint (2026-08-12):**

- Added a separate 24-hour revalidator for approved structured sources. Each probe fetches at most
  one global sample, records latency/empty/failure evidence, and cannot insert/close jobs, change
  approval, or overwrite ingestion scan health.
- A six-provider live canary passed for ADP Workforce Now, Ashby, Greenhouse, Lever,
  SmartRecruiters, and Workday. Production jobs remained unchanged. The pre-change backup is
  `app.db.pre-migration-2026-08-12T23-27-15-375Z.bak`.

**Paylocity adapter checkpoint (2026-08-13):**

- Added the seventh structured adapter. Exact
  `/recruiting/jobs/All/{company-uuid}/{slug}` boards normalize to a stable `uuid|slug` token.
  The adapter parses the complete embedded `window.pageData` listing, applies the shared U.S.-only
  gate before detail calls, and extracts complete descriptions, posting dates, salary text, remote
  state, department, location, and stable job IDs from listing plus JobPosting JSON-LD evidence.
- Paylocity public requests use a process-wide one-request limiter, a 350 ms minimum start interval,
  and bounded `429` retry/backoff. This protects validation and later multi-company scans from each
  adapter invocation creating its own request burst.
- A live canary returned three unique U.S. jobs with full descriptions (5,725–6,820 characters),
  stable IDs, locations, dates, and salary where published. Thirty-two conflict-free exact boards
  were promoted after the standard backup
  `app.db.pre-migration-2026-08-13T05-27-29-861Z.bak`: seven are approved and 25 remain pending
  for empty-board, missing-full-description, or temporary-rate-limit outcomes. Zero were rejected.
  Validation did not mutate `jobs`; it remains 99 rows, 98 current.
- Eleven saved Paylocity Details/Apply, slug-less, or legacy List URL variants remain unsupported;
  their stable complete board identity is not guessed. Provider-scoped promotion and validation
  flags were added so future adapter migrations cannot accidentally promote another provider.
- Final gates passed: 774 tests, lint, TypeScript, and the Next.js webpack production build. The
  regenerated source package verified with 67,237 organizations, 525 approved structured sources,
  216 additive-ready generic sources, and 98 current jobs. All five zero-token workers are running;
  discovery, browser discovery, and connector health were reloaded to use the new adapter code.

**iCIMS adapter checkpoint (2026-08-13):**

- Added the eighth structured adapter. Any tenant `/jobs/...` URL normalizes to the exact
  `{tenant}.icims.com` identity and canonical `/jobs/search` board. The connector exhausts
  zero-based `pr` pages, deduplicates stable numeric job paths, skips explicit non-U.S. listings
  before details, and resolves ambiguous listing locations from JobPosting JSON-LD before the
  final shared U.S. gate.
- Full details provide description, posting date, location, employment type, salary, remote state,
  department, and stable job URL/ID. A live Cotiviti canary returned three genuine U.S. remote jobs
  with 7,024–7,250-character descriptions, exact dates, and salary ranges.
- The reviewed preview found 40 conflict-free tenant sources. After backup
  `app.db.pre-migration-2026-08-13T05-49-01-597Z.bak`, all 40 moved to `PENDING`; bounded validation
  approved 18 from three genuine U.S. samples each, retained 22 empty tenants as pending, and
  rejected zero. Validation did not insert production jobs.
- Final gates passed: 778 tests, lint with zero warnings, TypeScript, the Next.js webpack production
  build, and source-package verification. The export contains 543 approved structured sources,
  216 additive-ready generic sources, and 98 current jobs.

**UKG Pro Recruiting adapter checkpoint (2026-08-13):**

- Added the ninth structured adapter. Exact `recruiting[2].ultipro.com/{tenant}/JobBoard/{uuid}`
  identities normalize to a stable host+tenant+board token. The connector establishes the public
  board session, preserves its anonymous cookie, exhausts 50-row `Top`/`Skip` pages to
  `totalCount`, deduplicates opportunity UUIDs, and filters structured locations before details.
- Selected opportunity pages expose a complete CandidateOpportunityDetail JSON model with stable
  ID, requisition, title, category, locations, posting date, description, employment type, and
  compensation. A live Milliman canary exhaustively covered 119 listings and returned three U.S.
  jobs with 8,082–9,688-character descriptions and published salary ranges.
- The reviewed preview initially found 38 conflict-free boards; continuous discovery added one
  more before apply. After backup `app.db.pre-migration-2026-08-13T06-07-00-758Z.bak`, 39 exact
  boards moved to validation: 38 approved from genuine U.S. samples, one empty Astadia board
  remains pending, and zero were rejected. Validation did not insert production jobs.
- Final gates passed: 782 tests, lint, TypeScript, the Next.js webpack production build, and source
  package verification. The verified export contains 581 approved structured sources,
  217 additive-ready generic sources, and 98 current jobs.

**BambooHR adapter checkpoint (2026-08-13):**

- Added the tenth structured adapter. Any exact tenant `/careers` or numeric `/careers/{id}` URL
  normalizes to the tenant-wide board. The connector verifies the public listing length against
  `meta.totalCount`, applies the shared U.S. filter to structured country/state/city data before
  details, and fetches full descriptions from `/careers/{id}/detail`.
- The live Plus One Robotics canary returned its complete two-listing board and both U.S. jobs with
  3,346–3,933-character descriptions, dates, stable IDs, and salary where published.
- After backup `app.db.pre-bamboohr-2026-08-13T06-19-43Z.bak`, 27 tenants moved to validation:
  23 approved, three empty/invalid boards remain pending, and one false `www.bamboohr.com` tenant
  was rejected. Global samples were evidence-only; production loading remains U.S.-only. Validation
  inserted no production jobs.
- Final gates passed: 785 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 604 approved structured sources,
  219 additive-ready generic sources, and 98 current jobs.

**Oracle Recruiting Cloud adapter checkpoint (2026-08-13):**

- Added the eleventh structured adapter. Exact Candidate Experience host/site URLs normalize to a
  stable `host|site` identity. Anonymous `findReqs` calls use explicit 25-row offsets and
  `TotalJobsCount`; production scans exhaust the listing, while three-job validation stops only
  after enough eligible samples are found.
- Structured country/location fields pass through the U.S. gate before anonymous `ById` details.
  A canary exposed the ISO `DE`/Delaware collision before promotion; normalization now expands only
  explicit U.S. country codes and leaves non-U.S. names or ambiguous codes safely non-U.S./unknown.
- The corrected Fortinet canary returned three genuine U.S. jobs with 1,673–4,974-character full
  descriptions, dates, workplace types, stable IDs, and salaries where published.
- After backup `app.db.pre-oracle-recruiting-cloud-2026-08-13T06-31-34Z.bak`, 24 exact boards moved
  to validation: 23 approved from U.S. samples, one empty Deem board remains pending, and zero were
  rejected. One saved Oracle image URL was correctly not promoted. Validation inserted no jobs.
- Final gates passed: 788 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 627 approved structured sources,
  220 additive-ready generic sources, and 98 current jobs.

**Workable adapter checkpoint (2026-08-13):**

- Added the twelfth structured adapter. Account-scoped `apply.workable.com/{slug}` and job URLs
  normalize to a stable slug. The public listing API returns ten rows at a time and an opaque
  `nextPage`; production follows tokens until the exact `total`, while bounded validation stops
  only after enough eligible jobs.
- Structured full-country locations pass through the U.S. gate before `/api/v2` details. Full job
  text combines description, requirements, and benefits, preserving published salary evidence.
- The live TetraScience canary returned three genuine U.S. jobs with 3,666–9,637-character full
  descriptions, dates, workplace types, salaries, and stable shortcodes.
- After backup `app.db.pre-workable-2026-08-13T06-45-56Z.bak`, 20 account boards moved to validation:
  17 approved, three empty boards remain pending, and zero were rejected. Two tenantless
  `/j/{code}` URLs remain unpromoted until redirect evidence supplies the account slug. Validation
  inserted no production jobs.
- Final gates passed: 791 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 644 approved structured sources,
  219 additive-ready generic sources, and 98 current jobs.

**ADP backlog correction (2026-08-13):**

- Audited the 21-row stale “ADP Recruiting” cluster. Seventeen conflict-free URLs were exact modern
  Workforce Now boards already covered by `adp_wfn`; one modern identity conflicts with another
  organization, and the static asset, legacy Recruiting Management board, and intermediate redirect
  were not promoted.
- After backup `app.db.pre-adp-wfn-reclassification-2026-08-13T06-54-26Z.bak`, bounded validation
  processed those plus newly pending ADP boards: 18 approved and four empty boards remain pending.
  Validation inserted no jobs. The verified export contains 662 approved structured sources,
  219 additive-ready generic sources, and 98 current jobs.

**Production job-loading requirements recorded during the all-company campaign:**

**Paycom adapter checkpoint (2026-08-13):**

- Added the fourteenth structured adapter. Exact public client keys normalize away ephemeral nonce
  and iframe parameters. Each scan obtains a short-lived anonymous token from the public board and
  accepts only Paycom's fixed public API origin.
- Listing requests use explicit `skip`/`take` pagination and an exact total; structured location
  text passes through the U.S. gate before full description/qualifications details. The live
  HealthStream canary returned three U.S. jobs with 6,609–10,010-character descriptions.
- After backup `app.db.pre-paycom-2026-08-13T07-24-00Z.bak`, all 19 conflict-free boards moved to
  validation: 17 approved, two empty boards remain pending, and zero were rejected. Validation did
  not insert production jobs.
- Final gates passed: 797 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 695 approved structured sources,
  222 additive-ready generic sources, and 98 current jobs.

**JazzHR adapter checkpoint (2026-08-13):**

- Added the fifteenth structured adapter. Exact `{tenant}.applytojob.com/apply` identities normalize
  listing and detail URLs to one board. The complete listing is server rendered, so the U.S. gate
  runs before selected details.
- Detail extraction supports identity-matched JobPosting JSON-LD plus JazzHR's legacy complete HTML
  description, which is accepted only when the embedded stable job ID exactly matches. The live
  Paradromics legacy canary returned three U.S. jobs with 1,734–4,499-character descriptions.
- After backup `app.db.pre-jazzhr-2026-08-13T07-37-00Z.bak`, all 19 conflict-free boards moved to
  validation: 18 approved, one empty board remains pending, and zero were rejected. Validation did
  not insert production jobs.
- Final gates passed: 801 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 713 approved structured sources,
  224 additive-ready generic sources, and 98 current jobs.

**Jobvite adapter checkpoint (2026-08-13):**

- Added the sixteenth structured adapter. Legacy `/careers/{tenant}/jobs`, current tenant board,
  search, and exact detail paths normalize to one careers-site identity. Server-rendered job tables
  let the U.S. gate run before details.
- Details require either an exact JobPosting identifier or an exact embedded `getJobId()` match for
  the legacy full-description container. Live RiskSpan and Sikich canaries returned complete
  descriptions; embedded data-image payloads are removed from stored legacy HTML.
- After backup `app.db.pre-jobvite-2026-08-13T07-51-10Z.bak`, 13 conflict-free boards moved to
  validation: 10 approved, three remain pending for missing description or stale tenant redirects,
  and zero were rejected. Malformed social/placeholder evidence was not promoted.
- Final gates passed: 805 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 723 approved structured sources,
  226 additive-ready generic sources, and 98 current jobs.

**Breezy HR adapter checkpoint (2026-08-13):**

- Added the seventeenth structured adapter. Exact tenant roots and 12-character position detail URLs
  normalize to one board. The complete server-rendered listing deduplicates multi-location cards by
  position ID before the U.S. gate and selected detail requests.
- Details accept either identity-matched JobPosting data or a legacy description guarded by the
  exact embedded `positionId`. The live Cytracom canary returned three U.S. positions across both
  formats with complete descriptions.
- After backup `app.db.pre-breezy-2026-08-13T08-07-00Z.bak`, all 13 boards moved to validation:
  10 approved, three empty boards remain pending, and zero were rejected. No jobs were inserted.
- Final gates passed: 809 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 733 approved structured sources,
  227 additive-ready generic sources, and 98 current jobs.

**Teamtailor adapter checkpoint (2026-08-13):**

- Added the eighteenth structured adapter. Exact tenant listing and numeric detail URLs normalize
  to one board. The connector consumes the complete public RSS snapshot, verifies the channel's
  exact tenant identity, and applies the U.S. gate to structured locations without detail requests.
- The feed supplies stable numeric IDs, full descriptions, departments, publication dates, and
  remote status. The live PassiveLogic canary returned three Salt Lake City jobs with complete
  5,957–7,138-character descriptions.
- After backup `app.db.pre-teamtailor-2026-08-13T08-25-00Z.bak`, all five boards moved to validation
  and approved from genuine U.S. samples; none remain pending or rejected. No jobs were inserted.
- Final gates passed: 812 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 738 approved structured sources,
  228 additive-ready generic sources, and 98 current jobs.

**ApplicantPro adapter checkpoint (2026-08-13):**

- Added the nineteenth structured adapter. Tenant-hosted listing/detail URLs and central
  `/openings/{tenant}/jobs` URLs normalize to one board. The connector verifies the board's exact
  published tenant and numeric domain ID and rejects any incomplete listing count.
- Structured country/state/location fields pass through the U.S. gate before selected jobs use the
  exact public domain-ID/job-ID detail endpoint. The live MAP Communications canary returned three
  Texas jobs with stable IDs and complete 1,573–2,244-character descriptions; Wegner CPAs verified
  the older page shape through the same detail endpoint.
- After backup `app.db.pre-applicantpro-2026-08-13T08-35-00Z.bak`, all eight boards moved to
  validation and approved from genuine U.S. samples; none remain pending or rejected. No jobs were
  inserted.
- Final gates passed: 816 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 746 approved structured sources,
  228 additive-ready generic sources, and 98 current jobs.

**Pinpoint adapter checkpoint (2026-08-13):**

- Added the twentieth structured adapter. Root, locale, and UUID posting URLs normalize to one
  tenant board. Its complete public `postings.json` UI snapshot is identity-checked by tenant origin
  and posting UUID and contains full descriptions plus structured location and job metadata.
- The U.S. gate runs without detail requests. The Utilities One canary returned three genuine U.S.
  jobs with 3,183–4,101-character multi-section descriptions, departments, and compensation where
  published.
- After backup `app.db.pre-pinpoint-2026-08-13T08-45-00Z.bak`, all three boards approved from
  genuine U.S. samples; none remain pending or rejected. No jobs were inserted.
- Final gates passed: 819 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 749 approved structured sources,
  228 additive-ready generic sources, and 98 current jobs.

**ClearCompany adapter checkpoint (2026-08-13):**

- Added the twenty-first structured adapter. Exact portal, listing, detail, and apply URLs normalize
  to one tenant. The embedded short name and tenant-scoped API response must both map to the exact
  same-tenant HRMDirect board before ingestion continues.
- An explicit all-filter request returns the complete non-paginated requisition/location table. The
  U.S. gate runs before exact details, whose canonical and apply requisition identities are checked.
  The PayCargo canary returned three Florida jobs with 2,529–8,990-character descriptions.
- After backup `app.db.pre-clearcompany-2026-08-13T08-58-00Z.bak`, all eight boards moved to
  validation: seven approved, one empty board remains pending, and zero were rejected. No jobs were
  inserted.
- Final gates passed: 822 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 756 approved structured sources,
  230 additive-ready generic sources, and 98 current jobs.

**Personio adapter checkpoint (2026-08-13):**

- Added the twenty-second structured adapter for exact `*.jobs.personio.de` tenants. Root and
  numeric job URLs normalize to one board identity; `.jobs.personio.com` remains conservatively in
  the unsupported catalog until its contract is separately verified.
- The complete public XML feed is non-paginated and includes stable numeric IDs, offices,
  timestamps, and full multi-section descriptions. The shared U.S. gate runs before normal loads.
- The saved Kardion board currently had no U.S. jobs, so the explicit global fallback validated two
  genuine Stuttgart jobs with 1,522–3,941-character descriptions. One source was promoted and
  approved, zero remain pending/rejected, and no jobs were inserted.
- Backup: `data/backups/app.db.pre-personio-2026-08-13T09-15-00Z.bak`. Final gates passed: 826 tests,
  lint, TypeScript, webpack production build, export, and package verification. The verified export
  contains 757 approved structured sources, 231 additive-ready generic sources, and 98 current jobs.
- Dayforce was evaluated immediately beforehand. Its normal browser UI rendered genuine complete
  jobs, but its search endpoint returned HTTP 403 to server-to-server scanner requests even with
  page cookies. It remains `NEEDS_ADAPTER` and is eligible only for browser-worker coverage until a
  stable public server contract is demonstrated.

**ApplicantStack adapter checkpoint (2026-08-13):**

- Added the twenty-third structured adapter. Exact tenant opening/detail/apply URLs normalize to
  the tenant openings root; ApplicantStack was removed from the unsupported catalog.
- The connector exhausts public 100-row pages against the exact reported total, rejects duplicate
  or shifted pagination, applies the U.S. gate before details, and requires matching same-tenant
  canonical URLs and JobPosting IDs with full descriptions.
- Dashiell's live canary traversed all 204 listings and fetched only three selected U.S. job details
  with 4,231–5,580-character descriptions. Its single source was promoted and approved; zero remain
  pending/rejected and no jobs were inserted.
- Backup: `data/backups/app.db.pre-applicantstack-2026-08-13T09-32-00Z.bak`. Final gates passed: 829
  tests, lint, TypeScript, webpack build, export, and source-package verification. The verified
  export contains 758 approved structured sources, 231 additive-ready generic sources, and 98 jobs.

**Comeet adapter checkpoint (2026-08-13):**

- Added the twenty-fourth structured adapter. Exact company slug/UID and position UID paths
  normalize to the company board; Comeet was removed from the unsupported catalog.
- The public board embeds the complete positions snapshot with full ordered descriptions and
  structured locations. Company and every position URL must carry the exact same identities.
  Two-letter ISO countries are expanded before classification, preventing Israel `IL` from being
  mistaken for Illinois.
- Lumus currently had one genuine Israel hybrid job with a 1,739-character description, so it was
  approved under the explicit global fallback; production remains U.S.-only and no jobs were
  inserted.
- Backup: `data/backups/app.db.pre-comeet-2026-08-13T09-45-00Z.bak`. Final gates passed: 832 tests,
  lint, TypeScript, webpack build, export, and source-package verification. The verified export has
  759 approved structured sources, 231 additive-ready generic sources, and 98 jobs.

**CATS adapter checkpoint (2026-08-13):**

- Added the twenty-fifth structured adapter. Exact tenant portal, listing, detail, register, and
  apply URLs normalize to one `host|portalId` source identity; CATS was removed from the unsupported
  catalog, which now contains 25 conservative platform signatures.
- The connector verifies public CATS branding and portal identity, parses the complete
  server-rendered listing, filters U.S. locations before details, and requires exact same-tenant
  numeric job/canonical/apply identities with complete rendered descriptions.
- Canidium's live canary returned three genuine U.S. jobs with 3,053–6,165-character descriptions;
  two included salary ranges. Its source was promoted and approved, and no jobs were inserted.
- Backup: `data/backups/app.db.pre-cats-2026-08-13T09-55-00Z.bak`. Final gates passed: 835 tests,
  lint, TypeScript, webpack build, export, and source-package verification. The verified export has
  760 approved structured sources, 231 additive-ready generic sources, and 98 jobs.

**GoHire adapter checkpoint (2026-08-13):**

- Added the twenty-sixth structured adapter. Exact public widget URLs normalize to the
  eight-character client hash; GoHire was removed from the unsupported catalog, now 24 signatures.
- One public request returns the complete tenant job array. U.S. filtering happens before exact
  client-hash/job-ID details, which must return matching client and job identities plus full text.
- Troy Web Consulting returned three genuine U.S. jobs with 2,491–4,896-character descriptions,
  salary, employment type, and posting dates. Its source was approved and no jobs were inserted.
- Backup: `data/backups/app.db.pre-gohire-2026-08-13T10-00-00Z.bak`. Final gates passed: 838 tests,
  lint, TypeScript, webpack build, export, and source verification. The export has 761 approved
  structured sources, 231 additive-ready generic sources, and 98 jobs.

**Newton / Recruiting by Paycor adapter checkpoint (2026-08-13):**

- Added the twenty-seventh structured adapter. Legacy NewtonSoftware iframe and migrated Paycor
  listing/detail/apply URLs normalize to one 32-hex client ID; unsupported catalog is now 23.
- CareerHome provides a complete server-rendered snapshot. The U.S. gate precedes details, which
  require exact client/job/apply identity and a non-empty full description.
- Clinical Ink had two clearly U.S. jobs with 2,199- and 4,345-character descriptions. Bare-remote
  and explicit international listings remained excluded. The source was approved; no jobs loaded.
- Backup: `data/backups/app.db.pre-newton-2026-08-13T10-15-00Z.bak`. All 841 tests, lint, TypeScript,
  webpack build, export, and verification passed. The export has 762 structured, 231 generic, and
  98 jobs.

**SilkRoad adapter checkpoint (2026-08-13):**

- Added the twenty-eighth structured adapter. Bounded rediscovery maps the saved legacy OpenHire
  URL to exact modern `account|site` identity; unsupported catalog is now 22 signatures.
- The connector exhausts 13 exact pages, rejects changing totals and duplicate IDs, filters U.S.
  scope before details, and requires matching board/job/apply identity plus complete descriptions.
- Traylor validated three genuine U.S. jobs with 6,417–7,272-character descriptions, departments,
  employment type, and salary where present. The source was approved and no jobs were inserted.
- Backup: `data/backups/app.db.pre-silkroad-2026-08-13T10-30-00Z.bak`. All 844 tests, lint,
  TypeScript, webpack build, export, and verification passed. Export: 763 structured, 231 generic,
  98 jobs.

**JobDiva adapter checkpoint (2026-08-13):**

- Added the twenty-ninth structured adapter. Exact public portal URLs normalize to
  `host|64-character-account|compid|division-IDs`; JobDiva was removed from the unsupported
  catalog, now 21 signatures.
- JobDiva search sessions are stateful and provider nodes can briefly disagree. The connector
  therefore traverses every 100-row page sequentially, rejects shifted totals/incomplete or
  duplicate pages, and requires two identical complete snapshots before filtering or details.
  Listing/detail 404 drift fails closed and cannot authorize lifecycle closure.
- A reusable connector-scoped saved-source migrator was added as
  `npm run promote-supported-saved-sources -- --provider <provider>`; it is preview-only unless
  `--apply` is explicitly supplied.
- All 12 saved JobDiva sources were promoted. Eleven approved from three genuine U.S. jobs each;
  the empty Emonics division-scoped board remains pending. No jobs were inserted. Twelve Phenom
  CDN/static-asset false positives were separately removed and never counted as employer boards.
- Backup: `data/backups/app.db.pre-jobdiva-2026-08-13T11-00-00Z.bak`. All 847 tests, lint,
  TypeScript, webpack build, export, and verification passed. Export: 774 structured, 231 generic,
  98 jobs.

**Taleo adapter checkpoint (2026-08-13):**

- Added the thirtieth structured adapter. Exact tenant host and career-section URLs normalize to
  `host|section`; Taleo was removed from the unsupported catalog, now 20 signatures.
- The connector verifies the faceted-search bootstrap, traverses every advertised page while
  tolerating Taleo's documented short-page/overstated-total behavior, rejects pagination identity
  changes and duplicate requisitions, filters U.S. scope before details, and requires matching
  requisition, contest, title, detail, and apply identities plus full descriptions.
- UniFirst's live canary returned three genuine U.S. jobs with 2,329–6,105-character descriptions.
  Four saved sources were promoted: UniFirst approved; HCA, Tetra Tech, and Texas Health remain
  pending because their current public contracts are unreachable, non-public, or fail on detail.
  Zero were rejected and validation inserted no jobs.
- Backup: `data/backups/app.db.pre-taleo-2026-08-13T11-00-34Z.bak`. All 850 tests, lint, TypeScript,
  webpack build, export, and verification passed. Export: 775 structured, 231 generic, 882 current
  jobs.

**ADP Recruiting Management / MyJobs adapter checkpoint (2026-08-13):**

- Added the thirty-first structured adapter. A bounded cookie-preserving resolver migrates saved
  legacy `recruiting.adp.com/srccar` c+d identities to exact MyJobs slug, career-site UUID,
  organization ID, and client ID tokens; unsupported catalog is now 19 signatures.
- Every scan re-verifies all four tenant fields, obtains a short-lived public MyJobs token, exhausts
  the count-bearing full-description feed, uses requisition ID as the posting-date ordering
  tie-breaker, rejects duplicate/shifted pages, and runs the U.S. gate before persistence.
- American Woodmark's canary returned three genuine U.S. descriptions of 2,323–3,880 characters.
  Seven saved sources were promoted: American Woodmark, Data Axle, Schneller, and Follett approved;
  Lincare (overlapping live pagination), Afni (missing description), and Northwood (empty) remain
  pending. Zero were rejected and validation inserted no jobs.
- Backup: `data/backups/app.db.pre-adp-rm-2026-08-13T11-20-00Z.bak`. All 853 tests, lint,
  TypeScript, webpack build, export, and verification passed. Export: 779 structured, 232 generic,
  and 1,831 current jobs.
- Worker startup was also corrected to project only missing registry links instead of rewriting all
  67,237 companies on every process connection, eliminating recurring five-worker SQLite startup
  contention while retaining exact per-company dual writes.

**Eightfold adapter checkpoint (2026-08-13):**

- Added the thirty-second structured adapter. The token pins exact Eightfold host plus the embedded
  SmartApply employer domain; Eightfold was removed from the unsupported catalog, now 18 signatures.
- The connector verifies the server-rendered domain/count bootstrap, exhausts exact ten-row public
  API pages, rejects count drift/incomplete pages/private or duplicate jobs, filters U.S. locations
  before details, and requires matching numeric job/title/canonical identity with full descriptions.
- Albemarle's 42-row board validated three genuine U.S. jobs with 5,397–5,794-character full
  descriptions. Albemarle approved; Chevron's saved board is 404 and Tektronix lacks an employer
  tenant identity, so those two remain `NEEDS_ADAPTER`. Validation inserted no jobs.
- Backup: `data/backups/app.db.pre-eightfold-2026-08-13T11-45-00Z.bak`. All 856 tests, lint,
  TypeScript, webpack build, export, and verification passed. Export: 780 structured, 232 generic,
  and 1,831 current jobs.

**Rippling Recruiting adapter checkpoint (2026-08-13):**

- Added the thirteenth structured adapter. Exact board slugs normalize across ordinary, embedded,
  localized, and UUID detail paths. Public listing state exposes exact totals and page counts;
  production exhausts every page and rejects incomplete or shifting pagination.
- Structured locations pass through the U.S. gate before public job details. The live Aerospike
  canary returned three genuine U.S. jobs with stable UUIDs and complete 4,647–5,769-character
  descriptions.
- After backup `app.db.pre-rippling-2026-08-13T07-10-00Z.bak`, all 19 conflict-free boards moved to
  validation: 16 approved, three empty boards remain pending, and zero were rejected. Validation
  inserted no production jobs.
- Final gates passed: 794 tests, lint, TypeScript, the documented Next.js webpack production build,
  and source-package verification. The verified export contains 678 approved structured sources,
  220 additive-ready generic sources, and 98 current jobs.

1. Discovery/domain/connector work never loads jobs by itself.
2. A newly discovered structured source remains `PENDING` until company-specific board validation.
3. An approved connector first loads at most three verification jobs with lifecycle actions off.
4. Before the first full-board load, listing-first behavior must be implemented: fetch the lightweight
   listing, apply the U.S.-only gate, and fetch full detail only for eligible jobs.
5. The first full load fetches all eligible U.S. job details in bounded source batches.
6. Later Workday scans compare stable requisition identity plus a fingerprint of its lightweight
   listing fields and fetch full detail only for new or changed jobs. Greenhouse, Lever, and Ashby
   already return descriptions in their board/list payloads, so they have no separate detail phase.
7. Location filtering is conservative: never treat a bare `Remote` as U.S. without corroboration;
   preserve an `UNKNOWN` diagnostic/review count rather than silently importing or discarding it.
8. Only a complete successful authoritative scan may close a previously loaded U.S. job; changing
   location scope or a partial/failed scan cannot drive closures.

Implementation checkpoint (2026-08-11): `src/lib/jobLocationScope.ts` provides the shared
`US | NON_US | UNKNOWN` classifier. All four structured connectors apply the gate before database
insertion; Workday excludes explicit non-U.S. listings before detail requests and skips unchanged
listing fingerprints. Existing out-of-scope jobs are lifecycle-only sightings, and unresolved
`UNKNOWN` locations make the run partial and are reported rather than silently loaded. The full
suite passes with 752 tests. Corrected live
three-job validation passed sequentially for Manhattan Associates/Workday and Ostium/Ashby with
zero closures and zero errors. A prior all-source sample exposed Workday HTTP 429s and was stopped;
full-board loading remains intentionally disabled pending rate-aware bounded-source scheduling.

### Stage 5 — Persistent adaptive scheduler

- [ ] Replace whole-list `Promise.all` orchestration with paged source leasing.
- [ ] Add `next_scan_at`, adaptive intervals, per-host/provider limits, backoff, and circuit breakers.
- [ ] Separate lightweight listing scans from expensive details and browser work.
- [ ] Use conditional requests/content hashes where available.
- [ ] Add crash/restart, duplicate-lease, `429`, partial-response, and provider-outage tests.

Exit gate: 5,000 sources run continuously for a week without silent job loss or unbounded retries.

### Stage 6 — Controlled expansion

- [ ] Expand through 1K, 5K, 20K, then 50K registry/source cohorts.
- [ ] Gate each expansion on scan freshness, error rate, request volume, duplicate rate, false
      closures, storage growth, and relevant-job yield.
- [ ] Decide whether PostgreSQL/queue infrastructure is justified from measured load; do not migrate
      merely because the registry contains 50K rows.

## Resume protocol for a fresh Claude/Codex session

Run these read-only commands first:

```bash
git branch --show-current
git status --short
git log -5 --oneline
sed -n '1,260p' CAREER_OPS_ATS_DISCOVERY_50K_CHECKPOINT.md
```

Then:

1. Confirm the branch is `codex/ats-job-discovery-50k`.
2. Preserve unrelated working-tree changes, especially `.claude/settings.local.json`.
3. Locate the first unchecked item in the active stage.
4. Inspect the relevant code and tests rather than trusting the checkpoint alone.
5. Implement one reviewable slice.
6. Run proportional tests, then full `npm test`, `npm run lint`, and `npm run build` at stage gates.
7. Update this file with completed boxes, decisions, migrations, test counts, and the exact next item.
8. Commit only when the user requests or approves it; never include private `data/**`.

## Exact next action

### Registry-wide completion and multi-agent handoff (2026-08-13)

The resumable campaign completed all 67,237 canonical organizations. Final live outcomes were
3,915 verified domains, 8,372 ambiguous, 46,716 unresolved, and 8,234 temporary; source discovery
produced 1,038 structured-verified organization outcomes, 1,664 generic-supported, 125
needs-adapter/review, 1,062 unresolved, and 26 temporary. The source registry contains 1,076
verified structured rows: 912 approved, 121 pending, and 43 rejected; 242 generic sources are
approved additive-only. Current non-archived jobs remain 1,831.

The final queue stall was fixed by prioritizing never-attempted organizations ahead of cooldown
retries. Deterministic malformed URLs now checkpoint as unresolved, and duplicate company/source
identities checkpoint as review-required without mutating either owner. SQLite now applies a
bounded 30-second busy wait before WAL setup. This completed the last 23 organizations without
guessing merges or source ownership.

Final verification: SQLite integrity `ok`, zero foreign-key violations, 864 tests passing, lint
clean, TypeScript clean, Next.js 16 webpack production build passed, and the export verified. The
manifest hash is `e113ee860e92e46ccad50398ba3cda05504f29c6079759e5f374f16c58ab1bdd`.
`ATS_MULTI_AGENT_HANDOFF.md` is now the tool-neutral entry point for Claude, Antigravity, Gemini,
or Codex. The next adapter is SuccessFactors, followed by a safely proven Dayforce mode and Phenom;
existing-provider URL variants and identity conflicts remain separate review work.

Cornerstone adapter #33 is complete. After fresh backup
`data/backups/app.db.pre-cornerstone-promotion-2026-08-13T14-42-16Z.bak`, Colorcon, Turner
Construction, and Laerdal were promoted and approved from three genuine U.S. samples each; the
fourth diagnostic record remains `NEEDS_ADAPTER`. Zero jobs were inserted. All 859 tests, lint,
TypeScript, webpack build, database integrity, export, and source-package verification passed.
The export contains 783 structured sources, 232 generic sources, and 1,831 current jobs; manifest
hash: `57a69a579ba5bf89b8c77ba436ca9a9e50dfb8f5d98d4c4f72337afe1f49eaa7`.

Avature adapter #34 is complete for the two proven portal modes. MAXIMUS TemplateBuilder requires a
fresh anonymous browser session plus job-ID-sorted, identical double snapshots; Xerox legacy uses
two identical complete HTML snapshots. Both approved from three genuine U.S. samples. Ross remains
`NEEDS_ADAPTER` because its saved talent-community URL has no job list. No jobs were inserted.
Backup: `data/backups/app.db.pre-avature-2026-08-13T15-13-30Z.bak`. All 863 tests and every gate
passed. Verified export: 785 structured, 234 generic, 1,831 current jobs, 62,839 discovery states;
manifest `8f3da20539910591da68c7955fc484e8553ab047c5ac8d1ee7e1adc5c4c59d78`.

Continue with the highest-evidence remaining unsupported family. Do not broaden Avature detection
to talent-community or unknown portal layouts; add another explicit mode only after an exact public
listing contract and three-job canary are proven.

The measured next family is SuccessFactors: 21 `SAP SuccessFactors` plus two `SuccessFactors`
diagnostics. Two representative `career*.successfactors.*` tenants expose the same public DWR
initial-search endpoint. The next bounded action is to trigger an empty public search on two tenants,
record only endpoint/body field names and response structure, and prove count/pagination/detail
identity without persisting DWR session values. The approval service hit its usage limit before that
request ran; do not infer a connector from the initial-page evidence alone. The Avature browser path
also received the same per-request SSRF guard used by generic browser scanning; TypeScript and lint
pass after that final hardening. Re-run the Avature targeted test/full gates when execution approval
is available (the attempted local run was blocked only from binding a sandbox loopback test server).

Run the next bounded HTTP-only discovery cohort and inspect every VERIFIED domain/source before
expanding further. The two canaries establish a clean hardened-rule sample, but expansion should
remain incremental (next 100, then 1,000 only if precision stays clean). Keep daily job loading
restricted to live registry rows that are active, `VERIFIED`, and backed by Greenhouse, Lever,
Ashby, Workday, SmartRecruiters, ADP Workforce Now, Paylocity, iCIMS, UKG Pro Recruiting, BambooHR,
Oracle Recruiting Cloud, Workable, Rippling Recruiting, Paycom, JazzHR, Jobvite, Breezy HR,
Teamtailor, ApplicantPro, Pinpoint, ClearCompany, Personio, ApplicantStack, Comeet, CATS, GoHire,
Newton / Recruiting by Paycor, SilkRoad, JobDiva, Taleo, ADP Recruiting Management, or Eightfold. Continue the same gated adapter workflow with the next
measured viable family. Do not claim the 67,237 registry organizations have ATS connectors: verified
domain, verified job source, active hiring source, and active job remain separate metrics.
