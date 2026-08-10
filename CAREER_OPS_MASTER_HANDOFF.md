# CAREER-OPS — MASTER DEVELOPMENT HANDOFF

**Purpose of this document:** a complete, self-contained technical handoff so an AI engineer with zero prior context on this project can safely continue development — specifically, plan and eventually build Phase 3 — without access to any previous conversation history. Written by inspecting the actual repository at the commit below, not from memory. Where this document and the code disagree, **the code wins** — every such discrepancy found during writing is called out explicitly rather than silently resolved.

---

## 0. VERIFIED REPOSITORY STATE (at time of writing)

```
Branch:        main
HEAD:          ba3f186b0c9cf18ee05af1a39b2652da024bdce8
origin/main:   ba3f186b0c9cf18ee05af1a39b2652da024bdce8  (identical — 0 ahead, 0 behind)
Working tree:  clean except .claude/settings.local.json (harness-managed local file, never commit)
```

```
npm test          -> 687 passed, 0 failed
npm run lint       -> clean
npm run build      -> clean (one pre-existing, non-blocking Turbopack tracing warning on
                      src/lib/match/candidateProfile.ts — cosmetic, not a build failure)
PRAGMA integrity_check      -> ok
PRAGMA foreign_key_check    -> zero violations
```

Recent commit history (`git log --oneline -10`):
```
ba3f186 chore: harden Career-Ops before Phase 3
0a0c3ec feat: add H1B employer source discovery + ATS Tier-3 browser fallback
7885fd0 feat: complete multi-candidate discovery and personalized jobs
43b5fac feat: add multi-candidate Career-Ops foundation
90725cc feat: add Phase 2 deterministic job eligibility, candidate matching, and readiness scoring
228f9f1 docs: add Career-Ops project handoff
c564291 feat: add optional AI job enrichment with OpenAI
51dd5e7 feat: add shared AI infrastructure
34e693a fix: stabilize workday identity on detail fetch failure
3ad04b5 feat: add configurable career ops settings
```

Live DB (`data/app.db`, gitignored, real personal data) row counts as of this writing: companies=13, jobs=5, candidates=1, h1b_sponsors=44,697, h1b_sponsor_filings=67,455, job_match_results=48, discovery_runs=2, employer_identity_resolutions=22, suppressed_jobs=29.

---

## 1. PROJECT PURPOSE

Career-Ops is a personal job-search operations system. Its end goal is a pipeline that finds real jobs from real employers, filters them to ones a specific candidate is actually eligible and well-matched for, and — eventually — produces tailored application materials for the best matches, with a human staying in control at every consequential step.

**Complete intended flow:**

```
Employer/job-source discovery                [BUILT — bounded, small-scale validated]
        ↓
ATS detection                                 [BUILT — Tier 1/2/3 waterfall]
        ↓
Job ingestion (connector / generic scraper)   [BUILT]
        ↓
Normalization                                 [BUILT]
        ↓
Dedupe                                        [BUILT]
        ↓
Lifecycle (active/archive/close/delete)       [BUILT]
        ↓
Job Intelligence (structured JD extraction)   [BUILT]
        ↓
H1B / work-authorization signal               [BUILT]
        ↓
Candidate eligibility                         [BUILT]
        ↓
Candidate/job matching + scoring              [BUILT — Phase 2]
        ↓
For You (ranked, filtered candidate view)     [BUILT — ranking logic; minimal UI added this pass]
        ↓
READY_FOR_TAILORING decision                  [BUILT — a decision value, not a UI workflow yet]
        ↓
Phase 3 — resume/cover-letter tailoring       [NOT BUILT — this is the next phase]
        ↓
Application workflow (submit/track)           [NOT BUILT — not even designed yet]
```

Everything above the `Phase 3` line exists, is tested, and has been validated against real (if small-scale) data. Everything from `Phase 3` down is genuinely unbuilt — no code, no schema, no design beyond the entry-contract shape documented in §24.

---

## 2. CURRENT DEVELOPMENT CHECKPOINT

See §0 for the exact verified numbers. In prose:

- 687 tests passing across `src/lib/**/__tests__`, `src/db/**/__tests__`, and (new this pass) three `src/app/api/**/__tests__` directories — the first time this project tests Next.js route handlers directly (construct a plain `Request`/`NextRequest` + `{params: Promise.resolve({...})}`, no server needed).
- Lint and build both clean.
- SQLite integrity and foreign-key checks both clean.
- Migrations are applied automatically by `src/db/index.ts`'s `getDb()`/`createConnection()` on first connection in any process — there is no separate "pending migration" state to track; `npm run migrate` (backed by `src/db/migrate.ts`) is a way to force this eagerly (and now also takes an automatic backup first — see §20).
- The only locally-uncommitted file is `.claude/settings.local.json` (harness-managed permission state) — this is expected and must never be committed.

---

## 3. COMPLETE DEVELOPMENT HISTORY

### Phase 1 — Job source ingestion (companies, jobs, dedupe, lifecycle, H1B baseline)
**Why:** the foundation — nothing downstream works without a reliable, deduplicated, lifecycle-managed jobs table.
**What/how:** `companies` (manually or auto-added ATS boards) → `scanCompany()` (`src/lib/scan.ts`) fetches jobs via a connector or the generic scraper → `dedupe.ts` computes a stable identity → `upsertJob()` (`src/db/queries/jobs.ts`) writes to `jobs` → `jobLifecycle.ts`'s age/status rules govern active/archive/delete.
**Consumes:** company records, ATS API responses / scraped HTML.
**Produces:** `jobs` rows with `dedupe_key`-based identity.
**Downstream:** everything — Job Intelligence, H1B signal, Phase 2 matching, all read `jobs`.

### Phase 2 — Deterministic job eligibility, candidate matching, scoring, readiness
**Why:** turn a shared `jobs` table into a candidate-specific, explainable "is this job worth tailoring for" answer, with zero AI/LLM involvement (deliberately deterministic in V1).
**What/how:** see §15 for full detail. `evaluateJobMatch()` (`src/lib/match/evaluateJobMatch.ts`) reads a candidate's profile file + job/job-intel data, builds `RequirementUnit`s, matches them, scores, decides eligibility, and produces a `Decision` (`BLOCKED`/`NEEDS_REVIEW`/`READY_FOR_TAILORING`).
**Consumes:** `jobs`, `job_skills`, `job_certifications`, `candidate-profile.json`, `candidate_settings`.
**Produces:** `job_match_results` rows (immutable, cache-keyed).
**Downstream:** For You ranking, and (not yet built) Phase 3.

### Phase 2.5 — Multi-candidate architecture + For You + ATS discovery
**Why:** the system needed to support more than one candidate without cross-contamination, and needed its own bounded, safe way to discover a company's careers page/ATS rather than requiring every company to be added by exact board token.
**What/how:** introduced `candidates`, `candidate_settings`, `candidate_job_state`, `candidate_job_state_history` (candidate-scoped personal state layered on top of shared `jobs`/`companies`); introduced `src/lib/ats/discovery.ts` (Tier 1/2, `safeFetch`-bounded) for auto-detecting a company's ATS from just a URL; introduced `src/lib/rank/forYou.ts`'s deterministic ranking algorithm.
**Consumes:** a company name + URL (discovery); `job_match_results` + `candidate_job_state` + ranking preferences (For You).
**Produces:** `companies.resolution_status`/`suspected_ats`/etc.; a ranked, filtered job list per candidate.
**Downstream:** the Companies page's discovery UI; the (now-built, previously missing) For You page.

### H1B Employer Source Discovery
**Why:** scale employer discovery beyond manually-added companies by working from the DOL's public H1B/LCA disclosure data (44,697 employers) — resolve a raw legal employer name to a real public company domain, then to a careers page/ATS, without ever fabricating an identity.
**What/how:** `src/lib/companyIdentity/` — a layered waterfall (curated override → Wikidata → SEC-corroborated or multi-signal-verified generated candidates) resolves `domain_identity_status`; `src/lib/discovery/batch.ts` orchestrates bounded batches. See §6.
**Consumes:** `h1b_sponsors` (recomputed from `h1b_sponsor_filings`), Wikidata's public API, SEC EDGAR's public ticker list.
**Produces:** `employer_identity_resolutions` rows, and (on success) new `companies` rows.
**Downstream:** the same ATS discovery/scan pipeline every manually-added company goes through — no special-casing.

### ATS Hardening (Tier-3 browser fallback)
**Why:** some careers pages only reveal their ATS link after client-side JS runs, which a plain HTTP fetch (Tier 1/2) can never see.
**What/how:** `src/lib/ats/discoveryBrowser.ts` — a real headless Chromium, read-only-first, at most one bounded "click" (a direct navigation to the single best-scored careers link, never a DOM `.click()`), SSRF-guarded via `isUrlSafeForNavigation` at both the seed URL and every subsequent navigation (`page.route` interception).
**Consumes:** a URL that Tier 1/2 already gave up on.
**Produces:** the same `DiscoveryResult` shape Tier 1/2 produce — no special downstream handling needed.
**Downstream:** `discoverCompanySourceWithBrowserFallback` is the only thing that calls it, itself only called from the batch orchestrator when Tier 1/2 resolves `UNRESOLVED`.

### Pre-Phase-3 Hardening (this session, first pass)
**Why:** before treating this system as a trusted source for Phase 3, a full audit found one live security gap and several smaller hardening gaps.
**What/how:** fixed the P0 SSRF gap in `genericPlaywright.ts` (the production career_link scraper had no SSRF guard, unlike Tier-3 discovery); added `busy_timeout` to the SQLite connection; fixed a For You bug where a candidate's own pinned/in-pipeline stale job silently vanished; added automatic pre-migration backups; added a cooldown to the manual "Retry Discovery" endpoint; built `/ats-coverage` (derived-only source-observability view, no new schema).
**Downstream:** every subsystem touched is described in its own section below with the fix noted inline.

### Final Hardening Correction (this session, second pass)
**Why:** a self-review of the first hardening pass found the DNS-failure classifier conflated "genuinely temporary" and "authoritatively will never work" failures, and found the automatic migration backup was fail-*open* (a broken backup step silently let a migration proceed) rather than fail-*closed*.
**What/how:** added `classifyDnsLookupError`/a new `dns_hostname_not_found` reason to `safeFetch.ts` so a nonexistent generated domain candidate correctly resolves `UNRESOLVED` (non-retryable) instead of `FAILED_TEMPORARY` (retried every 24h forever, pointlessly); changed `migrate.ts`'s backup step to throw and abort the migration by default on failure, with an explicit non-default `CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP=true` escape hatch; added a full route-level test matrix proving the For You STALE-exemption is exactly as narrow as intended and cannot leak across candidates.
**Downstream:** `discovery.ts`, `verifyDomain.ts` (both consume the corrected classification); `migrate.ts`'s callers (i.e., anyone running `npm run migrate`) now get a hard stop on backup failure instead of a silent skip.

---

## 4. CURRENT SYSTEM ARCHITECTURE

```
H1B DOL DATA (44,697 employers)         MANUAL COMPANY ADD (name + URL)
        │                                        │
        ▼                                        │
COMPANY IDENTITY RESOLUTION                       │
  (src/lib/companyIdentity/)                      │
  curated override → Wikidata → SEC/multi-signal  │
  → domain_identity_status                        │
        │                                         │
        └──────────────────┬──────────────────────┘
                            ▼
                  ATS DISCOVERY (src/lib/ats/discovery.ts)
                  Tier 1: URL pattern match (no network)
                  Tier 2: bounded safeFetch crawl, ≤3 pages/≤2 hops
                  Tier 3: discoveryBrowser.ts (Playwright, only if 1/2 UNRESOLVED)
                  → resolution_status: VERIFIED | NEEDS_ADAPTER | GENERIC_SUPPORTED | UNRESOLVED | FAILED_TEMPORARY
                            │
                            ▼
                  CONNECTOR / GENERIC SCRAPER
                  Workday | Greenhouse | Lever | Ashby   (real connectors, source_type-dispatched)
                  genericPlaywright.ts                    (career_link fallback, SSRF-guarded)
                            │
                            ▼
                  NORMALIZATION → NormalizedJob (src/lib/normalize.ts, src/lib/ats/*.ts)
                            │
                            ▼
                  DEDUPE (src/lib/dedupe.ts) — 4-tier key hierarchy
                            │
                            ▼
                  upsertJob() → jobs table
                            │
                            ▼
                  JOB INTELLIGENCE (src/lib/jobIntel/) — deterministic structured extraction
                            │
                            ▼
                  LIFECYCLE (src/lib/jobLifecycle.ts) — active/closed/archived/deleted, age-banded
                            │
                            ▼
                  H1B SIGNAL (src/lib/h1b/) — company confidence + JD-level override → h1b_combined_confidence
                            │
                            ▼
        ┌───────────────────┴────────────────────┐
        ▼                                         ▼
CANDIDATE SETTINGS/PROFILE                 candidate_job_state
(candidate_settings,                       (pipeline status, pinned,
 candidate-profile.json,                    not_interested, notes/tags —
 master resume/skills)                      candidate-scoped)
        │                                         │
        └───────────────────┬─────────────────────┘
                             ▼
                  PHASE 2 MATCH ENGINE (src/lib/match/)
                  requirement extraction → matching → scoring → eligibility → decide()
                  → job_match_results (immutable, cache-keyed per candidate)
                             │
                             ▼
                  FOR YOU RANKING (src/lib/rank/forYou.ts)
                  role family → decision rank → score band → sponsorship tier → ... → deterministic
                             │
                             ▼
                  READY_FOR_TAILORING (a Decision value on job_match_results — see §17)
                             │
                             ▼
                  [PHASE 3 — RESUME TAILORING — NOT BUILT, see §25]
```

**Observability layer (not in the main flow, reads from it):** `discovery_runs`, `scan_runs`, `match_runs`, `/ats-coverage` (derived from `companies`/`jobs`, no new schema).

---

## 5. DATABASE ARCHITECTURE

Full schema: `src/db/schema.sql` (base tables) + additive `ALTER TABLE` migrations in `src/db/index.ts` (companies' discovery/identity columns pre-date `schema.sql` support for them and are added on connect). SQLite via `better-sqlite3`, WAL mode, `busy_timeout=5000` (added in this hardening pass). File: `data/app.db` (gitignored).

**`companies`** — one row per employer/source. Base columns (name, source_type, ats_board_token, career_page_url, is_active, notes) plus H1B match columns (`h1b_match_*`, `h1b_confidence*`) plus scan-health columns (`last_scanned_at`, `last_scan_status/error`, `connector_health`, `consecutive_failures`, `last_error_category`, `last_successful_scan_at`, `last_failed_scan_at` — all additive migrations) plus discovery columns (`resolution_status`, `discovered_jobs_url`, `discovery_attempted_at`, `discovery_reason`, `suspected_ats` — additive) plus domain-identity columns (`verified_domain`, `domain_identity_status`, `last_successful_discovery_at` — additive, independent axis from `resolution_status`). **Not candidate-scoped — shared.**

**`jobs`** — one row per posting, identity = `dedupe_key` (unique). Carries legacy `pipeline_status`/`pinned`/`notes`/`tags`/`marked_for_tailoring` columns that are **frozen** — a read-only snapshot from before `candidate_job_state` existed; the app no longer writes to them in any live code path (verified: `updateJobPipeline`/`markNotInterested` in `src/db/queries/jobs.ts` have zero production callers, only test callers). Structured Job Intelligence columns are additive on this table too (seniority, employment_type_normalized, workplace_type_normalized, location_city, etc.). **Not candidate-scoped — shared.**

**`h1b_sponsors`** — recomputed rollup (never hand-edited) from `h1b_sponsor_filings`, one row per unique normalized employer, unique-indexed on `employer_name_normalized`.

**`h1b_sponsor_filings`** — raw DOL source of truth, one row per (employer, fiscal year), upserted (re-ingesting a year replaces it, never duplicates).

**`employer_identity_resolutions`** — one row per `h1b_sponsors.id` (unique-indexed), current-state (not append-only) domain-identity outcome. Independent axis from `companies.resolution_status`: a company's domain can be `VERIFIED` while its careers/ATS discovery is `FAILED_TEMPORARY` — this is a valid, expected combination, not a contradiction.

**`h1b_employer_domain_overrides`** — curated, human-reviewed employer→domain map. Empty by default (0 rows today), never auto-seeded. The correct remediation path for large/subsidiary-named employers whose generated domain candidate is wrong (see §21's Wikidata limitation).

**`discovery_runs`** — one row per bounded batch run, mirrors `scan_runs`'/`match_runs`' shape.

**`candidates`** — `id` is `AUTOINCREMENT` (unlike `companies.id`/`jobs.id`) specifically so a candidate id is never reused, since it's threaded into on-disk file paths.

**`candidate_job_state`** — candidate-scoped "my relationship to this shared job," keyed on `(candidate_id, dedupe_key)`, **not** `job_id` (survives the underlying job row being deleted by the age sweep). Holds `pipeline_status`, `pinned`, `not_interested(+reason)`, `marked_for_tailoring`, `notes`, `tags`.

**`candidate_settings`** — one row per candidate, PK = `candidate_id`. Split at the TypeScript layer (not separate tables) into match-affecting fields (`requires_sponsorship`, `us_citizen`, `work_authorized_us`, `clearance_level` — read only via `getMatchAffectingSettings`) and ranking-only preferences (`primary_target_role`, `secondary_target_roles`, `location_preference`, `workplace_preference`, `employment_type_preference` — read only via `getRankingPreferences`). `src/db/queries/candidateSettings.ts` deliberately exposes no "get everything" function.

**`job_match_results`** — immutable per exact cache key `(candidate_id, dedupe_key, match_engine_version, match_knowledge_hash, candidate_profile_hash, candidate_settings_hash, jd_content_hash)`. `job_id` is stored but **deliberately not a foreign key** (jobs.id can be reused after delete) — `dedupe_key` is the real identity. See §15 for full field meaning.

**`match_runs`** — batch-evaluation observability, mirrors `scan_runs`. **Known gap:** the single-job match route (`/api/jobs/[id]/match`) does not write to this table, only the batch route does — so this table undercounts real evaluation activity. Not fixed in this hardening pass (observability gap, not correctness).

**Candidate isolation rule (verified, not assumed):** every query against `job_match_results`, `candidate_job_state`, `candidate_settings` filters explicitly on `candidate_id` — confirmed via direct source inspection this session, not by convention alone. `companies`, `jobs`, `h1b_sponsors`, `job_skills`, `job_certifications`, `discovery_runs`, `employer_identity_resolutions`, `h1b_employer_domain_overrides` are correctly **shared/global**, never candidate-scoped.

---

## 6. JOB SOURCE ARCHITECTURE (company name → verified source)

`src/lib/companyIdentity/resolveDomain.ts`'s `resolveDomainIdentity()` is a 3-layer waterfall:

- **Layer 0 — curated override** (`h1b_employer_domain_overrides`): exact normalized-name lookup, instant `VERIFIED/high`, no network call. Checked first, unconditionally.
- **Layer 1 — Wikidata**: `wikidataLookup.ts` searches (`wbsearchentities`) then fetches claims (`wbgetentities`), looking for a single unambiguous match with a P856 (official website) claim. A single match → `verifyDomainIdentity` with `wikidataConfirmed: true` (self-sufficient — Path A, `high` confidence).
- **Layer 2 — generated candidates**: `domainCandidates.ts` generates 2 deliberately "dumb" guesses (`{words-joined}.com` and a hyphenated variant — no abbreviation/subsidiary logic). Each is independently checked via `verifyDomain.ts`:
  - **Path A (authoritative)**: `wikidataConfirmed` or `redirectConfirmed` alone is sufficient (`redirectConfirmed` is a defined-but-currently-unwired signal — see §22). `secConfirmed` (SEC EDGAR ticker match) needs ≥1 first-party channel too — SEC alone only confirms a legal name, not a domain.
  - **Path B (multi-signal, for private companies)**: needs ≥2 **distinct** first-party channels matching among {JSON-LD Organization schema, footer copyright/legal text, About page, Terms/Privacy page} → `VERIFIED/medium`. A same-URL redirect collapsing About and Terms into one page counts as only ONE channel, not two.
  - Any channel showing a **conflicting** identity → `AMBIGUOUS`, checked before Path A/B, so even a Wikidata-confirmed domain can be downgraded if the footer names a different legal entity.
  - Homepage fetch fails: `FAILED_TEMPORARY` if the reason is genuinely transient (timeout, network error, or — as of this hardening pass — a *transient* DNS failure), `UNRESOLVED` if the reason is authoritative (parking page, or — as of this hardening pass — the resolver reporting the hostname simply doesn't exist).

**Separation of concerns:** domain identity (`employer_identity_resolutions.domain_identity_status` / `companies.domain_identity_status`) answers "did we find the real company/domain." ATS/source discovery (`companies.resolution_status`) answers "did we find a scannable careers page/ATS for that domain." These are independent axes — a company can be domain-`VERIFIED` and source-`FAILED_TEMPORARY` simultaneously, and that is expected, not a bug.

---

## 7. ATS ARCHITECTURE

**Verified against code — exactly 4 real connectors exist:** `src/lib/ats/workday.ts`, `greenhouse.ts`, `lever.ts`, `ashby.ts`. No new connector was added in this session.

- **Tier 1** (`detect.ts`): pure regex match against the input URL itself — zero network calls — for the 4 known ATS URL shapes.
- **Tier 2** (`discovery.ts`): bounded `safeFetch` crawl (≤3 pages, ≤2 hops) looking for a Tier-1-matchable URL, an `UNSUPPORTED_ATS_SIGNATURES` match (9 named platforms: SmartRecruiters, iCIMS, Taleo, SuccessFactors, Jobvite, Workable, BambooHR, Breezy HR, Recruitee), or a plausible generic careers/jobs page.
- **Tier 3** (`discoveryBrowser.ts`): real headless Chromium, only invoked when Tier 1/2 return `UNRESOLVED`, for careers links that only render after client-side JS.

**Status outcomes:** `VERIFIED` (a real connector matched — source_type gets promoted) | `NEEDS_ADAPTER` (a *named, recognized* unsupported platform was found — `suspected_ats` set to that platform's name) | `GENERIC_SUPPORTED` (no known ATS, but a careers page was reached — falls back to `genericPlaywright.ts`) | `UNRESOLVED` (nothing found within bounds — this is the code's actual "unknown" state; there is no separate `UNKNOWN` status literal) | `FAILED_TEMPORARY` (a transient fetch error on the very first hop only).

**Detection ≠ an adapter existing.** `NEEDS_ADAPTER` only means the platform was *recognized by name* via `UNSUPPORTED_ATS_SIGNATURES` — no connector exists for any of those 9 platforms; a company stuck at `NEEDS_ADAPTER` stays there (retained, not auto-retried) until a human builds a real connector and reclassifies it. A platform outside that named list resolves `UNRESOLVED`, not `NEEDS_ADAPTER` — honest (no fabricated signature), not exhaustive.

**`/ats-coverage`** (`src/app/ats-coverage/page.tsx`, `GET /api/ats-coverage`, `src/db/queries/atsCoverage.ts`): built this pass, derived-only (zero new schema) — groups companies into Supported (by connector, with job counts + connector health), Needs Adapter (by suspected platform, so it's clear which one would unblock the most companies if built next), Generic, and Unresolved. Verified live in-browser this session against real data.

---

## 8. NETWORK/SECURITY ARCHITECTURE

**`safeFetch.ts`** (`src/lib/net/safeFetch.ts`) is the foundation — every discovery-layer network call goes through it. Blocks: non-http(s) schemes, `localhost`/loopback literals, private/link-local/reserved IPv4 and IPv6 ranges (including DNS-rebinding — every resolved address for a hostname is checked, not just the first), unsafe/looping/excessive redirects (each hop revalidated with the exact same checks as the original URL), oversized responses (checked via `Content-Length` and, more importantly, a hard streaming cap even without one).

**DNS classification (fixed this pass):** `dns.promises.lookup` failures used to all collapse into one `dns_resolution_failed` reason, treated as retryable everywhere. `classifyDnsLookupError()` now distinguishes `ENOTFOUND`/`ENODATA` (the resolver authoritatively says this host doesn't exist — new reason `dns_hostname_not_found`, never retried) from everything else (`EAI_AGAIN`, `ETIMEDOUT`, unknown — stays `dns_resolution_failed`, genuinely transient, retried after cooldown). Both `discovery.ts`'s `TRANSIENT_SAFE_FETCH_REASONS` and `verifyDomain.ts`'s `TRANSIENT_REASONS` sets deliberately exclude the new hard reason.

**Playwright navigation protection:** both browser-driving modules — `discoveryBrowser.ts` (Tier-3 discovery) and `genericPlaywright.ts` (the production career_link scraper, **fixed this pass** — it previously had zero SSRF protection) — use the identical two-part guard: `isUrlSafeForNavigation()` checked on the seed URL before `chromium.launch()`, plus a `page.route("**/*", ...)` handler that independently re-checks every subsequent request (including redirects and the page's own JS-driven navigation) and `route.abort()`s anything unsafe. This is the **only** sanctioned way a non-`safeFetch` code path validates URL safety in this project — never a second/duplicate implementation.

**Test-only escape hatch:** `allowPrivateNetworksForTests` (threaded through `safeFetch`, `isUrlSafeForNavigation`, `discoverCompanySource`, `discoverCompanySourceBrowser`, `scrapeCareerPageDetailed`, `resolveDomainIdentity`, `runDiscoveryBatch`) defaults `false` everywhere. **Verified this session, every production call site**: `scan.ts`/`normalize.ts` (the only two production callers of the generic scraper) pass zero options; all three API routes that call `discoverCompanySource` (`companies/route.ts`, `discover/route.ts`, `detect/route.ts`) pass only a URL string; `discover-employers.ts` (the only caller of `runDiscoveryBatch`) only threads `batchSize`/`useBrowserFallback` from CLI flags. No settings table, request body, or query param anywhere in the codebase can set this flag. It is not removed (test fixtures need it) but is structurally inert in production.

**Timeouts/concurrency/bounds:** `DISCOVERY_BATCH_SIZE=100`, `HTTP_DISCOVERY_CONCURRENCY=3`, `BROWSER_DISCOVERY_CONCURRENCY=1` (all hardcoded literals in `src/lib/discovery/batch.ts`, not env-configurable). `WIKIDATA_CONCURRENCY` is a literal alias of `HTTP_DISCOVERY_CONCURRENCY` — investigated this pass and found genuinely separating it is **not simple** without restructuring the per-employer pipeline into decoupled stages (the outer per-employer gate is the actual binding constraint today); left as a documented non-fix, not a token change. `safeFetch` default timeout is 10s; Tier-3 browser has its own tighter budgets (`discoveryConfig.ts`: `BROWSER_PAGE_TIMEOUT_MS=15_000`, `BROWSER_DISCOVERY_TIMEOUT_MS=30_000`).

---

## 9. JOB INGESTION

`fetchJobsForCompany()` (`src/lib/normalize.ts`) dispatches on `company.source_type` to the right connector (or `genericPlaywright.scrapeCareerPage` for `career_link`), producing `NormalizedJob[]` (`externalId`, `title`, `location`, `department`, `url`, `descriptionHtml`/`descriptionText`, `employmentType`, `workplaceType`, `salaryText`, `postedAt`, `raw`).

- **External ID**: ATS-native where available (Greenhouse/Lever/Ashby job IDs directly; Workday recovers one via regex from the detail-page path even if the detail fetch itself fails, so dedupe identity stays stable).
- **Canonical URL**: tracking params stripped via an explicit blocklist (not an allowlist — an unrecognized identity-bearing param survives on purpose).
- **`posted_at`**: always source-derived, **never** substituted with `first_seen_at`/`last_seen_at`/scan time (verified via direct grep of `upsertJob` this session — every write path traces back to the connector's own field). Reliability varies by source and is not flagged downstream: Greenhouse has no true "posted" timestamp and falls back to `updated_at` (documented in-code); Workday/Lever/Ashby all have a real posted/created field.
- **`source_type`**: set at company-creation/promotion time, never guessed per-job.
- **Company**: `company_id` FK, set at scan time from the company being scanned — never inferred from job content.
- **Location/description**: passed through as-is from the connector; the generic scraper's non-JSON-LD anchor-heuristic path never populates a description at all (falls back to the company-level H1B signal only) — this is a known, documented limitation, not a bug.

Validation before ingestion: `src/lib/ats/jobValidation.ts` gates the generic scraper's non-ATS, non-JSON-LD fallback with **positive-evidence** checks (a requisition-shaped URL, or a title+location/apply-action combo) plus an exact-phrase nav-word rejection list — "when uncertain, ingest nothing," not a blocklist-only approach.

---

## 10. DEDUPE

`src/lib/dedupe.ts` — 4-tier precedence, never combined/averaged, first match wins:

1. **ATS provider + external ID** — always wins when present, immune to content changes.
2. **Canonical URL** (`career_link` only) — tracking-param-stripped, blocklist approach.
3. **company + title + location + posted_at** (`career_link` only) — currently unreachable with the live generic scraper (its non-JSON-LD path never populates location/postedAt) but exercised via JSON-LD postings, which usually have specific URLs and hit tier 2 first anyway.
4. **Content fingerprint** (title + location + first 500 chars of description + canonical URL, hashed) — the fallback of last resort.

**Why this matters for future external providers (Apify or otherwise, not yet built — see §26):** tier 1 (ATS ID) is the only tier immune to content drift. A future external source that fabricates or omits a stable provider ID forces every one of its jobs down to tier 3/4, which are weaker and can produce false duplicates or false-new entries on re-scan. Any future multi-source integration must preserve official/first-party job identity whenever the source actually has one — never invent an ATS-shaped ID for a non-ATS source.

---

## 11. JOB LIFECYCLE

`src/lib/jobLifecycle.ts` — three independent facts, not one state machine: `is_active`/`closed_at` (found in the most recent scan of a live ATS board — `career_link` scrapes never set this, they're not authoritative), `is_archived`/`archived_at`/`archived_reason` (hidden from the default view), `pinned` (manual override).

**Age bands** (posted_at-or-first_seen_at derived, **never** last_seen_at): fresh (0–3 days), active (4–7), aging→archive (8–10), stale→**delete** (>10). A deleted job's fingerprint survives in `suppressed_jobs` so it never silently reappears as "new."

**`PROTECTED_PIPELINE_STATUSES`** (`jobLifecycle.ts`, exact real values): `Applied`, `Interviewing`, `Offer`, `Employer Rejected` — plus `pinned` independently. **`New` and `Interested` are NOT protected.** A protected job is never auto-archived or auto-deleted regardless of age. This exact set is reused (not reinvented) by the For You STALE-exemption fixed this pass — see §16.

`Not Interested` is a **candidate-scoped** flag (`candidate_job_state.not_interested`), reversible, distinct from the job's own lifecycle — it excludes the job from that one candidate's views without touching the shared `jobs` row at all.

---

## 12. H1B ARCHITECTURE

`h1b_sponsor_filings` (raw DOL disclosure data, per fiscal year) → `h1b_sponsors` (recomputed rollup). `normalizeEmployerName()` (`src/lib/h1b/normalizeEmployerName.ts`): uppercase, strip `.,'’` (no space substitution — see the known limitation below), strip trailing legal-suffix words iteratively (`inc`, `llc`, `corp`, `technologies`, `group`, `holdings`, etc. — never mid-name, so "Group Health Cooperative" keeps "Group").

**Matching** (`fuzzyMatch.ts`): exact normalized match (tier 1, O(1)) → curated alias (tier 2, `h1b_employer_aliases`, empty by default, wired but unpopulated) → fuzzy `token_sort_ratio` (tier 3, deliberately not `token_set_ratio` — the latter would false-positive "Acme" against "Acme Global Solutions Partners"), accepted only ≥88 similarity. Confidence scoring caps the fuzzy tier below exact/alias — it can reach "High" only with a near-exact score AND real volume, and can **never** reach "Very High" regardless of volume.

**Known normalization limitation (deferred, documented, not fixed):** a legal suffix with no space before it (`"Freyr,Inc."`) fuses into one token and is never stripped, since the suffix-pop loop only operates on whitespace-split tokens. Confirmed live: ~45 of 44,697 `h1b_sponsors` rows match this pattern. **Deliberately not fixed** — a real fix requires a full re-normalization + re-match migration across all sponsor rows and every company's H1B link, out of scope for a hardening pass. `h1b_employer_aliases` is the correct near-term remediation for specific affected employers as encountered.

**JD-level override** (`combineSignal.ts`): a job's own explicit sponsorship language always wins over the company's historical confidence — negative JD language is a hard override to "Not Sponsoring" regardless of company history; positive JD language overrides up to "Very High."

**CRITICAL, verified boundary:** company/domain identity resolution (`src/lib/companyIdentity/`, §6) **never** touches `h1b_confidence`/`h1b_combined_confidence`, and neither touches Phase 2 scoring. Verified this session by grepping `src/lib/match/decision.ts` and `scoring.ts` directly — **zero references to H1B/sponsorship in either file**. The only place sponsorship data enters Phase 2 at all is `eligibility.ts`, and only as a binary hard-blocker gate (explicit JD negative + candidate requires sponsorship → `BLOCKED`) or an "unknown, not assumed" signal — never a score input. `schema.sql`'s own comment on the H1B-source-discovery tables states this boundary explicitly and it is enforced by a dedicated regression test (`employerIdentityResolutions.test.ts`'s boundary test).

---

## 13. JOB INTELLIGENCE

`src/lib/jobIntel/extractJobIntel.ts` — pure, deterministic, no DB/network access, orchestrates independent extractors over one job's already-scanned data. Verified fields (`src/lib/jobIntel/types.ts`'s `StructuredJobIntel`):

- **`seniority`**: `{level, evidence}` — from title first, body-text fallback only if title yields "Unknown."
- **`employmentType`**: `{type, evidence}` — normalized vocabulary from ATS-native field + text fallback.
- **`location`**: `{workplaceType, officeDays, primary: {city,state,country}, locations[], relocation, travelPct}`.
- **`experience`**: `{minYears, preferredYears, byTech: [{technology, years}], evidence}`.
- **`education`**: `{level, field, requirement, equivalentExperienceAllowed, evidence}`.
- **`compensation`**: `{min, max, currency, period, bonus, commission, equity}`.
- **`clearance`**: `{required, level, citizenshipRequired, workAuthorizationRequired, evidence}` — feeds Phase 2 eligibility directly.
- **`domain`**: `{domain, evidence}` — the JD's industry/product domain, informational.
- **`qualityFlags`**: `string[]` — signal-quality flags (e.g. clearance + no sponsorship note together).
- **`skills`**: `SkillMatch[]` — `{skillName, category, requirementLevel, alternativeGroupId, evidenceSnippet}`, persisted to `job_skills`. `alternativeGroupId` is how "AWS OR Azure"-style OR-groups are represented — shared ID across every member.
- **`certifications`**: `CertificationMatch[]`, persisted to `job_certifications`.
- **`sections`**: `{responsibilities, requiredQualifications, preferredQualifications, benefits}` — parsed heading-based, reused by Phase 2's unclaimed-requirement detector.
- **`extractionVersion`**: bumped when extraction logic changes; `EXTRACTION_VERSION` is written to `jobs.structured_extraction_version` but — **known gap, verified this session** — never read back anywhere to gate re-extraction. Re-extraction currently runs unconditionally on every scan, which is wasteful but not corrupting (transactional overwrite via `upsertJobIntel`).

---

## 14. CANDIDATE ARCHITECTURE

`createCandidate({firstName, lastName})` (`src/db/queries/candidates.ts`) — `id` is `AUTOINCREMENT`. `getActiveCandidateId()`/`setActiveCandidateId()` is explicitly documented as **only a UI convenience default** (which candidate a fresh page load starts on) — no candidate-scoped write endpoint relies on it internally; every real endpoint takes an explicit `candidateId`.

**MUST always be `candidate_id`-scoped:** `candidate_settings`, `candidate_job_state`, `candidate_job_state_history`, `job_match_results`, `match_runs`, master files (`data/candidates/<id>/master/`), `candidate-profile.json` (`data/candidates/<id>/candidate-profile.json`).

**Correctly shared/global, never candidate-scoped:** `companies`, `jobs`, `job_skills`, `job_certifications`, `h1b_*` tables, `discovery_runs`, `employer_identity_resolutions`.

**Verified isolation mechanics:** `candidateProfile.ts`'s own doc comment states there is no implicit "current candidate" fallback anywhere in that module — "a caller that gets the wrong candidateId gets the wrong candidate's data." Every `job_match_results`/`candidate_job_state` query filters `WHERE candidate_id = ?` explicitly (verified by direct source read this session, not by convention). This hardening pass added an end-to-end test proving one candidate pinning a job does not surface it in a different candidate's view (`src/app/api/candidates/__tests__/forYouProtection.test.ts`).

**One known, low-severity inconsistency (not fixed, not a leak):** `GET /api/jobs` accepts an optional `candidateId` without calling `requireActiveCandidate()` like every other candidate-scoped route does — an invalid/archived candidate id silently gets the all-default overlay instead of a 404. The SQL is still correctly parameterized; nothing leaks.

---

## 15. PHASE 2 MATCH ENGINE (detailed)

Orchestrator: `evaluateJobMatch()` (`src/lib/match/evaluateJobMatch.ts`). Pure function, no DB access itself — callers (`/api/jobs/[id]/match`, `/api/jobs/match/batch`) assemble the input from Phase 1's own query layer. `MATCH_ENGINE_VERSION = 2` (bumped once already, during real-data validation, when `computeEmployerEvidencedShare` was fixed to exclude education/certification units — see below).

**1. Candidate profile load** (`loadCandidateProfile`): `missing`/`invalid`/`stale` → immediately returns `{status: "unavailable", reason: ...}` — **no match result is ever computed or cached in these cases**, which is the actual mechanism that makes "a missing/stale profile can never produce READY_FOR_TAILORING" true by construction (not a separate check — there is simply nothing to check, no row is written).

**2. Requirement extraction** — three unit-producing paths, all yielding `RequirementUnit`s:
   - `collapseSkillUnits(job_skills, jobTitle)` — job_skills rows sharing an `alternative_group_id` collapse into one OR-group unit (satisfying ANY member satisfies the whole unit — never split back into per-member credit).
   - `buildCertificationUnits`/`buildEducationUnit` — from `job_certifications` / the JobIntel education extraction.
   - `detectUnclaimedRequirements` — scans the JD's required/preferred-qualifications text for lines that describe a real requirement no structured extractor captured, excluding anything already claimed by a skill/cert/education unit or matching boilerplate/EEO text.

**3. Matching** (`matchAllRequirementUnits`) against the candidate's normalized profile skills, producing `MatchType`: `MATCHED` (with `evidence.source: "employer"` or `"inventory_only"` — employer-attributed credit is never reduced even by a hands-on-experience cue, since real evidence already proves depth) | `TRANSFERABLE` (a fixture-pair-only adjacency table, currently **empty** in the shipped taxonomy — no ecosystem pairs seeded in V1) | `MISSING` (no match, no transferable pair) | `UNRESOLVED` (an unclaimed-text unit that couldn't be confidently classified — never guessed as matched or missing).

**4. Dimension scores** (`SCORING_WEIGHTS`: required=50, preferred=15, experience=20, seniority=15): each dimension is `null` (inapplicable, not a fabricated 0%) if its unit pool is empty. `computeOverallScore` redistributes weight proportionally across only the applicable dimensions — never divides by zero, never caps/mutates after the fact (an earlier score-cap mechanism was explicitly removed in favor of `decide()`'s independent critical-gap gate).

**5. Coverage/evidence metrics:** `requirementCoverage` (criticality-weighted, `CRITICAL`=3/`REQUIRED`=2/`PREFERRED`=1/`OPTIONAL`=0.5 — zero total evidence reads as zero, never skipped). `employerEvidencedShare` (what fraction of Required-pool earned credit is employer-attributed vs. inventory-only — restricted to `skill`/`skill_group` units only; education/certification units are a binary yes/no fact with no evidence-strength distinction, and counting them here was a real bug found and fixed during real-data validation, which is why `MATCH_ENGINE_VERSION` is 2, not 1). `insufficientJdSignal` (fewer than `MIN_REQUIREMENT_UNITS=3` total units extracted). `criticalGaps` (CRITICAL-criticality units that are MISSING or UNRESOLVED).

**6. Eligibility** (`evaluateEligibility`, §12's boundary applies) — `PASS`/`BLOCKED`/`UNKNOWN`. **`PASS` means only "no known hard blocker," never "confirmed eligible"** — this exact phrasing is in the code's own doc comment and must never be weakened.

**7. `decide()`** (`decision.ts`) — `BLOCKED` wins immediately and unconditionally if eligibility is `BLOCKED`. Otherwise reasons accumulate (eligibility `UNKNOWN`, insufficient JD signal, any critical gap, `overallScore < 80`, `requirementCoverage < 0.85`, `employerEvidencedShare < 0.5`) — zero reasons → `READY_FOR_TAILORING`; any reasons → `NEEDS_REVIEW`.

**8. Track recommendation** (`recommendTrack`) — category-overlap scoring against `TRACK_PROFILES` (`Azure Data Engineer`, `Data Engineer`, `Snowflake Data Engineer`, `Azure Databricks Engineer`, `AI Engineer`, `General/Unclassified`). Computed from `RequirementUnit`s only — never from `overallScore`/`decision`/anything candidate-derived — confirmed structurally independent of scoring.

**9. Cache identity** (`job_match_results`'s 7-part unique key, §5) — `matchKnowledgeHash` is a `matchKnowledgeHash.ts` fingerprint over every purely-data matching constant (taxonomy, transferable pairs, credit table, weights, thresholds, track profiles, hands-on-cue regex), invalidating the cache automatically on data-only edits with no manual version bump needed. `MATCH_ENGINE_VERSION` must be bumped by hand only for algorithmic/logic changes.

**Hypothetical job trace:** a Data Engineer JD requiring "5+ years, AWS or Azure (required), Snowflake (preferred), Bachelor's in CS," candidate has 6 years, AWS (employer-attributed), no Snowflake, Master's in CS → `collapseSkillUnits` produces one AWS-OR-Azure unit (CRITICAL) and one Snowflake unit (PREFERRED); `buildEducationUnit` produces one education unit (REQUIRED, satisfied — Master's exceeds Bachelor's). Matching: AWS-OR-Azure → `MATCHED`, employer-attributed, full credit (the OR-group is satisfied by AWS alone). Snowflake → `MISSING`. Education → `MATCHED`. `required` dimension scores high (education always satisfied, the critical skill matched); `preferred` scores low (Snowflake missing, only unit in that pool). Experience dimension: 6/5 years → clamped to 100. No critical gaps (the AWS-OR-Azure unit, even if CRITICAL, matched). `employerEvidencedShare` is high (AWS is employer-attributed). Net: likely `overallScore` ≥ 80, `requirementCoverage` ≥ 0.85 (both units resolved), `employerEvidencedShare` ≥ 0.5 → **`READY_FOR_TAILORING`**, `recommendedTrack` likely "Snowflake Data Engineer" or "Data Engineer" depending on category-weighting of the extracted units.

**Naming note (verified, not a bug):** `evaluateJobMatch`'s `candidateSettings` parameter is typed `AppSettings["candidate"]`; `src/db/queries/candidateSettings.ts` separately defines `export type MatchAffectingCandidateSettings = AppSettings["candidate"]` — these are the **identical type**, just two names for it. Real callers always pass `getMatchAffectingSettings(candidateId)`'s result, never the full `candidate_settings` row.

---

## 16. FOR YOU RANKING

`src/lib/rank/forYou.ts`'s `rankForYou()` — pure, DB-free, never touches Phase 2 scoring, only orders already-computed facts. Sort key, in strict order: **role-family tier → decision rank (`READY`<`NEEDS_REVIEW`<`NOT_EVALUATED`<`BLOCKED`) → score band (10-point buckets) → sponsorship tier (explicit-positive < strong-history < weak-history < unknown < explicit-negative) → exact score → employer-evidenced share → requirement coverage → freshness tier → posted_at → job id (final deterministic tie-break)**.

**Freshness tiers**: `PRIMARY` (0–10 days) / `SECONDARY` (11–20) / `UNKNOWN_DATE` (null/unparseable/future-dated — never fabricated from another field) / `STALE` (>20). **Note these are different day boundaries than `jobLifecycle.ts`'s archival bands (0–3/4–7/8–10/>10)** — two independently-thresholded concepts (ranking vs. archival), deliberate but a real source of confusion if conflated.

**STALE exemption (fixed this pass, verified narrow):** `STALE` jobs are excluded from the default view **unless** `protectedFromStale` is true — computed by the caller (`for-you/route.ts`) via `isLifecycleProtected({pipelineStatus, pinned})`, the **exact same function and `PROTECTED_PIPELINE_STATUSES`** used by archival (§11) — not a reinvented rule. `New`/`Interested` are correctly NOT exempt. Verified end-to-end this pass: a candidate's own pinned/Applied/Interviewing/Offer/Employer-Rejected stale job stays visible; another candidate's protection on the same job never leaks into a different candidate's view (proven via a real 2-candidate DB test, not just code reading).

**UI:** `/api/candidates/[candidateId]/for-you/route.ts` exists and is thoroughly tested at the ranking-function level. **Confirmed via direct directory listing this session: no frontend page consumes it — `src/app/for-you/` does not exist.** The only new page this hardening pass actually shipped is `/ats-coverage` (§7); a For You dashboard page was scoped as optional P2 work during planning and was not built. The ranking algorithm and API are solid and ready to be consumed; the dashboard itself is genuinely unbuilt.

---

## 17. READY_FOR_TAILORING — exact code-level definition

**Do not invent a different definition than what's below — this is copied directly from `src/lib/match/decision.ts`.**

`READY_FOR_TAILORING` is one of exactly three `Decision` values (`"BLOCKED" | "NEEDS_REVIEW" | "READY_FOR_TAILORING"`, `src/lib/match/types.ts`), produced only by `decide()`:

```ts
// decide() returns READY_FOR_TAILORING iff ALL of the following hold:
eligibility.status !== "BLOCKED"                       // no hard blocker
&& eligibility.status !== "UNKNOWN"                     // sponsorship signal not unknown
&& !insufficientJdSignal                                 // >= 3 requirement units extracted
&& criticalGaps.length === 0                             // no CRITICAL unit missing/unresolved
&& overallScore >= 80                                     // READINESS_THRESHOLDS.minScore
&& requirementCoverage >= 0.85                            // READINESS_THRESHOLDS.minCoverage
&& employerEvidencedShare >= 0.5                          // READINESS_THRESHOLDS.minEmployerEvidencedShare
```

If ALL hold, `blockingReasons` is empty and `decision === "READY_FOR_TAILORING"`; this is enforced as an invariant (`blocking_reasons` is documented in `schema.sql` as "empty iff decision = 'READY_FOR_TAILORING'"). The **only** way a job enters Phase 3 eligibility should be reading `job_match_results.decision === 'READY_FOR_TAILORING'` for the current, non-superseded (`status = 'active'`) cache row for that exact `(candidate_id, dedupe_key)` — never recomputing this logic, never inferring it from `overall_score` alone.

---

## 18. MASTER FILES

Per candidate, on disk at `data/candidates/<candidateId>/master/` (gitignored — real personal resume/skills data): `resume.{docx,md,txt}`, `skills.{docx,md,txt}` (the only two slots — `SLOTS = ["resume", "skills"]` in `master-files/route.ts`), `manifest.json` (filename, upload timestamp, size, sha256 per slot), `history/` (previous versions moved here on re-upload, never overwritten/lost).

**`candidate-profile.json`** (`data/candidates/<candidateId>/candidate-profile.json`) is a **derived index only** — built through the Claude entry point `.claude/skills/build-candidate-profile/SKILL.md` (`/build-candidate-profile <candidate_id>`) or the Codex entry point `.agents/skills/build-candidate-profile/SKILL.md` (`$build-candidate-profile <candidate_id>`), never by app code. `loadCandidateProfile()` compares its embedded `sourceHashes.{resume,skills}` against the manifest's *current* sha256 values on every load — a mismatch (or a missing manifest hash) is always treated as `"stale"`, never assumed fresh. The Master Resume/Skills Inventory files themselves remain the sole factual authority at all times; the profile JSON is never trusted over them.

**Resume tracks:** `ResumeTrack` (`"Azure Data Engineer" | "Data Engineer" | "Snowflake Data Engineer" | "Azure Databricks Engineer" | "AI Engineer" | "General / Unclassified"`) exists today only as `evaluateJobMatch`'s **informational** `recommendedTrack` output — there is no per-track resume content/template stored anywhere yet; that's Phase 3 work (§25).

**Candidate-scoped tailoring discrepancy resolved before Phase 3:** both `.claude/skills/tailor-resume/SKILL.md` and `.agents/skills/tailor-resume/SKILL.md` require an explicit `candidateId` plus job identity, validate the active candidate, read only `data/candidates/<candidateId>/master/{manifest.json,resume.*,skills.*}`, preserve that candidate's manifest hashes, and forbid fallback to legacy `data/master/` or another candidate's files. The Claude and Codex entry points both invoke the single temporarily canonical engine at `.claude/skills/tailor-resume/engine/`; the duplicate `.agents` engine copy was removed. Moving the engine to a neutral production location is explicitly deferred to Phase 3 implementation planning.

**Privacy boundaries:** `data/` (the whole directory, including all candidates' master files, backups, generated files, H1B datasets, the DB itself) is gitignored with an explicit comment naming this exact concern — verified this session via `git ls-files | grep ^data/` returning zero results (nothing under `data/` has ever been committed). `public/` (Next.js static assets) is empty — no candidate content is ever served through it. The `master-files` API's GET response returns only manifest metadata (filenames/hashes/timestamps), never raw file content.

---

## 19. OBSERVABILITY

- **`scan_runs`** — one row per company-scan attempt (`src/lib/scan.ts`): jobs discovered/added/updated/unchanged, description failures, retry count, error category/message.
- **`match_runs`** — one row per **batch** Phase 2 evaluation (single-job route does not log here — a known undercounting gap, not fixed this pass).
- **`discovery_runs`** — one row per bounded H1B-discovery batch: domain/source resolution counts by outcome, duration.
- **`companies.discovery_reason`** — free-text, human-readable "why unresolved" string, already surfaced in the Companies page's "Unsupported / Unresolved Sources" section. No structured/machine-classifiable enum exists on top of this (a `discovery_failure_category` column was proposed during planning and explicitly **not built** — found unnecessary; the free text already answers the stated need, and building a redundant structured column without real demonstrated need was rejected per this project's own "don't add redundant counters" principle).
- **`/ats-coverage`** — see §7.
- **`companies.connector_health`/`consecutive_failures`/`last_error_category`** — surfaced on the Scanner page (`connector_health`/`consecutive_failures`); `last_error_category` is written on every partial/failed scan but has **no UI render site** — a real, still-open observability gap.

---

## 20. BACKUP/RECOVERY

**Automatic pre-migration backup** (`src/db/migrate.ts`'s `backupBeforeMigration()`, added this hardening pass): before `npm run migrate` applies schema changes, copies `data/app.db` + `-wal`/`-shm` sidecars to `data/backups/<name>.pre-migration-<timestamp>.bak`, matching the exact naming convention 46+ pre-existing manual snapshots already used. Retention: newest 20 automatic snapshots kept, older pruned (manual snapshots from earlier sessions are never touched by this pruning).

**Fail-closed by default (corrected in the second hardening pass — was originally fail-open, found to defeat its own purpose):** if the DB already exists and the backup cannot be written (permission/disk-full/I/O/invalid destination), the migration **does not run** — `backupBeforeMigration()` throws `MigrationBackupError`, the script logs it and calls `process.exit(1)`. First-ever run (DB doesn't exist yet) is a safe no-op, not a failure. The only bypass is the explicit, non-default `CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP=true` environment variable — never assumed, never set by default.

**Restore procedure** (documented in `CAREER_OPS_HANDOFF.md`'s §11, drilled and verified this session): copy the relevant `data/backups/app.db*.pre-*.bak` files to a **throwaway** location (never overwrite the live `data/app.db` directly), rename off the `.bak` suffix, run `PRAGMA integrity_check`/`PRAGMA foreign_key_check` and spot-check row counts before trusting it, stop the app, then copy over the live file only once confident.

**Not included in the DB backup:** master files (`data/candidates/<id>/master/`) and `candidate-profile.json` live outside the database entirely as separate on-disk files — a DB restore does not restore them. They are lower-risk (rarely modified, and `history/` already preserves prior versions on re-upload) but are a separate, un-backed-up asset class worth being aware of.

---

## 21. PERFORMANCE / SCALE

**What has actually been tested — do not claim more:** a single bounded `npm run discover-employers -- --batch-size 10` run against the live 44,697-row `h1b_sponsors` table. Result: 36.7s total (~3.6s/employer), 2 newly `VERIFIED`, 1 `UNRESOLVED`, 7 initially `FAILED_TEMPORARY` (an 80% combined rate — breached this project's own 50% stop threshold, so the run was **not** scaled further to 50/100/etc.).

**Root cause of the high failure rate (investigated, not just observed):** Wikidata's `wbsearchentities` returns zero matches for verbose DOL legal-entity names (`"WAL-MART ASSOCIATES, INC."`, `"Amazon.com Services LLC"` — confirmed via a direct manual API query), so resolution falls to the deliberately "dumb" generated-domain-candidate path, which guesses a domain that simply doesn't exist for large companies' compound/subsidiary legal names. After the DNS-classification fix (§8/§21), re-verifying against the same real employer names directly: `Amazon.com Services LLC` and `HCL AMERICA INC` now correctly resolve `UNRESOLVED` (non-retryable); `WAL-MART ASSOCIATES, INC.` still resolved `FAILED_TEMPORARY` on re-check — a different, genuinely transient condition that run. The correct fix for the *remaining* gap is populating `h1b_employer_domain_overrides` for known large employers as encountered — **not** weakening the domain-candidate generator or the classifier.

**Explicitly unmeasured:** query performance at real job-table scale (only 5 job rows exist today — `EXPLAIN QUERY PLAN` shows a temp B-tree sort on `jobs` listing and a full ordered scan of all 44,697 `h1b_sponsors` rows per discovery batch, both currently sub-millisecond at this scale and **not** index-optimized speculatively, per the project's explicit "don't add indexes without measured need" principle); Wikidata/SEC fair-use pressure at higher batch sizes; browser-fallback behavior at concurrency > 1 (currently hardcoded to 1, serial).

**Never claim 44k-employer readiness** — the architecture is designed to scale that direction (bounded batches, resumable/idempotent by construction — `nextPriorityEmployers` excludes anything already terminal), but it has never been run past a 10-employer batch, and the next concrete step is a **controlled, gated** 50-employer run, not a jump to the full table.

---

## 22. KNOWN LIMITATIONS

**GREEN — completed/stable:**
- SSRF protection (both `safeFetch` and both Playwright modules — fixed and consistent as of this hardening pass).
- DNS hard-vs-transient classification.
- Candidate isolation (`candidate_job_state`/`job_match_results`/`candidate_settings`, verified via direct query inspection and an end-to-end 2-candidate test).
- H1B/company-identity boundary into Phase 2 scoring (verified zero coupling).
- Dedupe tiering, job lifecycle age-banding, master-file staleness detection.
- Migration backup (fail-closed, drilled restore).
- SQLite `busy_timeout` / WAL concurrency hygiene.

**YELLOW — works, needs future improvement or scale evidence:**
- Job source reliability — only validated at n≤21 companies total.
- Wikidata's poor fuzzy-matching on verbose legal names — real, mitigated by curated overrides, not eliminated.
- H1B normalization fused-punctuation edge case (~0.1% of sponsor rows) — deferred, documented, needs a dedicated migration.
- Query performance at real scale — genuinely unmeasured, not assumed fine.
- `match_runs` undercounts (single-job route doesn't log there).
- `last_error_category` has no UI render site.
- `structured_extraction_version` is written but never read back to gate re-extraction (wasteful, not corrupting).
- `redirectConfirmed` domain-corroboration signal is defined but unwired (module doc discloses this openly).
- `WIKIDATA_CONCURRENCY` is a non-independent alias — investigated, genuinely not simple to fix without pipeline restructuring.
- The For You dashboard's actual frontend page status should be re-verified directly in `src/app/` before assuming it exists — see §16's caveat.

**RED — blockers:** **none currently open.** (The one RED item found this session — the `genericPlaywright.ts` SSRF gap — was fixed, tested, and committed as part of `ba3f186`.) Do not manufacture a RED item where none is evidenced.

---

## 23. FROZEN ARCHITECTURE

Phase 3 (and any future work) should **not** redesign these unless a concrete correctness/security defect is discovered — not merely a stylistic preference:

- **Phase 1 ingestion/dedupe/lifecycle** (`src/lib/dedupe.ts`, `src/lib/jobLifecycle.ts`, `src/lib/scan.ts` and its safety rule that failed/partial scans never close/archive jobs).
- **Phase 2 eligibility/scoring** (`src/lib/match/**` — `decision.ts`'s gating order, `scoring.ts`'s weight/threshold formulas, `eligibility.ts`'s "PASS means no known blocker" contract). `MATCH_ENGINE_VERSION` exists specifically so intentional algorithmic changes are trackable — bump it, don't silently redefine behavior under the same version.
- **H1B scoring boundary** (§12) — company/domain identity resolution must never feed sponsorship confidence or Phase 2 scoring, ever.
- **Candidate isolation** (§14) — every candidate-scoped table's `candidate_id`-filtering discipline.
- **Source discovery architecture** (§6/§7) — the domain-identity vs. ATS-discovery axis separation, the Tier 1/2/3 waterfall, `safeFetch`/`isUrlSafeForNavigation` as the sole sanctioned network-safety mechanism.
- **`job_match_results`' immutable-cache-key design** — never mutate a row in place; supersede via a new row.

---

## 24. PHASE 3 INPUT CONTRACT

Verified against code (`job_match_results` schema, `candidateProfile.ts`, `master-files/route.ts`, `jobIntel` queries) — this is what Phase 3 can actually consume today without recomputing Phase 1/2 truth:

```
{
  candidate_id, dedupe_key, job_id,

  job:                { title, company, url, descriptionText, postedAt, location }
                        // from jobs / companies join — src/db/queries/jobs.ts's listJobs/getJob

  job_intelligence:    { skills, certifications, requirementUnits-derivable-inputs, sponsorshipSnippet }
                        // job_skills, job_certifications tables + jobs' structured-intel columns

  job_match_result:    { decision, overall_score, requirement_coverage, employer_evidenced_share,
                          recommended_track, blocking_reasons, match_engine_version,
                          candidate_profile_hash }
                        // job_match_results — MUST be the current (status='active'), latest row
                        // for (candidate_id, dedupe_key) via getLatestJobMatchResult()

  candidate_profile:   { path: data/candidates/<id>/candidate-profile.json, sourceHashes }
                        // loadCandidateProfile() — MUST be status:"ok", never "stale"/"missing"

  master_files:        { resume path, skills path, manifest sha256 hashes }
                        // data/candidates/<id>/master/ + manifest.json

  candidate_settings:  { requires_sponsorship, us_citizen, work_authorized_us, clearance_level,
                          primary_target_role, ... }
                        // candidate_settings table

  readiness:           job_match_results.decision === "READY_FOR_TAILORING"
                        ? "READY_FOR_TAILORING"
                        : "NOT_READY"
                        // "MANUAL_OVERRIDE" is a NAMED EXTENSION POINT ONLY — no column exists
                        // for it yet (candidate_job_state.tailoring_override would be the natural
                        // place if Phase 3 ever needs one). Do not build it speculatively.
}
```

This is ~90% satisfiable today by a single **read-composition** function — no new storage is required except the explicitly-deferred manual-override extension point, which should only be added once Phase 3 actually needs it.

---

## 25. PHASE 3 — WHAT ACTUALLY EXISTS vs. NOT YET BUILT

**Important correction to a naive "nothing exists" assumption:** a real, working, DOCX-generating resume/cover-letter tailoring capability **already exists** with a Claude entry point at `.claude/skills/tailor-resume/SKILL.md` (`/tailor-resume`) and a Codex entry point at `.agents/skills/tailor-resume/SKILL.md` (`$tailor-resume`). Both are manual agent skills, not app features, and both reference the one temporarily canonical engine at `.claude/skills/tailor-resume/engine/`. It is genuinely substantial, not a stub:

- A documented pipeline (`SKILL.md`): Master sources + JD → fact/evidence model → JD analysis → tailoring decision (scoring/selection/ordering/rewriting, done by the AI agent's own reasoning, not app code) → structured `ResumeContent`/`CoverLetterContent` JSON → DOCX rendering (`engine/resume-template.ts`, `engine/cover-letter-template.ts`) → layout validation (`engine/validate-docx.ts`, runs automatically) → final output.
- Explicit guardrails: "deep rewrite, not light editing," every fact must trace back to the Master Resume/Skills Inventory, an explicit "Attribution rule" distinguishing employer-proven skills from inventory-only ones (the same distinction Phase 2's `employerEvidencedShare` gate encodes independently — these two systems currently reason about the same concept separately, not shared code).
- Real fixtures/tooling: `engine/fixtures/`, `engine/fixtures/run-fixtures.ts` (referenced from `CAREER_OPS_HANDOFF.md`'s testing procedures as `npx tsx .claude/skills/tailor-resume/engine/fixtures/run-fixtures.ts`), `engine/visual-check/` (a screenshot-based visual review tool).

**What this means for Phase 3 planning:** the "generate a tailored resume" problem is largely already solved *as a manual, human-in-the-loop skill invocation*. The pre-Phase-3 normalization resolved the candidate-scoping discrepancy and consolidated both entry points onto one engine. What's genuinely missing is the **production integration** between this capability and the rest of the app's data pipeline; moving the canonical engine to a neutral production location remains deferred to Phase 3.

**Confirmed NOT BUILT** (no app-code integration exists for any of this):
- Any automated/app-triggered invocation of the tailoring skill from a `READY_FOR_TAILORING` job — today it's entirely manual, and the skill doesn't read `job_match_results`, `candidate_job_state`, or any Phase 2 output at all; it works from a JD pasted/provided directly.
- Dashboard integration (a "start tailoring" action from For You / job detail — there's no For You page yet either, see §16).
- Tailoring status tracking beyond a bare boolean (`marked_for_tailoring`/`tailoring_marked_at` exist on both `jobs` (frozen/legacy) and `candidate_job_state` (live) — a flag only, no workflow state machine).
- Resume versioning tied to the app's data model (the skill's own `history/`-style output isn't wired to `job_match_results`/`candidate_job_state` at all).
- LLM provider abstraction *for this skill* — it runs as Claude Code reasoning directly, not through `src/lib/ai/`'s shared provider abstraction (which exists for a different, already-built feature — optional job-intel enrichment — with its own `ai_enrichments`/`ai_usage_log`/`ai_audit_log` tables and `entity_key`-not-`entity_id` identity-safety convention; not wired to tailoring today, but a reasonable pattern to reuse if tailoring is ever brought into the app's own automated pipeline rather than staying a Claude-Code-skill workflow).
- Cost/token tracking specific to tailoring (no task registered in `ai_usage_log` for it).
- Failure/retry handling for an *automated* tailoring pipeline (today, a failed skill run is just a failed conversation turn — there's no retry/queue concept).
- Human approval gate as an app-level workflow state (today, the human approval IS the entire skill invocation — there's no separate app-level "approve this output" step because there's no app-level output storage yet).
- Application workflow (submit, track status, follow up) — entirely undesigned, no code, no schema.
- Track-specific resume templates beyond the single Master-Resume-based flow the skill already does (the `ResumeTrack` field is informational only today, per §18).

**The real Phase 3 design question is therefore not "how do we generate a tailored resume" (largely solved) but "how do we connect `job_match_results.decision === 'READY_FOR_TAILORING'` to this now-candidate-aware capability and give its output a home in the app's data model" — a smaller, more integration-focused scope than building tailoring from scratch.**

---

## 26. FUTURE EXTERNAL JOB SOURCES

Apify is **not implemented** — zero code, zero dependency, confirmed via `package.json` inspection this session. The architecture was reviewed for accidental H1B-specific or ATS-specific coupling and found clean: `companies.source_type` is an open string (app-layer validated, not a DB-level enum, explicitly because "the provider list keeps growing"), and `jobs`/`job_match_results`/`candidate_job_state` have no H1B-specific columns baked into their core identity.

**Design requirements for any future external source integration (Apify or otherwise):**
- Feed the **existing** normalization (`NormalizedJob`) → dedupe → upsert pipeline — do not build a parallel ingestion path.
- Discovery provenance (how a company/job was found) and the actual ATS/source type are separate concepts — do not conflate "found via Apify" with `source_type`.
- **Never fabricate an external provider's ID into an ATS-shaped external ID** — this would corrupt dedupe tier 1's guarantee (§10). If a source has no stable ID, it must dedupe at tier 3/4 honestly, not pretend to tier 1.
- When (not yet — this is a future requirement, not built) multi-source merging exists for the same underlying job, official/first-party data (the employer's own ATS) should have greater field authority than a third-party aggregator's copy of the same posting.

---

## 27. EXACT IMPORTANT FILE MAP

```
DATABASE
  src/db/schema.sql                       — base schema, read this first for any table's true shape
  src/db/index.ts                         — connection setup, ALL additive migrations, busy_timeout
  src/db/migrate.ts                       — backup-then-migrate script (fail-closed)
  src/db/queries/*.ts                     — one file per table/domain, the only sanctioned DB access layer

SOURCE DISCOVERY / IDENTITY
  src/lib/companyIdentity/resolveDomain.ts, verifyDomain.ts, wikidataLookup.ts, secLookup.ts,
    domainCandidates.ts, h1bEmployerDomainOverrides.ts (query module)
  src/lib/discovery/batch.ts, priority.ts — bounded batch orchestration

ATS
  src/lib/ats/detect.ts, discovery.ts, discoveryBrowser.ts, discoveryConfig.ts
  src/lib/ats/workday.ts, greenhouse.ts, lever.ts, ashby.ts — the 4 real connectors
  src/lib/ats/genericPlaywright.ts, jobValidation.ts — career_link fallback

NETWORK/SECURITY
  src/lib/net/safeFetch.ts — read this before touching ANY network code in this project

JOB PIPELINE
  src/lib/normalize.ts, src/lib/dedupe.ts, src/lib/scan.ts, src/lib/jobLifecycle.ts
  src/lib/jobIntel/extractJobIntel.ts + types.ts + one file per extracted field

H1B
  src/lib/h1b/normalizeEmployerName.ts, fuzzyMatch.ts, combineSignal.ts, keywordScan.ts, thresholds.ts

PHASE 2 MATCH ENGINE — read the whole directory before changing anything here
  src/lib/match/evaluateJobMatch.ts (orchestrator), types.ts (all shapes), decision.ts, eligibility.ts,
    scoring.ts, requirementUnits.ts, skillMatching.ts, candidateProfile.ts, candidateSettingsHash.ts,
    matchKnowledgeHash.ts, trackRecommendation.ts

RANKING
  src/lib/rank/forYou.ts, roleFamily.ts

CANDIDATE ARCHITECTURE
  src/db/queries/candidates.ts, candidateSettings.ts, candidateJobState.ts
  src/app/api/master-files/route.ts

OBSERVABILITY
  src/db/queries/atsCoverage.ts, discoveryRuns.ts, scanRuns.ts (if present), jobMatches.ts

DOCS
  CAREER_OPS_HANDOFF.md — prior session's detailed narrative handoff (Phase 1/2/2.5 design records,
    §16.1-16.8); this file supersedes it for Phase-3-planning purposes but does not replace its
    deeper design-record prose for Phases 1/2/2.5 — read both.
```

---

## 28. DEVELOPMENT SAFETY RULES

- **The repository and running code are the source of truth** — never trust a prior document's claim without spot-checking it against current code, the way this document itself was written.
- Read before modifying — every subsystem above has non-obvious invariants documented in-code; read the file's own doc comments first.
- Migrations are additive (`ALTER TABLE ADD COLUMN` / `CREATE TABLE IF NOT EXISTS`) unless a destructive change is explicitly approved by the user in that session — this project has never done a destructive migration.
- Every migration takes an automatic backup first (fail-closed) — do not bypass with `CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP` unless the user explicitly authorizes it for a specific, understood reason.
- Tests, lint, and build must all be green before considering any change complete.
- `PRAGMA integrity_check`/`PRAGMA foreign_key_check` must be clean after any schema-touching change.
- Candidate isolation (§14) must be preserved — any new candidate-scoped table/query needs an explicit `candidate_id` filter, no exceptions.
- The H1B scoring boundary (§12) must be preserved — company identity resolution code must never be imported by or feed into `src/lib/match/decision.ts`/`scoring.ts`.
- SSRF protections must never be bypassed or weakened outside test-only code paths (`allowPrivateNetworksForTests`, never production-reachable).
- Live validation stays bounded — no unbounded/full-table batch runs (44k employers) without explicit user approval for that specific run, gated by measured results from smaller runs first.
- No auto-apply, no unattended application submission, ever, without explicit future approval — not even discussed as a near-term feature.
- Do not commit or push unless the user explicitly requests it, separately, each time — a prior approval to commit does not carry forward to a later, different change.

---

## 29. NEXT SESSION STARTING PROCEDURE

For Phase 3 planning specifically:

1. Verify `git status`, `git branch --show-current`, `git rev-parse HEAD`, and compare HEAD against `origin/main` — confirm they match before trusting anything else.
2. Read this document (`CAREER_OPS_MASTER_HANDOFF.md`) in full.
3. Read the actual code for any subsystem the planned work touches — this document is a map, not a substitute for reading the file.
4. Run baseline `npm test`, `npm run lint`, `npm run build` — confirm the numbers still match what's documented in §0/§2 before assuming the baseline is unchanged.
5. Run `PRAGMA integrity_check`/`PRAGMA foreign_key_check` against `data/app.db`.
6. Produce a **Phase 3 implementation PLAN ONLY** — no code, no schema, no migrations — covering at minimum the categories in §25.
7. Wait for explicit user approval of that plan before writing any code.
8. Implement in small, independently-testable, independently-committable stages only after approval — never one large unreviewed diff.

---

## 30. NEW AI SESSION — START HERE

```
Copy/paste this to begin a new session on Career-Ops:

I'm continuing development on Career-Ops, a personal job-search pipeline. Before doing
anything else:

1. Run: git status && git branch --show-current && git rev-parse HEAD
   Compare HEAD against origin/main. Confirm the working tree is clean except possibly
   .claude/settings.local.json (a harness-managed local file — never touch it).

2. Read CAREER_OPS_MASTER_HANDOFF.md in full — it is the authoritative, code-verified
   handoff for this project. CAREER_OPS_HANDOFF.md is an older, more narrative
   supplementary doc — read it too for deeper Phase 1/2/2.5 design-record context, but
   MASTER_HANDOFF.md wins on anything the two disagree on.

3. Run: npm test && npm run lint && npm run build
   Then: sqlite3 data/app.db "PRAGMA integrity_check; PRAGMA foreign_key_check;"
   Confirm these match CAREER_OPS_MASTER_HANDOFF.md §0/§2. If they don't, STOP and
   figure out why before doing anything else — do not build on an unexplained
   discrepancy.

4. Phase 1, Phase 2, H1B source discovery, ATS discovery, and pre-Phase-3 hardening are
   ALL COMPLETE and tested. Do not redesign them without a concrete, evidenced defect —
   see §23 (Frozen Architecture) and §22 (Known Limitations, GREEN/YELLOW/RED) before
   touching anything in those areas.

5. Phase 3 (resume/cover-letter tailoring) is NOT STARTED. See §24 (Phase 3 Input
   Contract) for exactly what data is already available to consume, and §25 (Phase 3 —
   Not Yet Built) for exactly what still needs designing from scratch.

6. If asked to work on Phase 3: produce a PLAN ONLY first. Do not write code, schema,
   or migrations until the plan is explicitly approved.

7. Never: run unbounded H1B batches (44k employers) without explicit approval for that
   specific run; bypass SSRF protections; weaken the H1B-scoring boundary (§12); break
   candidate isolation (§14); commit or push without being explicitly asked to, in this
   session, for this specific change.
```

**CAREER-OPS MASTER HANDOFF COMPLETE — READY FOR NEW AI SESSION.**
