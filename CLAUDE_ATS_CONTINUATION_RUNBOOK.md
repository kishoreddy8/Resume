# Claude ATS Continuation Runbook

Use this file when resuming the CareerOps ATS discovery work in a fresh Claude session. The goal is
to continue from the durable local database and branch without reseeding companies, restarting
discovery, or treating historical counts in chat as current truth.

## Outcome

CareerOps now has a resumable 67,237-organization registry, multi-source ATS discovery, 34
structured ATS adapters, company-specific connector validation, U.S.-only ingestion gates,
generic-career-page validation, health checks, and portable source-of-truth exports. Continue this
system; do not replace it with a new crawler or a new company list.

The immediate objective is:

1. Allow registry-wide discovery to finish.
2. Record the final discovery/connector coverage.
3. Add remaining ATS adapters one at a time, prioritized by measured source coverage.
4. Prove each adapter with at most three genuine jobs before approving any company source.
5. Keep production persistence U.S.-only.
6. Prepare bounded first-load batches; never enable an unbounded all-source scan.

## Read first

Read these files completely before changing code:

1. `AGENTS.md`
2. `CLAUDE_ATS_CONTINUATION_RUNBOOK.md`
3. `CAREER_OPS_ATS_DISCOVERY_50K_CHECKPOINT.md`
4. `ATS_DISCOVERY_SOURCE_OF_TRUTH.md`
5. `CLAUDE_ATS_JOB_LOADING_PROMPT.md`
6. `data/exports/ats-source-of-truth/manifest.json`

Code, tests, the live SQLite database, and the latest verified export take precedence over old
checkpoint prose. Work only on branch `codex/ats-job-discovery-50k`. Preserve unrelated changes,
especially `.claude/settings.local.json`, and never stage or commit `data/**`.

## Step 1: establish live truth

Run these read-only commands first:

```bash
git branch --show-current
git status --short
git log -5 --oneline

sqlite3 -header -column data/app.db "
SELECT COUNT(*) AS organizations FROM organizations;
SELECT COUNT(*) AS searched,
       67237-COUNT(*) AS discovery_remaining,
       MAX(attempted_at) AS latest_saved
FROM organization_discovery_state;
SELECT provider, review_status, COUNT(*) AS sources
FROM job_sources
WHERE provider <> 'career_link' AND resolution_status='VERIFIED'
GROUP BY provider, review_status
ORDER BY provider, review_status;
SELECT suspected_ats, COUNT(*) AS sources
FROM job_sources
WHERE resolution_status='NEEDS_ADAPTER'
GROUP BY suspected_ats
ORDER BY sources DESC;
"
```

Check the five local workers rather than assuming a lock file means a process is alive:

```bash
launchctl print gui/$(id -u)/com.careerops.ats-discovery | grep -E 'state =|pid =|last exit code'
launchctl print gui/$(id -u)/com.careerops.ats-browser-discovery | grep -E 'state =|pid =|last exit code'
launchctl print gui/$(id -u)/com.careerops.generic-source-validation | grep -E 'state =|pid =|last exit code'
launchctl print gui/$(id -u)/com.careerops.ats-adapter-profiler | grep -E 'state =|pid =|last exit code'
launchctl print gui/$(id -u)/com.careerops.connector-health | grep -E 'state =|pid =|last exit code'
```

Read the latest logs under `data/logs/`. Intermittent `SQLITE_BUSY` messages can occur while the
five workers share SQLite; confirm that timestamps and database checkpoints continue advancing.
Do not start duplicate manual workers while the corresponding live lock owner is running.

Discovery is complete only when `searched=67237` and `discovery_remaining=0`. Do not equate a
searched organization with a verified domain, connector, hiring company, or active job.

## Step 2: freeze and verify the completed discovery checkpoint

After discovery reaches zero remaining, generate a fresh portable snapshot:

```bash
npm run export-ats-source
npm run verify-ats-source
```

Require:

- SQLite integrity `ok` and zero foreign-key violations.
- Exactly 67,237 canonical organizations unless a reviewed later import intentionally changed it.
- Hashes for every exported CSV.
- Counts separated into searched organizations, verified domains, structured sources, approved
  sources, generic additive-ready sources, active hiring sources, and current jobs.

Update `CAREER_OPS_ATS_DISCOVERY_50K_CHECKPOINT.md` with the timestamped final counts. Never edit an
exported CSV as a way to change the database.

## Step 3: distinguish three different backlogs

Do not call all pending rows “missing connectors.” They are separate queues:

1. `VERIFIED + PENDING`: an implemented adapter exists, but this company board is empty,
   temporarily unavailable, rate-limited, incomplete, or awaiting bounded validation.
2. `NEEDS_ADAPTER`: the saved URL is recognized but no safe supported mode was proven, or the URL
   lacks enough tenant/board identity.
3. `connector_identity_conflict`: competing identities exist and require evidence-based review;
   never auto-merge or guess.

The initial next-adapter priority is based on measured live coverage:

1. SAP SuccessFactors / SuccessFactors.
2. Dayforce, but the current public search experiment returned HTTP 403 to server-side requests;
   do not approve it unless a stable public contract is proven. A browser-only additive mode may be
   considered separately and must never close missing jobs.
3. Phenom.
4. Re-rank all other unsupported families from the final live database and profiler export.

Use `data/exports/ats-source-of-truth/ats_adapter_profile_runs.csv` and
`data/adapter-profiler-reports/latest.json` as endpoint research evidence only. Profiler evidence
cannot approve a connector.

## Step 4: adapter implementation contract

Implement one ATS family or one explicitly proven portal mode per reviewable slice. Follow a recent
hardened adapter such as Cornerstone, Eightfold, or Avature rather than building a permissive HTML
scraper.

Every new adapter must include:

- A strict `SourceType` addition in `src/types/index.ts`.
- Exact hostname/path detection and canonical source identity in `src/lib/ats/detect.ts`.
- A provider module under `src/lib/ats/` with stable job IDs and complete pagination.
- Integration through `src/lib/normalize.ts` and the approved-source query path.
- Tenant, board, job-detail, canonical URL, and redirect identity checks.
- Count/pagination drift, duplicate ID, incomplete page, empty description, timeout, `429`, and
  provider failure handling that fails closed.
- Listing-first U.S. filtering before expensive details whenever the provider exposes locations in
  its listing response.
- `US | NON_US | UNKNOWN` handling through the shared location policy. Bare `Remote` is not U.S.
  evidence.
- Full descriptions and useful structured fields without collecting applicant/private data.
- Focused detector, pagination, identity, failure, location, and normalization tests.
- An update to the unsupported catalog only for URL modes that are genuinely supported. Keep
  unproven layouts as `NEEDS_ADAPTER`.

Do not infer a connector from a vendor marketing page, JavaScript asset, apply-only URL,
talent-community page, or a single successful detail request.

## Step 5: promotion and three-job proof

Preview saved-source promotion first. Apply only conflict-free identities after a fresh database
backup. Prefer the connector-scoped promotion framework when it supports the new provider:

```bash
npm run promote-supported-saved-sources -- --provider <provider>
# Review every proposed row and conflict.
npm run migrate
npm run promote-supported-saved-sources -- --provider <provider> --apply
```

If the provider needs a custom resolver, keep it preview-by-default and require explicit `--apply`.
Never overwrite an existing provider/source identity conflict.

Validate the promoted sources without loading jobs:

```bash
npm run validate-pending-connectors -- \
  --provider <provider> \
  --batch-size 100 \
  --sample-size 3 \
  --concurrency 1 \
  --retry-pending-now
```

Approval requires up to three genuine explicit-U.S. samples when available. If the board has no
U.S. opening, up to three genuine global samples may prove connector mechanics, but those samples
remain only in validation evidence and are never inserted into `jobs`. Empty, rate-limited,
incomplete, or transient boards remain `PENDING`; deterministic identity/configuration failures are
`REJECTED`. Validation itself must insert zero production jobs.

Then run a bounded persistence canary:

```bash
npm run scan-ats-ready -- --sample-size 3
npm run export-ats-source
npm run verify-ats-source
```

Sample mode must keep closures, archives, and the global age sweep disabled. Confirm that every
inserted job passes the production U.S. location gate.

## Step 6: required quality gates per adapter

Run focused tests while developing and all gates before calling an adapter complete:

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build -- --webpack
npm run export-ats-source
npm run verify-ats-source
```

Update both the checkpoint and source-of-truth documentation with:

- Adapter number and supported public modes.
- Exact source identities promoted, approved, pending, rejected, and conflicted.
- Three-job evidence and whether it was U.S. or evidence-only global fallback.
- Pagination/count/detail/identity guarantees.
- Confirmation that connector validation inserted zero jobs.
- Backup filename, test count, export counts, and manifest hash.
- Exact next adapter family.

Commit only the reviewed implementation and documentation. Never include local exports, reports,
logs, locks, SQLite files, backups, credentials, or `.claude/settings.local.json`.

## Step 7: how this feeds the rest of CareerOps

The discovery system is upstream infrastructure for the normal CareerOps scan:

```text
67,237 organizations
  -> verified company domains
  -> discovered ATS/career sources
  -> strict adapter + company-specific validation
  -> approved scan-ready sources
  -> U.S.-only normalized jobs
  -> existing dedupe/lifecycle/H1B/matching/job-board features
```

Reuse the existing organization IDs, company compatibility links, provider tokens, validation
evidence, normalized job schema, dedupe keys, and scan lifecycle. Do not create a second job table
or bypass `fetchJobsForCompany`/the scan query layer.

For the first full load after adapters are complete:

- Add paged source leasing and bounded per-provider batches first.
- Respect provider concurrency, rate limits, retry/backoff, and circuit breakers.
- Load only active, verified, review-approved structured sources.
- Persist only U.S.-scoped jobs; keep `UNKNOWN` out of production pending review.
- Permit closures only after a complete successful authoritative snapshot.
- Generic/browser sources remain additive-only and can never close missing jobs.
- Measure source success, request volume, job yield, duplicates, location exclusions, and false
  closures before expanding from small batches to the full approved set.

Do not run every approved company in one unbounded scan. The registry is large, but only validated
active sources belong in the job-loading queue.

## Completed discovery checkpoint for the next session

Registry-wide discovery completed on 2026-08-13:

- Organizations and durable discovery states: 67,237 / 67,237.
- Implemented structured adapter types: 34.
- Verified structured source rows: 1,076.
- Structured review state: 912 approved, 121 pending, 43 rejected.
- Approved additive generic sources: 242.
- Current non-archived jobs: 1,831.
- Database integrity: `ok`; zero foreign-key violations.
- Final verified manifest: `e113ee860e92e46ccad50398ba3cda05504f29c6079759e5f374f16c58ab1bdd`.
- Final gates: 864 tests, lint, TypeScript, webpack production build, export and verification all
  passed.

Read `ATS_MULTI_AGENT_HANDOFF.md` for the tool-neutral Claude/Antigravity/Gemini assignment model,
final backlog distinctions, and exact next phase. Still query the live database first because
validation and health workers can legitimately change review/evidence counts after this checkpoint.
