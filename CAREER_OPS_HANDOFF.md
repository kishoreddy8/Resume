# Career-Ops Project Handoff

Written for a fresh coding agent (Claude, Codex, or otherwise) picking up this project with no
memory of prior sessions. Read this fully, then verify its claims against the actual repository —
this document is a map, not a substitute for reading the code.

---

## 1. Project Purpose

Career-Ops is a personal, local-only job-search pipeline. It scans company ATS boards
(Greenhouse/Ashby/Lever/Workday) and plain career-page links, tracks postings through a triage
pipeline, flags likely H1B sponsors from historical DOL data plus JD language, extracts structured
job intelligence (seniority, comp, location, skills, etc.) deterministically, and hands off resume
tailoring to a Claude Code skill. It is intended to grow into a fuller personal job-search assistant
(profile matching, prioritization) without ever becoming dependent on an external service, and
without AI ever becoming authoritative over the data that already works deterministically today.

No hosting, no external database (SQLite via better-sqlite3), no LLM API key required for the app
to function at all.

## 2. Current Status

**Phase 1 (deterministic pipeline) is complete, committed, and frozen.** Shared AI infrastructure,
the first optional AI feature ("Enrich with AI"), and Phase 2 (deterministic job matching/scoring)
are also complete and committed. **Phase 2.5 (multi-candidate architecture + For You ranking + ATS
discovery + generic-job validation) is now complete** — see §16 for the full Phase 2/2.5 design
record (deterministic match engine, multi-candidate architecture, For You, candidate preferences,
safeFetch, bounded ATS discovery, positive-evidence job validation, unsupported-source registry,
freshness, inline actions) and the "Current Safe Checkpoint" section at the end of this document for
the exact checkpoint. `CAREER_OPS_PHASE_2_5_CHECKPOINT.md` is now a closed, historical mid-phase
snapshot — this document is authoritative again.

Commit history (newest first) that matters for understanding how we got here:
```
c564291 feat: add optional AI job enrichment with OpenAI
51dd5e7 feat: add shared AI infrastructure
34e693a fix: stabilize workday identity on detail fetch failure
3ad04b5 feat: add configurable career ops settings
dc4639a feat: add scanner reliability and observability
445c81f feat: harden job deduplication and repost detection
9ab2a47 feat: add structured job intelligence
109b291 feat: add production H1B sponsor intelligence
4a2513a Refine Job Lifecycle Management to the final age-based policy
f53c3d2 Add Job Lifecycle Management: close/archive tracking, history, restore
33b033a Production-harden the resume-tailoring engine
a5bc598 Add universal ATS detection with Workday as the first new connector
03ea88f Capture structured job description data from ATS providers
```

## 3. Phase 1 Architecture

- **Company/career URL intake** — `src/app/companies/`, `src/app/api/companies/`. A company is
  added either as an ATS board (source_type + ats_board_token) or a plain career-page URL
  (`career_link`).
- **ATS detection** — `src/lib/ats/detect.ts`. Two tiers: (1) cheap URL-pattern matching against
  known ATS domains, no network; (2) for a custom domain, follow redirects / scan HTML for an
  embedded ATS link.
- **Connectors** — `src/lib/ats/{greenhouse,ashby,lever,workday}.ts` each fetch that provider's
  public JSON API (no auth, no scraping). `genericPlaywright.ts` is the best-effort fallback for
  plain career-page links — link/title only, no descriptions, never authoritative for lifecycle
  purposes, and can suggest "this is actually an embedded ATS board" for upgrade.
- **Normalization** — `src/lib/normalize.ts` dispatches by `source_type` to the right fetcher,
  returns a common `NormalizedJob` shape.
- **Job identity/dedupe hierarchy** — `src/lib/dedupe.ts`. Tier 1: provider + external job ID
  (authoritative, never falls back even if title/description changed — that's just a refresh).
  Tier 2: canonical job URL (tracking params stripped, unrelated params kept since they may be
  identity-bearing). Tier 3: company + normalized title + location + reliable date. Tier 4:
  conservative content fingerprint. A different external ID is always a new requisition.
- **Repost handling** — governed entirely by the dedupe hierarchy: the same dedupe_key reappearing
  reopens/restores the existing row rather than creating a duplicate.
- **Suppression** — `suppressed_jobs` table, keyed on dedupe_key fingerprint. Two policies (see §4).
- **Lifecycle** — `src/lib/jobLifecycle.ts`. Age-based (Fresh/Active/Archived/Deleted bands from
  `posted_at`, else `first_seen_at`, **never** `last_seen_at`), with Applied/Interviewing/Offer/
  Employer Rejected/pinned as permanent protection from auto-archive/auto-delete.
- **H1B Sponsor Intelligence** — `src/lib/h1b/*`: `normalizeEmployerName`, layered `fuzzyMatch`
  (exact/alias/fuzzy tiers against imported DOL LCA data), `keywordScan` (regex-based JD sponsorship
  language), `combineSignal` (JD language always overrides company history when present).
- **Structured Job Intelligence** — `src/lib/jobIntel/*`: ~13 deterministic, regex/keyword-based
  extractors (seniority, employment type, workplace type, location, experience, education,
  compensation, clearance, domain, skills, certifications, quality flags, sections). Every field is
  nullable/"Unknown" by design — never fabricated. Versioned via `structured_extraction_version`.
- **Scanner reliability/observability** — `src/lib/scan/{errors,retry,health,status}.ts`: categorized
  error taxonomy, bounded retry+backoff, connector health rollup, per-scan `scan_runs` rows.
- **Settings** — `src/lib/settings.ts` + `src/db/queries/settings.ts`: zod-validated, three groups
  (lifecycle/suppression/scanner), key-value `settings` table, empty table = documented defaults.
- **UI/API architecture** — Next.js App Router. `src/app/api/**` route handlers are thin, delegate
  to `src/db/queries/*.ts`; one file per sub-action for jobs (`archive`, `restore`, `history`,
  `not-interested`, `ai-enrich`). `src/app/**` pages are mostly client components composed of many
  small named sub-components per page (see `src/app/jobs/[id]/page.tsx`).

## 4. Important Business Rules

- **Lifecycle thresholds**: Fresh 0–3 days, Active 4–7, Archived 8–10 (unapplied+unpinned only),
  Deleted >10 days (unapplied+unpinned only) — all configurable via Settings, defaults match these.
  **Protected statuses** (Applied, Interviewing, Offer, Employer Rejected) plus manual `pinned` are
  **never** auto-archived or auto-deleted, regardless of age or scan results. Enforced in exactly one
  place (`isLifecycleProtected`) and checked at every call site.
- **"Not Interested" is permanent, exact-requisition suppression** — never expires, unaffected by
  Settings, keyed on the exact `dedupe_key`. System-generated (age-sweep) suppression is the only
  kind that's time-bounded/configurable.
- **A different external ID is always a new requisition** — never merged with a prior one, even for
  the same company/title.
- **Failed or partial scans can never perform destructive lifecycle actions** (close/archive) — only
  a fully successful scan of an authoritative ATS board may act on "this posting disappeared."
  `career_link` scrapes are never authoritative for this either way.
- **Job identity must remain deterministic** — this is a hard constraint that also applies to the AI
  layer: AI must never compute, change, or influence `dedupe_key`.
- **H1B**: explicit JD wording always overrides company historical evidence when present (negative
  JD language → "Not Sponsoring" regardless of company history; positive JD language → "Very High").
  No JD language → falls back to company's historical DOL-derived confidence untouched.
- **Evidence/provenance requirements**: every deterministic extraction that isn't a bare boolean
  carries an `*_evidence` snippet column. Nothing is asserted without a traceable source.

## 5. Database

SQLite (`better-sqlite3`), file at `data/app.db` (gitignored — real personal data, never commit).
Migrations are additive (`ALTER TABLE ADD COLUMN` / new `CREATE TABLE IF NOT EXISTS`), applied
automatically by `src/db/index.ts`'s `getDb()`/`createConnection()`; three historical CHECK-
constraint-removal migrations exist for tables that pre-date the "no CHECK, app-layer zod
validated" convention now used everywhere.

**Authoritative**: `companies`, `jobs` (identity: `dedupe_key`, unique), `h1b_sponsor_filings` (raw
DOL source of truth), `h1b_sponsors` (recomputed rollup), `settings`.

**History/audit (append-only or near-append-only)**: `job_status_history` (every pipeline/lifecycle
change, cascade-deletes with its job), `scan_runs` (one row per scan attempt), `ai_usage_log`,
`ai_audit_log`.

**Cache/derived**: `suppressed_jobs` (fingerprint surviving a job's deletion), `job_skills`/
`job_certifications` (multi-row per job, delete+reinsert on re-extraction), `h1b_employer_aliases`
(curated, never auto-seeded), `ai_enrichments` (immutable cache — see §6).

Don't dump the full `schema.sql` here — read it directly; it's well-commented (~390 lines) and each
table's comment explains its own reasoning.

## 6. Shared AI Infrastructure

Lives entirely under `src/lib/ai/` + `src/db/queries/ai{Enrichments,Usage,Audit}.ts` +
`ai_enrichments`/`ai_usage_log`/`ai_audit_log`. Built to be reused by every future AI feature — not
just the OpenAI enrichment feature described in §7.

- **Provider abstraction** (`provider.ts`): `AiProvider` interface (`name`, `describeModel(tier)`,
  `generate(req)`). Feature code never imports a vendor SDK directly. `NullAiProvider` is the
  always-unavailable default. Real adapters self-register only after confirming their own
  credentials, via an explicit manifest (`providers/index.ts`) imported once by `runAiTask.ts` — not
  an incidental side-effect import anywhere else.
- **`runAiTask(taskId, entity, input)`** (`runAiTask.ts`) — the single entry point every AI feature
  must go through. **Never throws.** Every failure mode (disabled, missing credentials, budget
  exceeded, timeout, provider error, malformed output) returns `{status:"unavailable", reason}`.
  Flow: registry lookup → resolve provider/model → cache lookup (by `entity.key`, never
  `entity.id`) → budget check → provider call with bounded retry → Zod schema validation (one
  repair retry on failure) → immutable persistence + usage/audit logging → typed result including
  `enrichmentId`.
- **Task/provider registries** (`tasks/index.ts`, `providers/index.ts`) — explicit manifests, each
  imported once by `runAiTask.ts`. Adding a task or a vendor adapter means adding one import line to
  the relevant manifest — never relying on some route "happening to" import it first.
- **Immutable `ai_enrichments`** — once a row exists for an exact
  `(entity_type, entity_key, task, task_version, content_hash, provider, model_id)` key, it is
  **never updated**. A repeat call with the identical key is always a cache hit. `status`
  (`active`/`superseded`/`expired`) is metadata-only bookkeeping, never touches the row's content.
- **`entity_key` identity safety** — `entity_id` (a plain SQLite `INTEGER PRIMARY KEY` with no
  `AUTOINCREMENT`) can be reused by an unrelated row after deletion. `entity_key` is a stable
  identity **snapshot the calling feature supplies** (for a job: `jobs.dedupe_key`, verbatim, never
  recomputed by the AI layer) and is the *only* thing used for cache lookup/uniqueness. `entity_id`
  is kept purely as write-time convenience metadata, never for correctness.
- **`ai_usage_log`** — append-only, one row per orchestration attempt (including cache hits at
  exactly zero cost, and pre-call short-circuits at null cost). A schema-validation failure still
  logs its real token cost — the call happened and cost money even though the output was unusable.
- **`ai_audit_log`** — append-only suggestion lifecycle trail (`generated`/`shown`/`accepted`/
  `rejected`/`superseded`/`expired`), FK to `ai_enrichments` with **no cascade delete** (SQLite
  default NO ACTION) — an audit trail must survive its subject; nothing in this codebase currently
  deletes an `ai_enrichments` row at all.
- **Caching** — cache-key projection (`toCacheKeyInput`) and provider-sendable projection
  (`toProviderInput`) are two independent functions per task, deliberately decoupled: something can
  be sent to the provider without affecting the cache key, or vice versa.
- **Confidence** (`confidence.ts`) — generic `AiConfidence {value, band}`, deliberately named apart
  from the unrelated `H1bCompanyConfidence`/`H1bJobConfidence` enums. Per-suggestion confidence for
  a multi-field task lives inside that task's own `output_json`, not the row-level scalar column
  (which stays null when a task has no single meaningful score).
- **Privacy boundaries** — a task's input type is a narrow, purpose-built shape, never a full DB
  row. `toProviderInput` is the sole privacy boundary; `buildPrompt` only ever sees its output.
- **Retry/error behavior** (`retry.ts`, `errors.ts`) — a separate implementation from the ATS
  scanner's own retry module on purpose. Bounded backoff for transient categories; a malformed
  schema response gets exactly one "repair" re-prompt, never a blind backoff retry.
- **Budget behavior** (`budget.ts`) — three independent limit types: exact session call-count;
  daily/monthly dollar caps enforced via a conservative pre-call per-tier cost *reservation* (real
  cost is only known post-call); token limits not yet enforced (deferred). Pricing constants are
  hardcoded, documented with source + verification date, explicitly operational config that may
  change.
- **Credentials/environment rules** — `CAREER_OPS_AI_ENABLED`, `CAREER_OPS_AI_PROVIDER`,
  `OPENAI_API_KEY` (or any future vendor key) live in **environment variables only**, never SQLite,
  never logged. Default is fully disabled. See `.env.example`.

## 7. OpenAI "Enrich with AI"

The first (and only) real AI feature built on top of §6. **Optional, disabled unless explicitly
configured** — set all three of `CAREER_OPS_AI_ENABLED=true`, `CAREER_OPS_AI_PROVIDER=openai`,
`OPENAI_API_KEY=<real key>` to enable it; omitting any one leaves it fully off.

- Model tier mapping: `lightweight → gpt-5.6-luna`, `standard → gpt-5.6-terra` (the enrichment task
  uses `standard`). Sol intentionally excluded from v1.
- **No AI call during normal scans** — nothing in `src/lib/scan.ts` or the scan API routes
  references `runAiTask` or anything under `src/lib/ai/`.
- **No AI call merely from loading Job Details** — the `GET /api/jobs/[id]` route has zero AI
  references; `AiInsightsCard.tsx` has no `useEffect`, only `onClick`-triggered fetches.
- **Only user-triggered**: `POST /api/jobs/[id]/ai-enrich`, fired exclusively by the "Enrich with
  AI" button.
- **Cache behavior**: cache-key projection is the full, untruncated `job.description_text` (plus
  title) — never the bounded/section-prioritized text actually sent to the model. A JD edit
  anywhere (even in a section excluded from what's sent) invalidates the cache; a change in
  already-known deterministic fields does not.
- **Evidence grounding**: every AI suggestion must include a verbatim excerpt, checked (at read
  time, against the full authoritative `description_text`, normalized for whitespace/quote/dash
  variants but not fuzzy-matched) before being shown — ungrounded suggestions are hidden, not
  deleted from storage.
- **Per-field accept/reject audit**: `PATCH /api/jobs/[id]/ai-enrich` records one `ai_audit_log`
  event per field decision (field name carried in the existing `note` column, no schema change).
  The submitted `enrichmentId` is verified to belong to the requesting job before any event is
  recorded (ownership check against `entity_key`).
- **No authoritative job mutation** — this route has no write path into the `jobs` table at all.
  Acceptance is audit-only; nothing is promoted into `jobs.*`/jobIntel columns.
- **Current status**: implemented and committed (`c564291`), fully covered by automated tests using
  a stubbed OpenAI client (no real network calls in the test suite), but can remain disabled
  indefinitely with zero effect on the rest of the app.

## 8. Resume Tailoring

**Resume tailoring remains entirely outside the app**, handled through the existing Claude Code
skill/workflow at `.claude/skills/tailor-resume/`. This is a deliberate architectural boundary, not
an oversight — do not casually move it into the OpenAI API or the in-app AI layer.

- Invoked as `/tailor-resume job=<job-id>` inside a Claude Code session in this project directory.
- **Deterministic rendering/validation boundary**: the skill's own reasoning (fact/evidence model,
  JD analysis, scoring/selection) hands off to a separate, deterministic engine
  (`engine/resume-template.ts`, `engine/generate.ts`, `engine/validate-docx.ts`) that "never decides
  what claims to make" — it only lays out the structured content it's given.
- **Factual-source hierarchy** (see `SKILL.md`): Master Resume > Master Skills Inventory > Resume
  Track (not yet separate) > full JD (`description_text`, never a title/snippet) > the skill's own
  guardrail instructions > previously generated resumes (style reference only, never factual).
- **Safety constraints**: never infer or invent years of experience, employer-specific tech usage
  beyond what the Master Resume states, leadership scope, team size, monetary impact, certifications,
  relocation willingness, visa/sponsorship status, clearance, or production usage of a tool not
  documented. Unknown is preferable to fabrication.
- The app itself **never calls an LLM** for this — this is the existing, deliberate design already
  proven to work well, and it's the template the whole shared-AI-infrastructure philosophy
  ("AI is advisory, deterministic data wins") was modeled after.
- **Do not** move this into the in-app OpenAI layer without an explicit, separate decision — the
  Claude subscription/Claude Code workflow is intentionally retained for tailoring for now.

## 9. Frozen / Do-Not-Break Components

- `src/lib/dedupe.ts` — job identity hierarchy. AI must never compute or influence `dedupe_key`.
- `src/lib/jobLifecycle.ts` — `isLifecycleProtected` and the age-band policy. No AI role, ever, not
  even advisory.
- `src/lib/h1b/combineSignal.ts` — the final authoritative confidence combination logic.
- `src/lib/scan.ts` and `src/lib/scan/*` — the scan pipeline and its safety rule (failed/partial
  scans never close/archive).
- `src/lib/jobIntel/*` — every deterministic extractor; the AI enrichment feature reads their output
  but never writes to their columns.
- `src/lib/ai/runAiTask.ts`'s "never throws" contract, and the entity_key-not-entity_id identity
  rule in `cache.ts`/`db/queries/aiEnrichments.ts`.
- `.claude/skills/tailor-resume/engine/*` — the deterministic DOCX rendering/validation boundary.
- The `ai_enrichments` immutability guarantee — never add an UPDATE path onto that table's content
  columns.
- `src/lib/match/**` (Phase 2 scoring/eligibility/track recommendation) and `src/lib/rank/forYou.ts`
  (the approved 10-key ranking order) — see §16.1/§16.3. Neither's core logic was touched by the
  Phase 2.5 work; only new callers were added around them.
- `src/lib/net/safeFetch.ts`'s SSRF checks and `src/lib/ats/discoveryConfig.ts`'s bounded constants
  (§16.4) — any future discovery-related change must go through `safeFetch`/`isUrlSafeForNavigation`,
  never a raw `fetch()` or unchecked `page.goto()`. **This was violated by `genericPlaywright.ts`
  until the pre-Phase-3 hardening pass (§16.8) fixed it** — the production career_link scraper ran an
  unchecked headless browser against `company.career_page_url` with no SSRF guard, unlike the Tier-3
  discovery browser (`discoveryBrowser.ts`), which always had one. Confirm any NEW Playwright/browser
  code path also gets the same `isUrlSafeForNavigation` seed-check + `page.route` gate before assuming
  this rule is automatically inherited.

## 10. Known Limitations

- No real end-to-end test against OpenAI's live API exists (by design — tests use a stubbed client,
  no real network calls). Real-world behavior of the Responses API's strict-schema enforcement for
  the discriminated-union suggestion shape has not been verified against a live account.
- AI budget/pricing constants are hardcoded, not Settings-configurable (deliberate, documented
  reasoning in `budget.ts` — the fixed-group Settings schema doesn't fit an open-ended per-task
  concern well; revisit only if a real UI need appears).
- `job_quality_flags`, education-level AI fallback, and employment-type AI fallback were explicitly
  scoped out of the first AI feature as lower-value/higher-risk — not implemented at all.
- Company-scoped AI tasks (e.g. H1B alias suggestion) have no concrete `entity_key` construction
  helper yet — the convention is documented in `types.ts`'s `AiEntityRef` comment but not exercised
  by any real task.
- `data/app.db` in this environment already contains real personal job-search data — treat it as
  sensitive, never inspect/paste its contents into a shared context carelessly.

## 11. Testing / Safety Procedures

```bash
npm test          # node:test, 687 tests, isolated temp SQLite per suite (never touches data/app.db)
npm run lint       # eslint, must be clean
npm run build      # next build — this is also the real TypeScript check; npm test alone does not type-check as strictly
npx tsx .claude/skills/tailor-resume/engine/fixtures/run-fixtures.ts   # resume-engine regression fixtures
```

Test globs live in `package.json`'s `test` script as an explicit list of `__tests__` directories —
**every new `__tests__` directory must be added to that list explicitly**, or `npm test` silently
skips it (a real issue flagged and checked during the Phase 2.5 work). `src/lib/net/__tests__` and
`src/lib/ats/__tests__` were added in an earlier session; `src/app/api/companies/__tests__` and
`src/app/api/ats-coverage/__tests__` were added in the pre-Phase-3 hardening pass (§16.8) — the
first time this project tested a Next.js route handler directly (construct a plain `Request` +
`{params: Promise.resolve({...})}`, no server needed; see either file for the pattern).

**DB migration safety procedure** (only needed if a change touches `schema.sql`/`db/index.ts`):
1. `npm run migrate` now takes this backup **automatically** (`src/db/migrate.ts`, added in the
   pre-Phase-3 hardening pass, §16.8) — `data/app.db`(+`-wal`/`-shm`) to `data/backups/` using the
   same `app.db.pre-migration-<timestamp>.bak` naming convention the earlier manual snapshots already
   used, fail-open (a backup failure warns loudly but never blocks the migration). No separate manual
   step needed for this part anymore.
2. Still copy to a throwaway location first for anything non-trivial: run
   `CAREER_OPS_DB_PATH=<copy> npm run migrate`, verify table/row counts unchanged,
   `PRAGMA integrity_check`, `PRAGMA foreign_keys=ON; PRAGMA foreign_key_check`.
3. Only then run `npm run migrate` against the real `data/app.db`, and re-verify the same checks.
4. **Restore procedure** (if ever actually needed): copy the relevant `data/backups/app.db*.pre-*.bak`
   files to a throwaway path (never overwrite the live `data/app.db` directly), rename off the
   `.pre-...bak` suffix, then `sqlite3 <path> "PRAGMA integrity_check; PRAGMA foreign_key_check;"` and
   spot-check row counts before trusting it — verified end-to-end during the hardening pass (§16.8).
   Only copy the verified file over the live `data/app.db` once you're confident, and stop the app
   first (or accept losing anything written since the backup).

Most recent AI-infra changes needed **no** schema change at all — check whether a new feature
genuinely needs one before assuming this procedure applies.

## 12. Git / Development Practices

- Stable features are committed before starting the next — this project's history is a sequence of
  complete, working, tested commits, not WIP snapshots.
- **Never commit**: `.claude/settings.local.json` (local permission state), any real `.env*` file
  (only `.env.example`, placeholders only, is tracked — `.gitignore` has an explicit
  `!.env.example` exception), `data/` (gitignored wholesale — DB files, backups, generated resumes,
  H1B datasets), any API key/secret.
- Review `git diff --stat` / `git status --porcelain` before every commit — stage explicit paths,
  never `git add -A`/`git add .` blindly, to avoid sweeping up the settings file or a stray local
  artifact.
- Full verification (tests + lint + build + resume fixtures + DB integrity where relevant) before
  every commit in this project's practice so far — keep doing that.

## 13. Current Roadmap

**Phase 2 (deterministic job matching) and Phase 2.5 (multi-candidate + For You + ATS discovery) are
both complete** — see §16 for the full design record. Nothing in Phase 3 has been started.

**Next major phase: Phase 3 — Automatic resume/cover-letter generation**, and separately, at a much
larger scale whenever it's explicitly prioritized: the 44k+ H1B-employer discovery expansion (company
name → verified domain → careers page → ATS → job ingestion), reusing the bounded discovery
architecture from §16 rather than redesigning it. Neither has been designed or started. Do not begin
either without an explicit decision — this is a placeholder pointer, not a spec.

**Phase 3 entry contract** (defined during the pre-Phase-3 hardening pass, §16.8 — not implemented,
just the stable shape Phase 3 should consume so it never recomputes Phase 1/2 truth or scrapes UI
state):

```
{
  candidate_id, dedupe_key, job_id,
  job:                { title, company, url, descriptionText, postedAt, location },
  job_intelligence:    { skills, certifications, requirementUnits, sponsorshipSnippet },
  job_match_result:   { decision, overall_score, requirement_coverage, employer_evidenced_share,
                         recommended_track, blocking_reasons, match_engine_version, candidate_profile_hash },
  candidate_profile:  { path to candidate-profile.json, sourceHashes },
  master_files:       { resume path, skills path, manifest hashes },
  candidate_settings: { relevant ranking/match-affecting fields },
  readiness:          "READY_FOR_TAILORING" | "NOT_READY" | "MANUAL_OVERRIDE"
}
```

This is already ~90% satisfiable today by existing tables/functions (`job_match_results`, the
`jobIntel` queries, `candidateProfile.ts`, the `master-files` manifest) — Phase 3 needs one read-
composition function assembling this shape, not new storage. `READY_FOR_TAILORING` =
`job_match_results.decision === 'READY_FOR_TAILORING'` for the current non-superseded cache row.
`MANUAL_OVERRIDE` is a named extension point only — no override column exists yet
(`candidate_job_state.tailoring_override` would be the natural place if Phase 3 ever needs one); do
not add it speculatively before Phase 3 actually asks for it.

Known deferred items within Phase 2.5's own scope (not blocking, documented so they aren't rediscovered
as "missing"):
- NEEDS_ADAPTER only recognizes a small, explicit list of other ATS platforms (SmartRecruiters,
  iCIMS, Taleo, SuccessFactors, Jobvite, Workable, BambooHR, Breezy HR, Recruitee) — a real-world
  platform outside that list still resolves UNRESOLVED, not NEEDS_ADAPTER, which is honest (no
  fabricated signature) but not exhaustive.
- ATS discovery (`src/lib/ats/discovery.ts`) uses safeFetch — a bounded, non-JS-executing HTTP
  fetch — not Playwright. A homepage/careers page whose careers link only appears after client-side
  JS rendering (no server-rendered `<a href>` in the initial HTML) is invisible to discovery, even
  though the final generic scrape step (`genericPlaywright.ts`) does run a real browser. This is a
  deliberate tradeoff (discovery must stay fast/cheap/bounded; full JS rendering at every hop would
  defeat that) — live-validated against 9 real external sites in this session, all of which resolved
  sensibly within this constraint.
- The Companies page's global "Candidate Eligibility" settings group (`src/app/settings/page.tsx`,
  backed by the legacy single-row `settings.candidate` group) is no longer read by the Phase 2 match
  engine — `evaluateJobMatch`/the batch match route read `candidate_settings` (per-candidate) via
  `getMatchAffectingSettings` instead. That legacy Settings UI section is effectively vestigial for
  matching purposes now; the per-candidate Preferences page (`/candidates/[candidateId]/settings`,
  added this session) is the real place to set eligibility going forward. Not removed in this session
  — flagged here rather than silently left for a future agent to rediscover.

## 14. Claude vs. Codex Handoff Notes

Whichever agent picks this up next should, in order:
1. Read this file in full.
2. Read `AGENTS.md` (and the `node_modules/next/dist/docs/` reference it points to — this project
   pins a Next.js version with breaking changes from what most training data assumes).
3. Run `git log --oneline -20` and skim the actual diffs for the most recent 2-3 commits, not just
   their messages.
4. Read the actual current code for whatever area you're about to touch — this document is a map,
   not a source of truth. If something here conflicts with what the code actually does, trust the
   code and flag the discrepancy.
5. Do not rewrite or "clean up" working Phase 1 systems unless the user explicitly asks — every
   module listed in §9 works, is tested, and has non-obvious reasoning behind its current shape
   (see §15).

## 15. Key Architecture Decisions and Why

- **Deterministic-first design**: every fact the app asserts (job identity, lifecycle state, H1B
  confidence, structured intel fields) is computed by explicit, auditable, evidence-carrying rules
  before AI ever enters the picture. This was true of Phase 1 long before any AI work started, and
  the AI layer was deliberately built to extend that pattern, not replace it.
- **AI as an optional advisory side-channel**: `runAiTask` never has write access to any
  authoritative table. Every AI output lives in `ai_enrichments`/`ai_usage_log`/`ai_audit_log`,
  clearly namespaced and labeled, never silently blended with deterministic data in the UI.
- **`entity_key` instead of `entity_id`**: caught during design review — SQLite's non-AUTOINCREMENT
  integer primary keys can be reused after a row is deleted, which would let a stale cached AI
  result silently attach itself to an unrelated future entity that happens to reuse the same numeric
  id. `entity_key` is a stable snapshot of Phase 1's own already-authoritative identity
  (`dedupe_key` for jobs), copied verbatim, never computed by the AI layer.
- **Immutable AI results**: once generated for an exact key, a result is never overwritten — this
  makes the cache trustworthy as a historical record, not just a performance optimization, and
  removes an entire class of "which write won the race" bugs.
- **Audit retention (no cascade delete)**: an audit trail that could be silently destroyed by
  deleting the thing it documents isn't really an audit trail. `ai_audit_log`'s FK has no cascade on
  purpose, even though nothing currently deletes `ai_enrichments` rows — this is a guarantee against
  a *future* mistake, not a currently-exercised code path.
- **Full JD for cache identity, bounded/section-prioritized text for the provider**: these were
  originally conflated in an early design pass and corrected — cache correctness needs the complete
  source text (any change anywhere must invalidate), while cost control needs a bounded prompt. The
  two concerns are independent and are handled by two separate, independently-testable functions per
  AI task.
- **Human review for AI suggestions**: every suggestion carries its own confidence and grounded
  evidence, and acceptance is an audit event only — never a silent promotion into an authoritative
  column. This was an explicit, repeated design constraint throughout the AI feature's build, not an
  afterthought.
- **Resume-tailoring boundary**: kept outside the app, in Claude Code, deliberately — it already
  works well, has its own deterministic rendering/validation boundary, and collapsing it into the
  in-app AI layer would be a regression in reasoning quality and guardrail enforcement, not an
  improvement.
- **Why AI does not control lifecycle/dedupe/H1B authority**: these are the highest-consequence,
  most foundational facts in the system (what a job even *is*, whether it's still open, whether it's
  worth pursuing for sponsorship reasons). Getting any of them wrong silently would corrupt the
  entire pipeline's trustworthiness. AI's value-add is real but is in summarization/inference over
  ambiguous language — not in being trusted with facts that already have a reliable deterministic
  source.

## 16. Phase 2 / Phase 2.5 Design Record

### 16.1 Phase 2 — Deterministic Job Matching (complete, frozen)

`src/lib/match/**` scores a candidate against a job's structured JD content: requirement-unit
extraction, candidate evidence tiers (employer-attributed vs. inventory-only vs. transferable),
OR-group collapsing, seniority alignment, critical-gap gating, employer-evidenced-share gating, and a
weighted `overallScore`/`decision` (`READY_FOR_TAILORING` / `NEEDS_REVIEW` / `BLOCKED`). Eligibility
(`src/lib/match/eligibility.ts`) is a separate hard-blocker pass (sponsorship/citizenship/clearance).
Every `job_match_results` row is an immutable snapshot keyed on
`(candidate_id, dedupe_key, match_engine_version, match_knowledge_hash, candidate_profile_hash,
candidate_settings_hash, jd_content_hash)` — an exact-key cache hit, never recomputed or overwritten.
**None of this was touched in this session** — see §9's frozen list, now extended to cover every
Phase 2 module too (scoring weights, requirement matching, eligibility, track recommendation).

### 16.2 Phase 2.5 — Multi-Candidate Architecture (complete)

- **`candidates`** (`INTEGER PRIMARY KEY AUTOINCREMENT` — ids never reused, safe to thread through
  file paths), **`candidate_settings`** (one row per candidate, split at the TYPE level into
  `MatchAffectingCandidateSettings` — feeds `evaluateEligibility`/`computeCandidateSettingsHash` — and
  `CandidateRankingPreferences` — feeds only the For You ranking layer, never the match cache hash),
  **`candidate_job_state`** (one candidate's personal relationship to one shared job — pipeline
  status, pinned, not_interested, notes, tags — keyed on `(candidate_id, dedupe_key)`, not `job_id`),
  **`candidate_job_state_history`**.
- Legacy `jobs.pipeline_status`/`pinned`/`notes`/`tags`/`marked_for_tailoring` columns are frozen,
  read-only snapshots of Candidate #1's state at the original migration — nothing writes to them
  anymore. `listJobs`/`getJob` take an optional `candidateId` that LEFT JOINs `candidate_job_state`
  and overlays it onto each row; omitted = byte-identical pre-Phase-2.5 behavior.
- **"Not Interested" is candidate-personal and reversible** (`candidate_job_state.not_interested`,
  toggled via `POST /api/jobs/[id]/not-interested`) — completely separate from the global,
  permanent, delete-based `markNotInterested`/`suppressed_jobs` mechanism the system-generated
  age-sweep still uses. Marking a job Not Interested for one candidate never removes it from another
  candidate's Jobs list, and never touches the shared `jobs` row.
- **Cross-candidate lifecycle protection**: `isLifecycleProtected`/`canArchive`/`canDelete`
  (`src/lib/jobLifecycle.ts`) are unchanged; their call sites now read protection status via
  `isProtectedForAnyCandidate(dedupeKey)` (`src/db/queries/candidateJobState.ts`) — a job is
  protected from the global auto-archive/auto-delete sweep if **any** candidate has it
  Applied/Interviewing/Offer/Employer Rejected/pinned.
- **Candidate-scoped master files/profile**: `src/lib/match/candidateProfile.ts` takes an explicit
  `candidateId` everywhere, no implicit "current candidate." `data/candidates/<id>/master/**` +
  `data/candidates/<id>/candidate-profile.json`, isolated per candidate, proven by an automated
  multi-candidate fixture this session (see §16.5).

### 16.3 For You Ranking (wired this session)

`src/lib/rank/forYou.ts`'s `rankForYou` (built and unit-tested in the prior session, never wired
until now) implements the approved 10-key sort order: valid/not-interested gate → role-family tier →
decision rank → score band → sponsorship tier → exact score → employer-evidenced share → requirement
coverage → freshness tier → posted_at → id. **Untouched in this session** — every consumer feeds it
already-computed facts.

- **`GET /api/candidates/[candidateId]/for-you`** (`src/app/api/candidates/[candidateId]/for-you/route.ts`,
  new): gathers each active job's latest match summary (`listLatestDecisionsForDedupeKeys`, extended
  additively with `employerEvidencedShare`/`requirementCoverage`), candidate_job_state
  (`not_interested`), and a per-job `roleFamilyTier` (new — `src/lib/rank/roleFamily.ts`, deterministic
  keyword-containment match between the candidate's `primaryTargetRole`/`secondaryTargetRoles` and the
  job title; ranking-only, never touches score/eligibility), then calls `rankForYou` and returns the
  ranked list. A job never evaluated for this candidate is passed through with `match: undefined` —
  `rankForYou` treats that as `NOT_EVALUATED`, never a fabricated score.
- **Jobs page** (`src/app/jobs/page.tsx`) now defaults to a **For You** / **All Jobs** toggle. For You
  (`ForYouList.tsx`, new) is the personalized, ranked view; All Jobs (existing `JobList.tsx` +
  `JobFilterSidebar.tsx`, untouched) remains the full, unranked, search/filterable global inventory —
  neither view was removed or degraded.
- **Candidate Preferences page** (`/candidates/[candidateId]/settings`, new —
  `src/app/candidates/[candidateId]/settings/page.tsx` + `src/app/api/candidates/[candidateId]/settings/route.ts`):
  the UI `candidateSettings.ts` was missing. Splits Ranking Preferences (target roles, location,
  workplace, employment type) from Eligibility (sponsorship/citizenship/clearance) — mirrors the
  underlying type boundary exactly, PATCH body carries them as two separate optional objects so a
  ranking-only change can never accidentally land in the match-affecting bucket.

### 16.4 ATS Discovery (built this session — was entirely missing)

Root cause (confirmed against code, not assumed): `src/lib/ats/detect.ts`'s old `detectAtsFromUrl`
made one raw, unbounded `fetch()` with `redirect: "follow"` — no SSRF protection, no response size
cap, no revalidation of where a redirect actually landed, and it only ever inspected the ONE page it
was given. A branded site whose ATS is hidden two hops away (homepage → careers → "Search Jobs" →
ATS) was invisible to it. That function has been **removed** (dead, unsafe, unused after this
session's changes — see `src/lib/ats/detect.ts`'s doc comment); `detectAtsFromUrlString` (the
zero-network Tier-1 pattern matcher) is unchanged and is what the new discovery chain reuses.

- **`src/lib/net/safeFetch.ts`** (new): SSRF-safe fetch. Blocks non-http(s) schemes; blocks
  localhost/loopback/private/link-local/reserved IP ranges, including a hostname that *resolves* to
  one (DNS-rebinding protection via `dns.promises.lookup`, checking every returned address); follows
  redirects manually, revalidating each hop with the exact same checks (a redirect to a disallowed
  scheme/host is rejected mid-chain, not just at the start); detects redirect loops; caps response
  bytes (checks `Content-Length` first, then enforces the cap while streaming even without one);
  enforces one overall wall-clock timeout covering the whole operation. 18 tests against a real local
  HTTP server (`src/lib/net/__tests__/safeFetch.test.ts`) — never the live internet.
- **`src/lib/ats/discoveryConfig.ts`** (new): the approved bounded constants —
  `MAX_DISCOVERY_PAGES=3`, `MAX_DISCOVERY_DEPTH=2`, `MAX_REDIRECTS=5`,
  `MAX_RESPONSE_BYTES=2_000_000`, `DISCOVERY_TIMEOUT_MS=10_000`. Every discovery call site references
  these named constants, never a duplicated magic number.
- **`src/lib/ats/discovery.ts`**'s `discoverCompanySource(url)` (new): the bounded chain. Tier 1
  (`detectAtsFromUrlString`, no network) → fetch via safeFetch → check final URL after redirects →
  scan the whole HTML for an embedded ATS URL (reuses `detectAtsFromUrlString` against every
  `https?://...` token found, never a duplicated provider regex) → if nothing found and budget
  remains, follow the highest-scoring careers/jobs-shaped link (`search jobs`/`view openings`/`open
  positions`/`careers`/etc., weighted, deterministic, first-occurrence tiebreak) → repeat. Resolves to
  exactly one of `VERIFIED` (known ATS found — `sourceType`/`atsBoardToken` set) / `GENERIC_SUPPORTED`
  (no known ATS, but a real careers/jobs page was reached — `discoveredJobsUrl` set for the generic
  scraper) / `UNRESOLVED` (nothing found within bounds) / `NEEDS_ADAPTER` (a recognized-but-unsupported
  ATS platform — see the small `UNSUPPORTED_ATS_SIGNATURES` list in `discovery.ts`, informational
  only, never scraped) / `FAILED_TEMPORARY` (the seed URL itself was unreachable for a transient
  reason — timeout/network/DNS — worth retrying later). **Never throws** and **never fabricates** an
  ATS/URL it didn't actually find. 9 tests against real local HTTP servers
  (`src/lib/ats/__tests__/discovery.test.ts`), plus live validation against 9 real external sites
  (§16.7).
- **`companies` resolution columns** (already existed from the prior session's migration, unused
  until now): `resolution_status`, `discovered_jobs_url`, `discovery_attempted_at`,
  `discovery_reason`, `suspected_ats`. Written by `recordDiscoveryResult`
  (`src/db/queries/companies.ts`, new) — on `VERIFIED` promotes the company to the real ATS connector;
  on `GENERIC_SUPPORTED` points `career_page_url` at the discovered jobs page; `UNRESOLVED`/
  `NEEDS_ADAPTER`/`FAILED_TEMPORARY` only update the diagnostic fields, never `source_type`/
  `ats_board_token`/`career_page_url` — an unresolved company is never silently downgraded.
  `career_page_url` always preserves the original seed URL regardless of outcome, which is what
  "Retry Discovery" re-runs discovery against.
- **`POST /api/companies`** (auto-detect path) now runs `discoverCompanySource` instead of the old
  single-hop function; the company is **always created** regardless of outcome — an unresolved source
  stays in the registry, never silently dropped, never creates a placeholder job.
  `POST /api/companies/[id]/discover` (new) is "Retry Discovery" — user-triggered only; normal scans
  reuse the stored resolution and never rediscover automatically.
- **Companies page**: a prominent "Unsupported / Unresolved Sources" section (new,
  `UnsupportedSourcesSection` in `src/app/companies/page.tsx`) lists every `UNRESOLVED`/
  `NEEDS_ADAPTER`/`FAILED_TEMPORARY` company with its reason, last-attempt timestamp, and a Retry
  Discovery button — separate from and above the main company table, per the explicit "should be easy
  to find, not buried" requirement. Every company row also shows a small resolution-status badge.

### 16.5 Generic Job Positive-Evidence Validation (built this session)

Root cause (confirmed): `genericPlaywright.ts`'s old fallback accepted any collected link whose text
didn't *exactly* match one of ~10 blocklisted nav words — real false positives observed in planning
included "Jobs By Business Area," "MyDisneyCareer," "French," "Privacy," "Benefits," "Locations,"
"Talent Network." A bigger blocklist can't fix an open-ended, company-specific set of navigation
labels.

- **`src/lib/ats/jobValidation.ts`** (new): `validateJobCandidate({url, text, contextText})` requires
  genuine positive evidence — a requisition-ID-shaped URL (`?gh_jid=`, `/jobs/…-12345`, a UUID
  segment, Workday-style `R1234`), or a title-shaped text plus a location signal (plus optionally an
  "Apply" action word nearby) — before accepting a candidate at all; an exact nav-phrase match is an
  always-disqualifying override. No positive evidence = rejected ("when uncertain, ingest nothing").
  Also exports `extractJsonLdJobPostings(html)` — the strongest possible signal: when a page publishes
  schema.org `JobPosting` structured data (common for SEO), it's used directly, title/url/location/
  datePosted/description and all, skipping anchor heuristics entirely. 18 unit tests
  (`src/lib/ats/__tests__/jobValidation.test.ts`), including every real false-positive example above,
  now proven rejected, plus 3 tests running a real headless Chromium against a local page
  (`src/lib/ats/__tests__/genericPlaywright.test.ts`).
- **`genericPlaywright.ts`** wiring: JSON-LD checked first (page-level, bypasses anchor heuristics
  entirely when present — also means a `postedAt` can now be real, not always null, when a site
  publishes `datePosted`; see §16.6's freshness note). The anchor-collection step now also captures
  each link's nearby container text (`contextText`) to give `jobValidation` real location/apply-action
  signals to work with. The non-ATS fallback path now filters through `validateJobCandidate` instead
  of the old exact-match blocklist. The majority-ATS-vote path (most links point at one embedded
  Greenhouse/Lever/Ashby board) is completely unchanged.

### 16.6 Freshness, Inline Actions, Posting-Date Regression (built this session)

- **Freshness** (`computeFreshnessTier`, unchanged, already existed): now displayed via a shared
  `src/components/FreshnessBadge.tsx` in **both** For You and All Jobs (`JobList.tsx`), computed
  client-side from `posted_at` — a separate concept from `jobLifecycle.ts`'s age-band "Fresh"
  highlight, which is untouched.
- **Inline Not Interested** (`src/components/NotInterestedToggle.tsx`, new): added to both Jobs list
  views — previously required opening the job detail page. Uses `candidate_job_state` exclusively via
  the existing route; reversible; never deletes the global job row. In For You, toggling it removes
  the row immediately (it would be excluded on the next fetch anyway); in All Jobs, the row stays
  (that view intentionally shows the full global inventory) and the toggle just reflects state. This
  required one additive SQL/type change: `listJobs`'s candidate overlay now also selects
  `candidate_job_state.not_interested` (previously omitted); `JobWithCompany.not_interested` is a new
  **optional** field (no legacy `jobs.*` counterpart), present only when a `candidateId` was supplied.
- **Posting-date connector regression tests** (`src/lib/ats/__tests__/connectorPostedAt.test.ts`, new):
  locks in the audited-but-previously-untested behavior — Ashby uses `publishedAt`, Lever uses
  `createdAt` (converted to ISO), Workday uses `startDate` only when the per-job detail fetch succeeds
  (null otherwise, proven via a forced 500), Greenhouse substitutes `updated_at` (documented as NOT a
  true posting date — unchanged), and generic never fabricates one (proven for the anchor-heuristic
  path; when a page's own JSON-LD provides a real `datePosted`, that real value is used — see §16.5).
  Ashby/Lever/Greenhouse gained a test-only `hostOverride` option (mirroring the option Workday's
  connector already had) so these could be tested against a real local HTTP server instead of the
  live ATS APIs — zero production behavior change (default `undefined` = the real host, exactly as
  before).

### 16.7 Live Validation (this session)

`discoverCompanySource` run against 9 real external sites (never written to `data/app.db` — pure,
read-only, no DB calls at all): direct Workday (HP) → `VERIFIED`; a branded HP jobs page → hopped to
a real jobs URL, `GENERIC_SUPPORTED` (its actual ATS, if any, is beyond the 2-hop bound — a known,
documented limit, not a bug); Greenhouse via both the legacy `boards.*` and new `job-boards.*` URL
shapes (Anthropic, Stripe) → both `VERIFIED`; Lever (Whoop) → `VERIFIED`; Ashby (Linear) → `VERIFIED`;
a generic careers page with no known ATS (Mozilla) → `GENERIC_SUPPORTED`; a real SmartRecruiters URL
(Bosch) → `NEEDS_ADAPTER` with `suspectedAts: "SmartRecruiters"`; a bot-defensive site (GM) →
degraded gracefully to `GENERIC_SUPPORTED`, no crash; a nonexistent domain → `FAILED_TEMPORARY` with
an honest DNS-failure reason. Additionally ran the real generic scraper against the live-discovered
HP jobs page: 17 genuine job postings extracted, zero navigation-clutter false positives.

### 16.8 Pre-Phase-3 Hardening Pass (this session)

A full repository-grounded audit (planning-only session, then a self-review/correction pass, then
this implementation) found the system architecturally sound but flagged one live security gap and
several smaller hardening items before Phase 3 should start consuming this data as a trusted source.

**P0 fixed — SSRF in the production scan path.** `src/lib/ats/genericPlaywright.ts` (the career_link
scraper run on every real scan) navigated a real headless browser to `company.career_page_url` with
no `isUrlSafeForNavigation` check and no `page.route` interception — unlike `discoveryBrowser.ts`
(Tier-3 discovery), which always had both. Fixed by porting the exact same seed-check +
per-request-interception pattern (never a second SSRF implementation). `POST /api/companies`'s
explicit-schema path also gained the same check as defense-in-depth at creation time. New tests:
loopback/scheme-rejection, in-page-navigation-blocked, and a legitimate-redirect-still-works case, in
`genericPlaywright.test.ts`.

**P1 hardening completed:**
- SQLite `busy_timeout = 5000` pragma (`src/db/index.ts`) — WAL mode allows one writer at a time;
  without this, a second concurrent writer got an immediate `SQLITE_BUSY` instead of a bounded wait.
- For You's STALE filter (`src/lib/rank/forYou.ts`) now exempts a candidate's own pinned/in-pipeline
  jobs, mirroring the exemption `jobLifecycle.ts` already gives archival — previously a candidate's
  pinned job older than 20 days silently vanished from their default For You view.
- `src/db/migrate.ts` now takes an automatic pre-migration backup (`data/backups/`, same naming
  convention as the 46+ manual snapshots already there) before applying schema changes — fail-open,
  never blocks a migration. A restore drill (backup → throwaway copy → integrity_check → row counts)
  was performed and confirmed clean; see the in-conversation implementation report for the exact
  commands (they're safe to re-run: `cp` a `.bak` file somewhere temporary, `sqlite3` against it).
- `POST /api/companies/[id]/discover` ("Retry Discovery") now has a 1-hour cooldown keyed off the
  existing `discovery_attempted_at` column — previously unlimited, unlike the batch discovery
  pipeline's own 24h `FAILED_TEMPORARY` cooldown.

**Observability added — derived only, no new schema beyond the fixes above.** `GET /api/ats-coverage`
+ `/ats-coverage` page: groups companies into Supported (by connector, with job counts + connector
health) / Needs Adapter (by suspected platform, so it's clear which one blocks the most companies) /
Generic / Unresolved — all computed at read time from existing `companies`/`jobs` columns
(`src/db/queries/atsCoverage.ts`). An earlier draft of this plan proposed 3-4 new tables/columns for
this (`unknown_ats_evidence`, `dedupe_tier`, `discovery_failure_category`, extra `discovery_runs`
counters); every one was found unnecessary on re-review — either derivable from existing columns
(dedupe tier from `dedupe_key`'s own string prefix, browser-fallback rate from
`discovery_reason LIKE '[Browser]%'`) or not yet justified by real data (zero genuinely-unknown ATS
platforms have been encountered at the current company count). Revisit only once a larger discovery
run actually produces evidence that would give such a table real shape.

**Scale-test finding (bounded, stopped as designed).** A real `npm run discover-employers -- --batch-size 10`
run against the live H1B employer table: 2 newly VERIFIED (Salesforce via SEC corroboration, Mphasis
via multi-signal), 1 clean `UNRESOLVED`, but 7/10 `FAILED_TEMPORARY` — an 80% combined
unresolved+failed rate, well past this plan's own 50% stop threshold. Root-caused (not a regression):
Wikidata's `wbsearchentities` returns zero matches for verbose DOL legal-entity names like
`"WAL-MART ASSOCIATES, INC."` or `"Amazon.com Services LLC"` (confirmed via a direct manual API
query), so resolution falls to the deliberately "dumb" generated-domain-candidate path
(`{words-joined}.com`), which guesses a domain that doesn't exist for these compound/subsidiary
names — a real, deterministic DNS failure, just currently bucketed under the same
`FAILED_TEMPORARY`/transient umbrella as an actual network blip. **Did not proceed to a 50-employer
run** per this plan's own gate. The correct remediation path already exists and needs no code change:
`h1b_employer_domain_overrides` (0 rows today) is exactly the curated-override mechanism for exactly
this case — populate it for large/well-known subsidiary-named employers as they're encountered,
rather than weakening the domain-candidate generator or the transient/permanent classification.

**Follow-up correction (same session, before commit): the classifier itself had a real bug, now
fixed.** `safeFetch.ts`'s DNS-lookup catch block bucketed BOTH genuinely transient resolver failures
(EAI_AGAIN, ETIMEDOUT) AND authoritative "no such host" results (ENOTFOUND/ENODATA — i.e. a wrongly-
generated candidate domain that simply doesn't exist) under one `dns_resolution_failed` reason,
which `discovery.ts`/`verifyDomain.ts` both treat as retryable. Added a new
`SafeFetchErrorReason` — `dns_hostname_not_found` — and a `classifyDnsLookupError` function
(exported, unit-tested against synthetic error codes) that separates the two; only the genuinely
hard case now resolves to `UNRESOLVED` instead of `FAILED_TEMPORARY`. Re-verified directly against
the same real failing employer names from the batch above (not a second live batch — the cooldown
would have picked different employers anyway): `Amazon.com Services LLC` and `HCL AMERICA INC` now
correctly resolve `UNRESOLVED` (their generated candidate domains genuinely don't exist);
`WAL-MART ASSOCIATES, INC.` still resolves `FAILED_TEMPORARY` on re-check — a *different*,
genuinely transient condition this run, correctly left alone. This asymmetric result (2 fixed, 1
unchanged) is the expected, honest signature of a precise fix, not a blanket reclassification.
Regression coverage: `safeFetch.test.ts` (classifier unit tests + one live `.invalid`-TLD NXDOMAIN
case), `discovery.test.ts`, `verifyDomain.test.ts` (both: hard-NXDOMAIN → `UNRESOLVED`, existing
transient-failure case unchanged → `FAILED_TEMPORARY`). `priority.ts`'s existing "UNRESOLVED is
excluded — no automatic retry" test already covers why this fix also prevents wasted retry cycles;
no separate priority-layer test was needed.

**Confirmed correct, no change made** (re-verified directly against source this session, not assumed):
H1B/company-identity data never reaches `src/lib/match/decision.ts`/`scoring.ts` (grepped — zero
references; the only coupling is a binary hard-blocker gate in `eligibility.ts`, exactly as intended);
`posted_at` is always source-derived from each connector's own field, never substituted with
`last_seen_at` or scan time; `job_match_results`' JSON columns round-trip symmetrically; `data/` stays
gitignored and was confirmed never committed; `master-files` API responses never include raw file
content, only manifest metadata; candidate isolation holds in every `job_match_results`/
`candidate_job_state`/`candidate_settings` query (all explicitly filter on `candidate_id`).

**Deferred, with reasoning (not silently dropped):** the H1B `normalizeEmployerName` fused-punctuation
edge case (~45/44,697 rows, e.g. `"Freyr,Inc."` → `"FREYRINC"` instead of `"FREYR"`) is documented as
a known-limitation test in `normalizeEmployerName.test.ts` rather than fixed — a real fix needs a full
re-normalization + re-match migration across all sponsor rows, out of scope for a hardening pass;
`h1b_employer_aliases` is the safer near-term lever for specific affected employers. Separating
`WIKIDATA_CONCURRENCY` from `HTTP_DISCOVERY_CONCURRENCY` (`src/lib/discovery/batch.ts`) was
investigated and found NOT simple to fix safely without restructuring the per-employer pipeline into
decoupled stages — the outer per-employer concurrency gate is the actual binding constraint today, so
a cosmetically-separate constant wouldn't change real throughput; left as a documented, honest
non-fix rather than a token change. `redirectConfirmed` in `verifyDomain.ts` remains defined-but-
unwired (its own module doc already discloses this) — useful eventually, not urgent.

---

## Current Safe Checkpoint

- **Branch**: `main`
- **Base commit**: `0a0c3ec` — "feat: add H1B employer source discovery + ATS Tier-3 browser
  fallback" (the last committed checkpoint; §16.4–§16.7 describe that feature's design record).
- **This document's own checkpoint claims had drifted behind that commit** (wrong base commit, wrong
  test count, wrong row counts, and the schema list below was missing entirely) until this update —
  a concrete example of why every claim here should be spot-checked against `git log`/`sqlite3` rather
  than trusted at face value, especially after a gap between sessions.
- **Pre-Phase-3 hardening pass (§16.8, this document's newest section) is uncommitted** as of this
  update — see `git status`/`git diff --stat` for the live file list. Awaiting explicit approval to
  commit.
- **Full test count**: 687 passing, 0 failing (`npm test`), lint clean, build clean (one non-blocking
  Turbopack tracing warning on `candidateProfile.ts`, unchanged from prior sessions).
- **DB** (`data/app.db`, live, gitignored): `PRAGMA integrity_check`: ok; `PRAGMA foreign_key_check`:
  no violations. Row counts as of this update: companies=13, jobs=5, candidates=1,
  h1b_sponsors=44,697, h1b_sponsor_filings=67,455, job_match_results=48, discovery_runs=2,
  employer_identity_resolutions=22, suppressed_jobs=29. (companies/discovery_runs/
  employer_identity_resolutions grew from the prior checkpoint because §16.8's hardening pass
  included a real, bounded 10-employer discovery batch used to validate the pipeline — see §16.8.
  `employer_identity_resolutions` grew by only 4, not 10 — its unique index on `h1b_sponsor_id`
  upserts rather than appends, and 6 of the 10 batch-selected employers already had a row from
  earlier sessions.)
- **Schema additions since the last documented checkpoint** (all present in current `schema.sql`,
  none were in this document before): `h1b_employer_domain_overrides`, `employer_identity_resolutions`,
  `discovery_runs`, and `companies.domain_identity_status`/`verified_domain`/`resolution_status`/
  `suspected_ats`/`discovered_jobs_url`/`discovery_reason`/`discovery_attempted_at` — all from the H1B
  source-discovery feature (§16.4 already describes the design; this checkpoint just lists the tables).
- **Git status**: `.claude/settings.local.json` remains the one pre-existing, harness-managed local
  file — not staged, not part of any feature work, per every prior session's convention.
