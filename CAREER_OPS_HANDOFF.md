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

**Phase 1 (deterministic pipeline) is complete, committed, and frozen.** Shared AI infrastructure
and the first optional AI feature (OpenAI-backed "Enrich with AI") are also complete and committed.
Nothing beyond this has been built. See §16 for the exact checkpoint.

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
npm test          # node:test, ~333 tests, isolated temp SQLite per suite (never touches data/app.db)
npm run lint       # eslint, must be clean
npm run build      # next build — this is also the real TypeScript check; npm test alone does not type-check as strictly
npx tsx .claude/skills/tailor-resume/engine/fixtures/run-fixtures.ts   # resume-engine regression fixtures
```

**DB migration safety procedure** (only needed if a change touches `schema.sql`/`db/index.ts`):
1. Back up `data/app.db` (+ `-wal`/`-shm`) to `data/backups/` — follow the existing naming
   convention `app.db.pre-<feature>-<timestamp>.bak` (see `data/backups/` for examples).
2. Copy to a throwaway location, run `CAREER_OPS_DB_PATH=<copy> npm run migrate`, verify table/row
   counts unchanged, `PRAGMA integrity_check`, `PRAGMA foreign_keys=ON; PRAGMA foreign_key_check`.
3. Only then run `npm run migrate` against the real `data/app.db`, and re-verify the same checks.

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

**Next major phase: Phase 2 — Candidate Profile + Job Match Scoring + Prioritization.**

High-level direction only (not designed here): build a candidate profile representation, then a
scoring/ranking layer that surfaces "which of today's jobs are most worth your time," likely reusing
the shared AI infrastructure from §6 for the reasoning-heavy parts (deterministic filters/rules
first, AI advisory ranking/explanation second — same "deterministic wins, AI is advisory" pattern
already established). Do not start designing or implementing this yet.

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

---

## Current Safe Checkpoint

- **Branch**: `main`
- **Latest commit**: `c5642915e86d587e6c4250368a18577c4837031f` — "feat: add optional AI job
  enrichment with OpenAI"
- **Git status**: clean except one pre-existing, unrelated local file:
  `M .claude/settings.local.json` (not part of any feature work; safe to leave as-is or let the
  user handle it)
- **Full test count**: 333 passing, 0 failing (`npm test`)
- **Unrelated local changes**: none beyond the settings file noted above — working tree otherwise
  matches `origin/main` at this commit
