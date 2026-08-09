# Career-Ops Phase 2.5 (Multi-Candidate) — Checkpoint

Written for a fresh coding agent picking up this work with no memory of prior sessions. Read this
fully, then verify its claims against the actual repository — this document is a map, not a
substitute for reading the code. This is a **mid-phase checkpoint**, not a finished-phase handoff:
**Phase 2.5 is NOT complete.** Do not treat anything below as "done" beyond what §1 explicitly lists.

`CAREER_OPS_HANDOFF.md` is now stale with respect to Phase 2 and Phase 2.5 — it still describes the
Phase 1 + shared-AI-infra checkpoint (commit `c564291`) and says "Phase 2... not designed here."
Trust this document and the actual code for anything Phase 2/2.5-related; `CAREER_OPS_HANDOFF.md`
itself should only be updated once Phase 2.5 is genuinely complete (see §5's exact remaining list) —
do not update it prematurely.

---

## 1. What is actually complete (implemented, tested, live-verified)

This is the exhaustive list. If it's not named here, assume it is NOT done, even if a related file
was touched.

- **MatchCard / `JobMatchResult` persistence-contract fix.** `serializeResult()`
  (`src/db/queries/jobMatches.ts`) previously dropped `criticalGaps` and `eligibility.sponsorship`
  from every write, and the GET route never returned 4 of the identity/hash fields
  (`matchKnowledgeHash`/`candidateProfileHash`/`candidateSettingsHash`/`jdContentHash`) at all. Fixed
  with one canonical `deserializeJobMatchResult()` (the exact inverse of `serializeResult`), legacy-
  row fallbacks for rows written before the fix, and defensive `?? []`/`?.` guards throughout
  `MatchCard.tsx` as a second independent safety net. Round-trip regression test in
  `src/db/queries/__tests__/jobMatches.test.ts` asserts every field survives insert → deserialize.
- **Full Phase 2.5 schema** (`src/db/schema.sql` + migration functions in `src/db/index.ts`):
  `candidates`, `candidate_settings`, `candidate_job_state`, `candidate_job_state_history`, plus
  `candidate_id` added to `job_match_results`/`match_runs`, plus discovery-status columns added to
  `companies` (`resolution_status`, `discovered_jobs_url`, `discovery_attempted_at`,
  `discovery_reason`, `suspected_ats` — columns only; no discovery logic uses them yet, see §5).
  All additive, all migration-tested against a real copy of `data/app.db` before touching the live
  file. `candidates.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` (unlike `companies`/`jobs`) so it's
  never reused, safe to thread into file paths.
- **Candidate #1 migration.** The pre-existing singleton user is now `candidates.id = 1`,
  `display_name = "Sai Kishore Reddy"` (inferred from the `build-candidate-profile` skill's own
  prior description and the account email — not asked explicitly; correct via the candidate
  selector/settings if wrong). `data/master/**` was **copied** (never moved) to
  `data/candidates/1/master/**`, hash-verified byte-identical. The original `data/master/**` is
  **untouched** and still present — nothing reads from it anymore, but it was deliberately left in
  place as a fallback per the approved migration-safety plan. The one job with non-default legacy
  personal state (notes/tags) was backfilled into `candidate_job_state` for candidate 1.
- **Candidate-scoped master files/profile.** `src/lib/match/candidateProfile.ts`,
  `src/app/api/master-files/route.ts`, and `/master-files` page all take an explicit `candidateId` —
  no implicit "current candidate" fallback inside any of them. `.claude/skills/build-candidate-
  profile/SKILL.md` rewritten: invocation is now `/build-candidate-profile <candidate_id>`, with
  explicit resolve/reject-if-missing-or-archived and reject-if-files-missing-for-that-candidate
  logic, and an explicit "never fall back to another candidate's files" rule.
- **Candidate-scoped Phase 2 match cache.** `JobMatchResult` type, `serializeResult`/
  `deserializeJobMatchResult`, and every query function in `jobMatches.ts`
  (`getJobMatchResult`/`getLatestJobMatchResult`/`listJobMatchHistory`/
  `listLatestDecisionsForDedupeKeys`) now take `candidateId` explicitly. Both match API routes
  (`/api/jobs/[id]/match`, `/api/jobs/match/batch`) require `candidateId` (query param on GET, body
  field on POST) and validate it against an active candidate before doing anything.
- **`candidate_job_state` — the core behavioral fix.** New query module
  `src/db/queries/candidateJobState.ts`: `getCandidateJobState`, `setPipelineStatus`, `setPinned`,
  `setMarkedForTailoring`, `setNotesAndTags`, `setNotInterested`, `isProtectedForAnyCandidate`.
  - `PATCH /api/jobs/[id]` (pipeline status, pin, notes, tags, marked-for-tailoring) now requires
    `candidateId` and writes **only** to `candidate_job_state` — never to the legacy `jobs.*`
    columns. Frontend callers updated: `PipelineStatusSelect`, `JobList.tsx`'s tailoring checkbox,
    the job detail page's pin toggle and notes/tags card, the `/pipeline` kanban board.
  - `POST /api/jobs/[id]/not-interested` **no longer deletes the job or touches
    `suppressed_jobs`** — it only sets `candidate_job_state.not_interested` for the requesting
    candidate, reversibly. The job stays fully intact and visible to every other candidate. The OLD
    global semantics (`jobs.ts`'s `markNotInterested` — permanent delete + `suppressed_jobs`
    fingerprint, used by the system-generated age-sweep) are **completely untouched** and still
    exist for that purpose; this route just no longer calls them. Live-verified against the real DB:
    marking job 8 not-interested left `jobs` count at 5 and `suppressed_jobs` count at 29 (both
    unchanged), then reverted cleanly.
  - **Cross-candidate lifecycle protection.** `src/lib/jobLifecycle.ts`'s
    `isLifecycleProtected`/`canArchive`/`canDelete` pure functions and their actual protection RULE
    are **unchanged**. What changed is the *data source* their three call sites in
    `src/db/queries/jobs.ts` (`closeStaleJobs`, `archiveJob`, `runAgeBasedSweep`) read from: instead
    of the frozen `jobs.pipeline_status`/`jobs.pinned` columns, they now call
    `isProtectedForAnyCandidate(dedupeKey)`, which is true if **any** candidate has that job Applied/
    Interviewing/Offer/Employer Rejected/pinned. Regression-tested that single-candidate behavior is
    byte-identical to before this change.
  - `listJobs`/`getJob` (`src/db/queries/jobs.ts`) gained an **optional** `candidateId` parameter
    that LEFT JOINs `candidate_job_state` and overlays `pipeline_status`/`pinned`/
    `marked_for_tailoring`/`notes`/`tags` onto each row (and can filter `status`/`markedForTailoring`
    against the candidate-scoped values). Omitted = byte-identical to pre-Phase-2.5 behavior for
    every caller that doesn't pass it — this was verified by the existing test suite passing
    unmodified in behavior.
- **Candidate selector + onboarding.** `src/components/CandidateSelector.tsx` (dropdown in the root
  layout header, switches `settings.candidate_ui.active_candidate_id` — a UX default only, never a
  source of truth any API handler relies on internally), `/candidates/new` (name-only onboarding,
  redirects to `/master-files` to upload resume/skills). New query module
  `src/db/queries/candidates.ts`: `createCandidate`, `getCandidate`, `listCandidates`,
  `archiveCandidate`, `requireActiveCandidate`, `getActiveCandidateId`/`setActiveCandidateId`. New
  API routes `/api/candidates` (list/create), `/api/candidates/active` (get/set the UX default).
  **Live-verified**: created a real second candidate ("Java Dev"), confirmed it saw the same 5
  shared jobs with zero match/pipeline state (fully isolated from Candidate #1), then deleted the
  test candidate and restored Candidate #1 as active.
- **`candidate_settings` with an enforced match/ranking hash boundary.** New query module
  `src/db/queries/candidateSettings.ts`. `MatchAffectingCandidateSettings` (requiresSponsorship/
  usCitizen/workAuthorizedUS/clearanceLevel — feeds `computeCandidateSettingsHash`/
  `evaluateEligibility`, identical shape to today's `AppSettings["candidate"]`) is a distinct TS type
  from `CandidateRankingPreferences` (primaryTargetRole/secondaryTargetRoles/locationPreference/
  workplacePreference/employmentTypePreference — ranking-only). Regression-tested: changing a
  ranking preference leaves the Phase 2 cache hash byte-for-byte unchanged; changing a match-
  affecting field does invalidate it. **Not yet wired to a settings UI** — the fields exist and are
  read/write-tested at the query layer, but there's no page to edit them yet (see §5).
- **`src/lib/rank/forYou.ts` — deterministic ranking algorithm, built and tested, NOT wired to any
  UI or API route.** Implements the approved 10-key order exactly: valid/not-interested gate → role-
  family tier → decision rank (READY/NEEDS_REVIEW/NOT_EVALUATED/BLOCKED) → score band (±10 points,
  `SCORE_BAND_WIDTH`) → sponsorship tier (explicit-positive > silent-strong-history > silent-weaker >
  unknown > explicit-negative) → exact overall score → employer-evidenced share → requirement
  coverage → freshness tier (0–10d primary / 11–20d secondary / unknown / >20d stale, never
  substituting `first_seen_at`) → `posted_at` → job id. 11 tests in
  `src/lib/rank/__tests__/forYou.test.ts`, including every worked example from the approved plan
  (A vs B, C vs D, E vs F, G). **This module exists as a tested library only — nothing calls it yet.**
  There is no `/api/candidates/[id]/for-you` route and no Jobs-page "For You" toggle. `/jobs` still
  shows the unranked All Jobs view exclusively.

## 2. Verification performed this session

- `npm test`: **500/500 passing** (462 pre-existing + 38 new — persistence round-trip, schema
  migration, candidate CRUD, `candidate_job_state` isolation, settings hash-boundary, ranking
  algorithm)
- `npm run lint`: clean
- `npm run build`: clean (one non-blocking Turbopack informational warning about dynamic filesystem
  tracing scope in `candidateProfile.ts` — not an error, not investigated further)
- `PRAGMA integrity_check`: `ok`; `PRAGMA foreign_key_check`: no violations
- Row counts identical to the pre-migration baseline (`companies`=2, `jobs`=5,
  `h1b_sponsors`=44,697, `suppressed_jobs`=29, `job_match_results`=48, etc.) — zero data loss
- `data/master/*` vs `data/candidates/1/master/*`: byte-identical sha256
- Live browser/API verification against the real `data/app.db` (not a fixture): MatchCard on a
  legacy cached row, the pipeline-status write path landing in `candidate_job_state` while the
  legacy column stays frozen, Not Interested leaving `jobs`/`suppressed_jobs` counts unchanged, and
  full two-candidate isolation — all reverted cleanly afterward, no residual test data

## 3. Backups on disk

`data/backups/app.db{,-wal,-shm}.pre-multi-candidate-20260808-231301.bak` — taken before any live
migration this session. `data/master/**` (original, untouched) is itself also a complete fallback.

## 4. Explicit non-changes (frozen components verified untouched)

- Phase 1 (dedupe/lifecycle rules/H1B combine logic/Job Intelligence extractors) and Phase 2 scoring
  weights/thresholds/eligibility logic: unchanged. Confirmed by the full pre-existing test suite
  passing with unmodified assertions.
- `jobs.pipeline_status`/`pinned`/`notes`/`tags`/`marked_for_tailoring`/`tailoring_marked_at`/
  `pipeline_updated_at` columns: **still present**, not dropped, frozen as a read-only snapshot of
  Candidate #1's state at migration time.
- Global `suppressed_jobs` table and its system-generated (age-sweep) suppression semantics:
  completely unchanged.
- `.claude/skills/tailor-resume/**`: untouched. **Phase 3 has not been started.**

## 5. Exactly what remains (every deferred stage, by name)

- **Preference/settings UI** — `candidateSettings.ts` is built and tested but there's no page to
  edit sponsorship/citizenship/clearance/target-role preferences. Currently only reachable via
  direct DB/API calls.
- **ATS discovery — NOT implemented.** No `safeFetch` (SSRF-safe fetch helper), no bounded discovery
  chain (careers page → "Search Jobs" link → underlying ATS), no `discoveryConfig.ts` constants.
  `src/lib/ats/detect.ts` still has the exact single-shot-fetch limitation diagnosed in planning —
  a branded site that reveals its ATS only after a second hop is still invisible to it. The
  `companies.resolution_status` etc. columns exist but nothing writes anything except the one-time
  migration backfill (`VERIFIED` for companies that already had a working token/URL, `UNRESOLVED`
  otherwise).
- **Generic positive job validation — NOT implemented.** No `jobValidation.ts`. The generic
  Playwright scraper (`src/lib/ats/genericPlaywright.ts`) is unchanged from before this session —
  still only has the six-word exact-match nav-text blocklist, still has zero positive-evidence
  requirement. The "when uncertain, ingest nothing" rule is not yet enforced anywhere.
- **Unsupported-source registry UI — NOT implemented.** No Companies-page section listing
  `UNRESOLVED`/`NEEDS_ADAPTER`/`FAILED_TEMPORARY` sources, no "Retry Discovery" action.
- **Freshness integration — NOT wired.** `forYou.ts`'s `computeFreshnessTier` exists and is tested
  in isolation, but nothing in the live Jobs list/API currently uses it — freshness bands aren't
  shown or filtered on anywhere yet.
- **For You is not wired to any route or UI** (see §1's last bullet for exactly what exists vs.
  doesn't).
- **Inline Not Interested / pipeline actions on the Jobs list rows — NOT added.** Still requires
  opening a job's detail page; the list view has no inline controls for this yet.
- **Posting-date connector regression tests — NOT added as automated tests.** The per-connector
  audit (Greenhouse substitutes `updated_at` for a true posted date; Ashby/Lever/Workday have real
  posted-date fields that can be null; generic never has one) was done during planning and is
  documented, but no test file locks this behavior in yet.
- **Live 5–10 representative source validation — NOT run.** Would require adding real new companies
  and isn't safe/meaningful to do without the discovery work above.
- **Multi-candidate synthetic fixture suite (Data Engineer / Java / AI Engineer candidates from the
  approved plan) — NOT built as a repeatable test fixture.** Isolation was proven live/manually this
  session (see §2) but not captured as an automated `__tests__` file.
- **`CAREER_OPS_HANDOFF.md` update — deliberately not done.** Update it only once every item above
  is complete and green, per the approved instruction not to mark Phase 2.5 done prematurely.
- **Phase 3 (automatic resume generation) — not started, out of scope for this phase entirely.**

## 6. Where to start next session

Stage order (unchanged from the approved plan, picking up where this checkpoint left off):
1. Wire `forYou.ts` into a `/api/candidates/[candidateId]/for-you` route + a Jobs-page "For You" /
   "All Jobs" toggle — the algorithm itself needs no further work, only plumbing.
2. Build the candidate preferences/settings UI (target roles, sponsorship, etc.) — `candidateSettings.ts`
   is ready.
3. `safeFetch` + `discoveryConfig.ts` (bounded constants) — foundational for everything ATS-related.
4. Bounded discovery chain + `jobValidation.ts` — the two Disney-bug root causes from planning.
5. Unsupported-source UI, freshness display, inline Jobs-list actions.
6. Posting-date regression tests, live source validation, synthetic candidate fixture suite.
7. Full regression pass, then update `CAREER_OPS_HANDOFF.md`, then request final approval.

---

## Current Checkpoint

- **Branch**: `main`
- **This checkpoint's commit**: see the commit that introduces this file (`feat: add multi-candidate
  Career-Ops foundation`) — check `git log -1` for the exact hash, intentionally not hardcoded here
  to avoid a self-referential/stale value.
- **Full test count**: 500 passing, 0 failing (`npm test`)
- **Git status immediately after this commit**: clean except the pre-existing, unrelated
  `.claude/settings.local.json` (harness-managed local permission state, deliberately excluded from
  every commit in this project's history)
- **Phase 2.5 status: IN PROGRESS, NOT COMPLETE.** See §5 for the exact remaining work.
