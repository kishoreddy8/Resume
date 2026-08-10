# career-ops-project

A personal job-search pipeline: scans company ATS boards (Greenhouse/Ashby/Lever) and your own
manually-added career page links, tracks postings through a pipeline, flags likely H1B sponsors,
and hands off resume tailoring to a Claude Code or Codex project skill. Runs entirely locally — no
hosting, no external database, no LLM API key required for the app itself.

Inspired by [santifer/career-ops](https://github.com/santifer/career-ops).

## Setup

```bash
npm install
npx playwright install chromium
npm run migrate   # creates data/app.db and its tables
npm run dev        # http://localhost:3000
```

Requires Node 20+.

## Day-to-day workflow

1. **Add companies** on `/companies` — either a Greenhouse/Ashby/Lever board (token/slug only,
   found in the board's own URL, e.g. `boards.greenhouse.io/<token>`), or a plain company career
   page URL as a "career link" for companies without one of those three ATS platforms.
2. **Scan** — click "Scan now" on `/jobs`, or run `npm run scan` from the CLI. Career-link scrapes
   are best-effort (link/title only, no descriptions) and never auto-close or archive postings;
   ATS-backed companies get full descriptions, and postings that disappear from the board go
   through the [Job Lifecycle](#job-lifecycle-management) described below (closed, then eventually
   archived). If a career link turns out to be a themed wrapper around a Greenhouse/Lever/Ashby
   board (common), the scan detects it and leaves a note on the company suggesting you add it as a
   proper ATS entry for full descriptions.
3. **Filter and triage** on `/jobs` — by pipeline status, H1B signal, company, source, keyword
   search. Update pipeline status inline or from the `/pipeline` kanban board.
4. **H1B signal** — combines two sources: historical DOL H-1B LCA sponsorship data (see below) and
   live keyword scanning of posting text for explicit sponsorship language. A posting saying "no
   sponsorship" always overrides to `Unlikely` regardless of company history; "sponsorship
   available" overrides up to `Likely`. Otherwise it falls back to the company's historical signal.
5. **Upload your master files** on `/master-files` — Master Resume and Master Skills Inventory
   (`.docx`, `.md`, or `.txt`). Re-uploading archives the previous version instead of overwriting
   it; nothing here is ever touched programmatically outside this upload flow.
6. **Tailor a resume** — mark a job for tailoring (checkbox on `/jobs` or the job detail page),
   then run the matching repository skill with the explicit candidate and job identities:
   ```
   # Claude Code
   /tailor-resume candidate=<candidate-id> job=<job-id>

   # Codex
   $tailor-resume candidate=<candidate-id> job=<job-id>
   ```
   Both entry points read only that candidate's master files and the job's stored description,
   follow the same tailoring guardrails, and use the canonical engine in
   [`.claude/skills/tailor-resume/engine/`](.claude/skills/tailor-resume/engine/). Outputs are
   written under `data/generated/<company-slug>/<job-id>/`. The app itself does not run this
   tailoring workflow.

## H1B data ingestion (optional but recommended)

The H1B filter works without this step (every company just shows `Unknown` until matched), but for
real signal:

1. Download an H-1B LCA disclosure file from the DOL's public performance data page
   (dol.gov/agencies/eta/foreign-labor/performance, LCA Programs section) — it's a large file
   (tens to hundreds of MB), one per fiscal year. Convert to CSV if you only have `.xlsx`.
2. Ingest it:
   ```bash
   npm run ingest-h1b -- --file /path/to/LCA_Disclosure_Data_FY2024.csv --fiscal-year 2024
   ```
3. Match it against your companies:
   ```bash
   npm run match-h1b
   ```
   This also runs automatically for any single company right when you add it, if sponsor data has
   already been ingested.

Re-run `ingest-h1b` for additional fiscal years as you find them — sponsor counts accumulate
across runs.

## Job Lifecycle Management

Every job moves through three states, tracked automatically by scans and visible on the job detail
page's **Lifecycle** card:

| State | Meaning | Set when |
|---|---|---|
| **Active** (`is_active=1`, `is_archived=0`) | Currently listed on the company's board (or never scanned, e.g. career-link jobs). | Job is found in a scan's results. |
| **Closed** (`is_active=0`, `is_archived=0`) | Not found in the most recent scan of a live ATS board. Still shown in the normal jobs list. | The first scan that no longer sees the job's `dedupe_key`. |
| **Archived** (`is_archived=1`) | Closed for several scans in a row; hidden from the default `/jobs` view. Nothing is deleted — notes, tags, pipeline stage, and any generated resume files on disk all stay exactly as they were. | Missing for `ARCHIVE_AFTER_MISSED_SCANS` (default 3, override via that env var) **consecutive** scans. |

Rules:
- **Detection is per-scan, not per-job-count.** Each scan of a company compares the boards's current
  listings against what's stored; anything not seen this run is one step closer to archived.
- **Applied/Interview jobs are never auto-archived.** If a job's pipeline stage is `Applied` or
  `Interview` when it would otherwise be archived, it stays **Closed** indefinitely instead — the
  posting coming down doesn't mean you should lose track of an application in flight. The same
  guardrail (`canArchive()` in `src/lib/jobLifecycle.ts`) blocks the manual Archive button too, so
  it can't be bypassed from the UI either. Once you move the job off those two stages, the next scan
  archives it immediately using the miss count already accumulated.
- **Reappearing un-does both.** If a closed or archived job's `dedupe_key` shows up in a later scan
  (a posting was reopened, or a flaky fetch temporarily missed it), it's automatically reopened —
  or restored, if it had been archived — rather than creating a second row. This is also how
  "refresh instead of duplicate" holds generally: the unique index on `dedupe_key` means every
  upsert either updates the one existing row or inserts the first one, never both.
- **Notes, tags, pipeline stage, and marked-for-tailoring survive every rescan.** A scan's `UPDATE`
  only ever touches posting content (title, description, location, etc.) and lifecycle fields —
  it never overwrites `notes`, `tags`, `pipeline_status`, or `marked_for_tailoring`.
- **Restore** — the Archived Jobs page (`/jobs/archived`) or a job's own detail page has a Restore
  button for manual recovery at any time; it clears the archived/closed state and gives the job a
  fresh miss-count so it isn't immediately re-archived on the next scan.
- **Full history** — every lifecycle transition (Active/Closed/Archived) and every pipeline-status
  change is appended to `job_status_history` (never overwritten) and shown on the job detail page's
  History card, including the reason (e.g. "Not seen for 3 consecutive scans", "Manually archived").

### API

- `GET /api/jobs` — add `?archived=true` to see only archived jobs (the default excludes them).
- `POST /api/jobs/<id>/archive` — manual archive; `{"reason": "..."}` optional. Returns `409` with
  an explanatory message if the job is Applied/Interview.
- `POST /api/jobs/<id>/restore` — manual restore.
- `GET /api/jobs/<id>/history` — full audit trail for one job, newest first.
- `PATCH /api/jobs/<id>` — now also accepts `notes` (string or `null`) and `tags` (string array).

### Migration

Lifecycle columns (`missed_scan_count`, `is_archived`, `closed_at`, `archived_at`,
`archived_reason`, `notes`, `tags`) and the new `job_status_history` table are added automatically —
`npm run migrate` (or just starting the app/running a scan) applies the additive `ALTER TABLE`s in
`src/db/index.ts` to an existing `data/app.db`, the same way every prior schema change in this
project has been rolled out. No manual SQL, no data loss, no re-scan required.

## Project structure

- `src/app/` — dashboard pages and API routes (Next.js App Router)
- `src/lib/ats/` — Greenhouse/Ashby/Lever/Workday fetchers + the generic Playwright career-link scraper
- `src/lib/h1b/` — employer name normalization, fuzzy matching, keyword scanning, signal combining
- `src/lib/jobLifecycle.ts` — the archive threshold and the Applied/Interview archive guardrail
- `src/db/` — SQLite schema and query layer (`better-sqlite3`), including `job_status_history`
- `src/db/queries/__tests__/`, `src/lib/__tests__/` — `node:test` suites (`npm test`)
- `scripts/` — CLI entry points (`scan`, `ingest-h1b`, `match-h1b`)
- `data/` — gitignored: `app.db`, `candidates/<candidate-id>/master/` (candidate resume files), `generated/` (tailored output),
  `h1b/` (raw downloaded DOL files)
- `.claude/skills/` — Claude Code skill entry points and the temporarily canonical tailoring engine
- `.agents/skills/` — Codex repository-skill entry points

## Testing

```bash
npm test
```

Runs `node:test` suites against an isolated temp SQLite file (via the `CAREER_OPS_DB_PATH` env
override in `src/db/index.ts`) — never touches `data/app.db`. Covers the Job Lifecycle Management
rules above: dedupe/refresh-not-duplicate, close-then-archive timing, the Applied/Interview
guardrail, reopen/auto-restore on reappearance, notes/tags/pipeline-stage preservation across a
rescan, and the archived-jobs list filter. This is separate from the resume-tailoring engine's own
fixture suite (`npx tsx .claude/skills/tailor-resume/engine/fixtures/run-fixtures.ts`), which this
feature does not touch.

## Notes

- All scanning uses each ATS's public JSON API — no auth, no scraping needed for Greenhouse/Ashby/Lever.
- The generic career-link scraper is intentionally approximate; review what it finds.
- Nothing here auto-applies to anything or sends any message — it's a filter and tracker, you
  still do the applying.
