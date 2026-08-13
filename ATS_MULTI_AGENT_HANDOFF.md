# CareerOps ATS Discovery — Claude / Antigravity / Gemini Handoff

## Mission

Continue the completed 67,237-company ATS discovery foundation on branch
`codex/ats-job-discovery-50k`. The next agents should add missing ATS adapters, validate discovered
company boards, and prepare bounded U.S.-only production ingestion. Do not reseed the registry,
start a second discovery architecture, or replace the existing database/query/scan layers.

This file is tool-neutral. Claude, Antigravity, Gemini CLI, Codex, or another coding agent must use
the same implementation and safety contract.

## Required reading order

1. `AGENTS.md`
2. `ATS_MULTI_AGENT_HANDOFF.md`
3. `CLAUDE_ATS_CONTINUATION_RUNBOOK.md`
4. `CAREER_OPS_ATS_DISCOVERY_50K_CHECKPOINT.md`
5. `ATS_DISCOVERY_SOURCE_OF_TRUTH.md`
6. `CLAUDE_ATS_JOB_LOADING_PROMPT.md`
7. `data/exports/ats-source-of-truth/manifest.json`

The live SQLite database, code, tests, and latest verified export override historical counts in old
checkpoint paragraphs.

## Completed baseline — 2026-08-13

- Canonical organizations: **67,237**.
- Registry discovery checkpoints: **67,237 / 67,237 (100%)**.
- Domain outcomes: 3,915 verified; 8,372 ambiguous; 46,716 unresolved; 8,234 temporary.
- Organization source outcomes: 1,038 structured verified; 1,664 generic supported; 125 needs an
  adapter/review; 1,062 unresolved; 26 temporary; 63,322 had no source because no domain was
  verified.
- Implemented structured adapter types: **34**.
- Verified structured source rows: **1,076** across the 34 providers.
- Structured review state: **912 approved/scan-ready, 121 pending, 43 rejected**.
- Approved additive-only generic sources: **242**.
- Current non-archived jobs: **1,831**.
- Export manifest SHA-256: `e113ee860e92e46ccad50398ba3cda05504f29c6079759e5f374f16c58ab1bdd`.
- SQLite integrity: `ok`; foreign-key violations: `0`.
- Final gates: **864 tests passed, 0 failed**; lint passed; TypeScript passed; Next.js 16 webpack
  production build passed; source export verification passed.

The final queue-stall bug was fixed: never-attempted organizations now outrank one-day cooldown
retries, malformed third-party URLs become terminal unresolved evidence, URL/provider identity
collisions become explicit review checkpoints, and SQLite workers use a bounded 30-second busy wait
configured before WAL initialization. Do not undo these safeguards.

## What the implementation provides

- A deduplicated canonical organization registry backed by H-1B/LCA and PERM provenance.
- Organization aliases, domains, company compatibility links, and multiple job sources.
- Resumable HTTP discovery plus a separate bounded browser second pass.
- Strict ATS detection and 34 structured adapters.
- Independent company-specific connector validation with up to three evidence jobs.
- Global evidence-only validation fallback when a board has no U.S. jobs.
- A shared conservative `US | NON_US | UNKNOWN` production location gate.
- Approved structured scanning and additive-only generic scanning.
- Stable job identity, deduplication, lifecycle protection, H-1B intelligence, matching, and the
  existing CareerOps job-board pipeline.
- Continuous generic validation, connector health, browser discovery, and unsupported-ATS
  profiling workers.
- Auditable CSV/manifest exports under `data/exports/ats-source-of-truth/`.

## Backlogs are not interchangeable

1. **121 structured `PENDING` sources** already have adapters. Retry them according to validation
   cooldown/provider limits; do not build duplicate adapters for them. Many are empty boards,
   temporary failures, incomplete descriptions, or rate-limited sources.
2. **43 `REJECTED` structured sources** failed deterministic validation. Preserve their evidence;
   do not reapprove without a reviewed code/evidence change.
3. **125 `NEEDS_ADAPTER` organization outcomes** include genuinely unsupported ATS families,
   unsupported URL modes of existing adapters, and identity conflicts. They are not all new ATS
   products.
4. **14 known connector identity conflicts** must be reviewed without guessing or auto-merging
   organizations.

The centralized unsupported catalog currently contains 17 signatures. The measured first adapter
priority is:

1. SuccessFactors: 24 `SAP SuccessFactors` plus 2 `SuccessFactors` saved-source diagnostics.
2. Dayforce: 7 diagnostics. Its public endpoint returned HTTP 403 to server-side requests; approve
   only if a stable public contract is proven. A browser mode, if implemented, remains additive-only
   and cannot close jobs.
3. Phenom: 2 diagnostics.
4. Re-rank remaining families and unsupported modes from the live database and profiler export.

Paylocity, SmartRecruiters, iCIMS, Jobvite, Workable, Eightfold, ADP, Oracle, Cornerstone, and
Avature entries in `NEEDS_ADAPTER` are mostly unsupported URL/portal variants of adapters that
already exist. Extend only explicitly proven modes; do not create duplicate provider types.

## One-agent-at-a-time rule

Do not let Claude, Antigravity, Gemini, or Codex edit the same branch simultaneously. Assign one
adapter per branch and merge only after review. Suggested branches:

- `claude/ats-successfactors`
- `antigravity/ats-phenom`
- `gemini/ats-dayforce-research`

Before parallel branch work, create a reviewed baseline commit from
`codex/ats-job-discovery-50k`. The working tree currently contains the complete ATS development and
must not be casually overwritten. Preserve `.claude/settings.local.json`; never stage or commit it.
Never commit `data/**`, local SQLite/WAL files, exports, reports, logs, locks, backups, secrets, or
credentials.

## Adapter completion contract

Each agent implements one ATS family or one explicitly proven portal mode. It must provide:

- Strict hostname/path detection and canonical tenant/board identity.
- Complete, count-checked pagination and stable external job IDs.
- Listing/detail/canonical/apply identity validation and redirect safety.
- U.S. filtering before detail requests where listing locations allow it.
- Full descriptions and normalized fields without applicant/private data.
- Fail-closed behavior for count drift, duplicate IDs, incomplete pages, empty descriptions,
  rate limits, timeouts, provider errors, and identity conflicts.
- Focused tests and integration through `SourceType`, detection, normalization, validation,
  approved-source queries, and scan orchestration.
- Unsupported-catalog removal only for the exact proven modes.

Promotion is preview-first and backup-before-apply. Validation must use at most three genuine jobs
and insert zero production jobs:

```bash
npm run promote-supported-saved-sources -- --provider <provider>
npm run migrate
npm run promote-supported-saved-sources -- --provider <provider> --apply
npm run validate-pending-connectors -- \
  --provider <provider> --batch-size 100 --sample-size 3 --concurrency 1 --retry-pending-now
```

If no U.S. jobs exist, up to three genuine global jobs may prove mechanics only. They remain in
validation evidence and never enter `jobs`. Production loading remains U.S.-only.

Then use the bounded persistence canary:

```bash
npm run scan-ats-ready -- --sample-size 3
npm run export-ats-source
npm run verify-ats-source
```

Sample mode must keep closures, archives, and the global age sweep disabled.

## Required completion gates

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build -- --webpack
npm run export-ats-source
npm run verify-ats-source
```

Record adapter modes, promoted/approved/pending/rejected/conflicted sources, evidence type, backup,
test count, final counts, manifest hash, and exact next action in the checkpoint documents.

## Next project phase after adapters

Do not run all approved boards in one unbounded scan. First implement Stage 5 from the checkpoint:
paged source leasing, per-provider concurrency, adaptive scheduling, `next_scan_at`, retry/backoff,
circuit breakers, and listing/delta scans. Then execute the first full U.S.-only load in small
provider/source batches, measuring success, job yield, request volume, duplicates, exclusions, and
false closures before expansion.

Only a complete successful authoritative structured snapshot may close missing jobs. Generic and
browser sources remain additive-only forever unless they are promoted to a separately proven
structured adapter.

## First command for a fresh agent

After reading the required files, run the read-only live-state queries in
`CLAUDE_ATS_CONTINUATION_RUNBOOK.md`. Confirm the branch and working tree, then state which single
adapter or project slice you will own before editing anything.
