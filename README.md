# career-ops-project

A personal job-search pipeline: scans company ATS boards (Greenhouse/Ashby/Lever) and your own
manually-added career page links, tracks postings through a pipeline, flags likely H1B sponsors,
and hands off resume tailoring to Claude Code via a project skill. Runs entirely locally — no
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
   are best-effort (link/title only, no descriptions) and never auto-close postings; ATS-backed
   companies get full descriptions and postings that disappear from the board get marked closed.
   If a career link turns out to be a themed wrapper around a Greenhouse/Lever/Ashby board (common),
   the scan detects it and leaves a note on the company suggesting you add it as a proper ATS entry
   for full descriptions.
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
   then in a Claude Code session in this project directory, run:
   ```
   /tailor-resume job=<job-id>
   ```
   This reads your master files and the job's stored description, follows the full tailoring
   instructions and guardrails in [`.claude/skills/tailor-resume/SKILL.md`](.claude/skills/tailor-resume/SKILL.md)
   exactly, and writes the tailored resume/cover letter to `data/generated/<job-id>/`. The app
   itself never calls an LLM — this step only happens inside Claude Code.

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

## Project structure

- `src/app/` — dashboard pages and API routes (Next.js App Router)
- `src/lib/ats/` — Greenhouse/Ashby/Lever fetchers + the generic Playwright career-link scraper
- `src/lib/h1b/` — employer name normalization, fuzzy matching, keyword scanning, signal combining
- `src/db/` — SQLite schema and query layer (`better-sqlite3`)
- `scripts/` — CLI entry points (`scan`, `ingest-h1b`, `match-h1b`)
- `data/` — gitignored: `app.db`, `master/` (your resume files), `generated/` (tailored output),
  `h1b/` (raw downloaded DOL files)
- `.claude/skills/tailor-resume/` — the resume tailoring skill and its guardrails

## Notes

- All scanning uses each ATS's public JSON API — no auth, no scraping needed for Greenhouse/Ashby/Lever.
- The generic career-link scraper is intentionally approximate; review what it finds.
- Nothing here auto-applies to anything or sends any message — it's a filter and tracker, you
  still do the applying.
